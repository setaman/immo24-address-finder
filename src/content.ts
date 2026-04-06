import { decodeAddress } from '@immo24/decoder';
import { extractMetadata, parseIS24FromScripts } from '@immo24/metadata';
import type { ExposeMetadata } from '@immo24/metadata';
import type { Address, AddressConfidence, Settings, ToggleOverlayMessage } from './types.js';
import { extractPageMetadata } from './strategies/metadata-extraction.js';
import { refineCoordinates } from './strategies/refinement-pipeline.js';
import { trackPrice, formatPriceLine } from './services/price-tracker.js';
import type { PriceComparison } from './services/price-tracker.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const API: any = (typeof browser !== 'undefined') ? (browser as any) : chrome;

// Constants
const MUTATION_OBSERVER_DELAY = 300;
const URL_CHECK_INTERVAL = 500;
const FEEDBACK_MESSAGE_DURATION = 1500;
const RETRY_BACKOFF = [0, 500, 1000, 2000, 4000];
const MAX_RETRIES = RETRY_BACKOFF.length;

// Coordinate bounds for Germany
const COORD_LAT_MIN = 47.0;
const COORD_LAT_MAX = 55.5;
const COORD_LNG_MIN = 5.5;
const COORD_LNG_MAX = 15.5;

// Diagnostic info collected during decoding
interface DecodeDiagnostics {
  scriptsScanned: number;
  encodedDataFound: boolean;
  rawPreview: string | null;
  decodeSuccess: boolean;
  fieldsPopulated: string[];
  coordinatesFound: boolean;
  errorReason: 'no-data' | 'decode-failed' | 'empty-address' | null;
}

interface DecodeResult {
  address: Address | null;
  diagnostics: DecodeDiagnostics;
}

// Refinement logging
const LOG_PREFIX = '%c[IS24 Decoder]';
const LOG_STYLE = 'color: #3b82f6; font-weight: bold';
const LOG_DIM = 'color: #9ca3af';
const LOG_SUCCESS = 'color: #22c55e; font-weight: bold';
const LOG_WARN = 'color: #f59e0b; font-weight: bold';

(async function () {
  const DEFAULTS: Settings = {
    mapProvider: 'google',
    autoCopy: false,
    showEarth: true,
    showDates: true,
    position: 'bottom-right',
    theme: 'dark',
    localeOverride: 'auto'
  };

  function getSettings(): Promise<Settings> {
    return new Promise(resolve => {
      try {
        API.storage.sync.get(DEFAULTS, (items: Partial<Settings>) => resolve({ ...DEFAULTS, ...items }));
      } catch {
        resolve(DEFAULTS);
      }
    });
  }

  async function loadLocaleBundle(locale: string): Promise<Record<string, string> | null> {
    try {
      const response = await API.runtime.sendMessage({
        type: 'getLocaleData',
        locale: locale
      });

      if (response && response.data) {
        return response.data;
      }

      return null;
    } catch (e) {
      console.error('[ImmoScout24 Decoder] Failed to load locale bundle:', e);
      return null;
    }
  }

  const settings = await getSettings();

  let t = (k: string) => (API?.i18n?.getMessage ? API.i18n.getMessage(k) : k);

  if (settings.localeOverride && settings.localeOverride !== 'auto') {
    const bundle = await loadLocaleBundle(settings.localeOverride);
    if (bundle) {
      t = (k: string) => (k in bundle ? bundle[k] : k);
    }
  }

  // --- Data extraction ---

  function extractEncodedFromScripts(): { encoded: string | null; scriptsScanned: number } {
    const re = /"obj_telekomInternetUrlAddition"\s*:\s*"([^"]+)"/g;
    const scripts = Array.from(document.scripts);
    const scriptsScanned = scripts.length;

    for (const s of scripts) {
      const txt = s.textContent || '';
      let m: RegExpExecArray | null;
      while ((m = re.exec(txt)) !== null) {
        if (m[1]) return { encoded: m[1], scriptsScanned };
      }
    }
    const html = document.documentElement.innerHTML;
    const m2 = html.match(/"obj_telekomInternetUrlAddition"\s*:\s*"([^"]+)"/);
    return { encoded: m2 ? m2[1] : null, scriptsScanned };
  }

  function extractIs24Object(): unknown {
    return parseIS24FromScripts(document);
  }

  // --- Coordinate extraction fallback ---

  function isValidCoordinate(lat: number, lng: number): boolean {
    if (isNaN(lat) || isNaN(lng)) return false;
    if (lat < COORD_LAT_MIN || lat > COORD_LAT_MAX) return false;
    if (lng < COORD_LNG_MIN || lng > COORD_LNG_MAX) return false;

    const latStr = String(lat);
    const lngStr = String(lng);
    const latDecimals = latStr.includes('.') ? latStr.split('.')[1].length : 0;
    const lngDecimals = lngStr.includes('.') ? lngStr.split('.')[1].length : 0;
    if (latDecimals < 3 || lngDecimals < 3) return false;

    return true;
  }

  function buildCoordinateAddress(lat: number, lng: number): Address {
    return { street: '', houseNumber: '', postalCode: '', city: '', district: '', lat, lng, confidence: 'low', source: 'approximate-coordinates' };
  }

  function extractCoordinatesFromPerformanceAPI(): Address | null {
    try {
      const entries = performance.getEntriesByType('resource');
      const re = /\/latitude\/([\d.]+)\/longitude\/([\d.]+)/;
      for (const entry of entries) {
        const match = (entry as PerformanceResourceTiming).name.match(re);
        if (match) {
          const lat = parseFloat(match[1]);
          const lng = parseFloat(match[2]);
          if (isValidCoordinate(lat, lng)) return buildCoordinateAddress(lat, lng);
        }
      }
    } catch {
      // Performance API may not be available
    }
    return null;
  }

  function extractCoordinatesFromScripts(): Address | null {
    const scripts = Array.from(document.scripts);
    const patterns: RegExp[] = [
      /"latitude"\s*:\s*([\d.]+)\s*,\s*"longitude"\s*:\s*([\d.]+)/,
      /"lat"\s*:\s*([\d.]+)\s*,\s*"lng"\s*:\s*([\d.]+)/,
      /\/latitude\/([\d.]+)\/longitude\/([\d.]+)/,
    ];

    for (const script of scripts) {
      const txt = script.textContent || '';
      if (!txt) continue;
      for (const re of patterns) {
        const match = txt.match(re);
        if (match) {
          const lat = parseFloat(match[1]);
          const lng = parseFloat(match[2]);
          if (isValidCoordinate(lat, lng)) return buildCoordinateAddress(lat, lng);
        }
      }
    }
    return null;
  }

  function extractCoordinates(): Address | null {
    const fromPerf = extractCoordinatesFromPerformanceAPI();
    if (fromPerf) return fromPerf;
    return extractCoordinatesFromScripts();
  }

  // --- Decode pipeline ---

  function runDecode(): DecodeResult {
    const diagnostics: DecodeDiagnostics = {
      scriptsScanned: 0,
      encodedDataFound: false,
      rawPreview: null,
      decodeSuccess: false,
      fieldsPopulated: [],
      coordinatesFound: false,
      errorReason: null
    };

    const { encoded, scriptsScanned } = extractEncodedFromScripts();
    diagnostics.scriptsScanned = scriptsScanned;

    if (encoded) {
      diagnostics.encodedDataFound = true;
      diagnostics.rawPreview = encoded.length > 120 ? encoded.slice(0, 120) + '\u2026' : encoded;

      const baseAddress = decodeAddress(encoded);
      if (baseAddress) {
        diagnostics.decodeSuccess = true;

        const address: Address = {
          ...baseAddress,
          confidence: 'exact' as AddressConfidence,
          source: 'telekom-decode',
        };

        const populated = Object.entries(address)
          .filter(([, v]) => typeof v === 'string' && v.length > 0)
          .map(([k]) => k);
        diagnostics.fieldsPopulated = populated;

        if (populated.length > 0) {
          return { address, diagnostics };
        }
      }
    }

    // Fallback: coordinate extraction
    const coordAddress = extractCoordinates();

    if (coordAddress) {
      diagnostics.coordinatesFound = true;
      diagnostics.fieldsPopulated = ['lat', 'lng'];
      diagnostics.errorReason = null;
      return { address: coordAddress, diagnostics };
    }

    // Everything failed
    if (!encoded) {
      diagnostics.errorReason = 'no-data';
    } else if (!diagnostics.decodeSuccess) {
      diagnostics.errorReason = 'decode-failed';
    } else {
      diagnostics.errorReason = 'empty-address';
    }

    return { address: null, diagnostics };
  }

  // --- Refinement pipeline ---

  async function triggerRefinement(approxAddress: Address) {
    try {
      console.group(`${LOG_PREFIX} %cRefinement Pipeline`, LOG_STYLE, 'color: #8b5cf6; font-weight: bold');
      console.log(`${LOG_PREFIX} %cStarting refinement for approximate coords: %c${approxAddress.lat?.toFixed(5)}, ${approxAddress.lng?.toFixed(5)}`,
        LOG_STYLE, '', LOG_DIM);

      const metadata = extractPageMetadata();

      console.log(`${LOG_PREFIX} %cPage metadata extracted:`, LOG_STYLE, '');
      console.table({
        'ZIP': metadata.zip || '(none)',
        'City': metadata.city || '(none)',
        'Quarter': metadata.quarter || '(none)',
        'GeoCode ID': metadata.geoCode || '(none)',
        'Full Address Visible': metadata.showFullAddress ? 'Yes' : 'No',
        'Has Quarter Bounds': metadata.quarterBounds ? 'Yes' : 'No',
        'Title': metadata.title ? metadata.title.substring(0, 80) + (metadata.title.length > 80 ? '...' : '') : '(none)',
        'Location Text': metadata.locationText ? metadata.locationText.substring(0, 80) + '...' : '(none)',
      });

      if (metadata.quarterBounds) {
        console.log(`${LOG_PREFIX} %cQuarter bounds: %c(${metadata.quarterBounds.southWest.lat.toFixed(4)}, ${metadata.quarterBounds.southWest.lng.toFixed(4)}) \u2192 (${metadata.quarterBounds.northEast.lat.toFixed(4)}, ${metadata.quarterBounds.northEast.lng.toFixed(4)})`,
          LOG_STYLE, '', LOG_DIM);
      }

      const result = await refineCoordinates(approxAddress, metadata);

      if (result.confidence !== 'low') {
        console.log(`${LOG_PREFIX} %c\u2713 Refinement successful!`, LOG_STYLE, LOG_SUCCESS);
        console.log(`${LOG_PREFIX} %cConfidence: %c${result.confidence.toUpperCase()} %c| Source: %c${result.source}`,
          LOG_STYLE, '', `color: ${result.confidence === 'high' ? '#3b82f6' : '#f59e0b'}; font-weight: bold`, '', LOG_DIM);
        console.log(`${LOG_PREFIX} %cRefined address: %c${[result.address.street, result.address.houseNumber].filter(Boolean).join(' ') || '(no street)'}, ${result.address.postalCode} ${result.address.city} (${result.address.district || 'n/a'})`,
          LOG_STYLE, '', 'color: #22c55e');
        console.log(`${LOG_PREFIX} %cRefined coords: %c${result.address.lat?.toFixed(5)}, ${result.address.lng?.toFixed(5)}`,
          LOG_STYLE, '', LOG_DIM);
      } else {
        console.log(`${LOG_PREFIX} %c\u26A0 Refinement did not improve precision`, LOG_STYLE, LOG_WARN);
        console.log(`${LOG_PREFIX} %cKeeping approximate coordinates`, LOG_STYLE, LOG_DIM);
      }
      console.groupEnd();

      if (result.confidence !== 'low' && overlayState !== 'dismissed') {
        // Extract metadata for dates + price display on the refined overlay
        const is24 = extractIs24Object();
        const exposeMetadata = is24 ? extractMetadata(is24) : undefined;
        let refinedPrice: PriceComparison | null = null;
        if (exposeMetadata?.exposeId && exposeMetadata.price?.amount) {
          try {
            refinedPrice = await trackPrice(
              exposeMetadata.exposeId,
              exposeMetadata.price.amount,
              exposeMetadata.price.pricePerSqm,
              exposeMetadata.price.type,
            );
          } catch { /* non-critical */ }
        }
        createSuccessOverlay(result.address, exposeMetadata, refinedPrice);

        if (settings.autoCopy) {
          const a = result.address;
          const hasText = !!(a.street || a.houseNumber || a.postalCode || a.city);
          const copyText = hasText
            ? [a.street, a.houseNumber, a.postalCode, a.city].filter(Boolean).join(' ')
            : `${a.lat!.toFixed(5)}, ${a.lng!.toFixed(5)}`;
          if (copyText) copyToClipboard(copyText);
        }
      }
    } catch (e) {
      console.groupEnd();
      console.error(`${LOG_PREFIX} %c\u2717 Refinement failed:`, LOG_STYLE, 'color: #ef4444', e);
    }
  }

  // --- Clipboard ---

  async function copyToClipboard(text: string): Promise<boolean> {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        // Fall through to legacy method
      }
    }

    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.readOnly = true;
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      ta.style.opacity = '0';

      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);

      return ok;
    } catch {
      return false;
    }
  }

  // --- Overlay state ---

  let overlayEl: HTMLDivElement | null = null;
  let overlayState: 'hidden' | 'visible' | 'dismissed' = 'hidden';
  let decoderRunning = false;
  let lastDecodeSuccess = false;

  // --- Overlay styles ---

  function overlayBaseStyle(theme: Settings['theme'], position: Settings['position']) {
    const palette = (theme === 'light')
      ? { bg: '#ffffff', fg: '#111827', border: 'rgba(0,0,0,.1)', shadow: 'rgba(0,0,0,.15)' }
      : { bg: '#111827', fg: '#ffffff', border: 'rgba(255,255,255,.08)', shadow: 'rgba(0,0,0,.25)' };
    const insetMap: Record<string, string> = {
      'bottom-right': 'inset: auto 16px 16px auto;',
      'bottom-left': 'inset: auto auto 16px 16px;',
      'top-right': 'inset: 16px 16px auto auto;',
      'top-left': 'inset: 16px auto auto 16px;'
    };
    return `
      position: fixed; ${insetMap[position] || insetMap['bottom-right']} z-index: 2147483647;
      background: ${palette.bg}; color: ${palette.fg}; font: 13px/1.35 system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,sans-serif;
      border-radius: 12px; box-shadow: 0 8px 24px ${palette.shadow}; padding: 12px 14px; min-width: 280px; max-width: 360px;
      border: 1px solid ${palette.border}; display: none;
    `;
  }

  function buttonStyle(theme: Settings['theme']) {
    const primaryBg = '#2563eb';
    return `
      appearance: none; border: 0; border-radius: 10px; padding: 8px 10px; cursor: pointer;
      background: ${primaryBg}; color: #fff; font-weight: 600;
    `;
  }

  function ghostStyle(theme: Settings['theme']) {
    const border = (theme === 'light') ? 'rgba(17,24,39,.2)' : 'rgba(255,255,255,.2)';
    const text = (theme === 'light') ? '#111827' : '#fff';
    return `
      appearance: none; border: 1px solid ${border}; border-radius: 10px; padding: 8px 10px; cursor: pointer;
      background: transparent; color: ${text}; font-weight: 600;
    `;
  }

  function earthCornerStyle(theme: Settings['theme']) {
    const border = (theme === 'light') ? 'rgba(17,24,39,.2)' : 'rgba(255,255,255,.2)';
    return `
      position: absolute; top: 6px; right: 8px; width: 24px; height: 24px;
      border: 1px solid ${border}; border-radius: 6px; background: transparent;
      font-size: 14px; line-height: 1; cursor: pointer; text-decoration: none;
      display: inline-flex; align-items: center; justify-content: center;
    `;
  }

  function spinnerStyle() {
    return `
      display: inline-block; width: 14px; height: 14px; border: 2px solid rgba(255,255,255,.3);
      border-top-color: #2563eb; border-radius: 50%; vertical-align: middle; margin-right: 6px;
      animation: is24-spin 0.8s linear infinite;
    `;
  }

  function ensureSpinnerKeyframes() {
    if (document.getElementById('is24-address-decoder-keyframes')) return;
    const style = document.createElement('style');
    style.id = 'is24-address-decoder-keyframes';
    style.textContent = '@keyframes is24-spin { to { transform: rotate(360deg); } }';
    document.documentElement.appendChild(style);
  }

  // --- URL builders ---

  function buildMapHref(provider: Settings['mapProvider'], parts: string[]) {
    const q = encodeURIComponent(parts.filter(Boolean).join(' '));
    if (provider === 'osm') return `https://www.openstreetmap.org/search?query=${q}`;
    if (provider === 'apple') return `https://maps.apple.com/?q=${q}`;
    return `https://www.google.com/maps/search/?api=1&query=${q}`;
  }

  function buildEarthHref(parts: string[]) {
    const q = encodeURIComponent(parts.filter(Boolean).join(' '));
    return `https://earth.google.com/web/search/${q}`;
  }

  // --- Overlay: Status (searching/decoding) ---

  function createStatusOverlay(statusKey: string) {
    removeOverlay();
    ensureSpinnerKeyframes();

    const { theme, position } = settings;
    const style = overlayBaseStyle(theme, position);

    const div = document.createElement('div');
    div.id = 'is24-address-decoder-overlay';
    div.setAttribute('style', style);

    const title = document.createElement('div');
    title.style.fontWeight = '700';
    title.style.marginBottom = '6px';
    title.textContent = t('uiTitle');

    const statusLine = document.createElement('div');
    statusLine.style.margin = '6px 0';
    statusLine.style.display = 'flex';
    statusLine.style.alignItems = 'center';

    const spinner = document.createElement('span');
    spinner.setAttribute('style', spinnerStyle());
    const statusText = document.createElement('span');
    statusText.textContent = t(statusKey);

    statusLine.append(spinner, statusText);
    div.append(title, statusLine);
    document.documentElement.appendChild(div);

    overlayEl = div;
    showOverlay();
  }

  function updateOverlayStatus(statusKey: string, subtitle?: string) {
    if (!overlayEl) return;
    const statusText = overlayEl.querySelector('span:last-child');
    if (statusText) {
      statusText.textContent = subtitle
        ? `${t(statusKey)} (${subtitle})`
        : t(statusKey);
    }
  }

  // --- Overlay: Error ---

  function createErrorOverlay(diagnostics: DecodeDiagnostics) {
    removeOverlay();

    const { theme, position } = settings;
    const style = overlayBaseStyle(theme, position);
    const ghost = ghostStyle(theme);
    const mutedColor = (theme === 'light') ? '#6b7280' : '#9ca3af';
    const codeBg = (theme === 'light') ? '#f3f4f6' : '#1f2937';
    const codeBorder = (theme === 'light') ? 'rgba(0,0,0,.08)' : 'rgba(255,255,255,.06)';

    const div = document.createElement('div');
    div.id = 'is24-address-decoder-overlay';
    div.setAttribute('style', style);

    const title = document.createElement('div');
    title.style.fontWeight = '700';
    title.style.marginBottom = '6px';
    title.textContent = t('uiTitle');

    const errorLine = document.createElement('div');
    errorLine.style.margin = '6px 0 10px';

    const errorIcon = document.createElement('span');
    errorIcon.textContent = '\u26A0 ';
    errorIcon.style.marginRight = '4px';

    const errorReasonMap: Record<string, string> = {
      'no-data': 'uiErrorNoData',
      'decode-failed': 'uiErrorDecodeFailed',
      'empty-address': 'uiErrorEmptyAddress'
    };
    const reasonKey = diagnostics.errorReason ? errorReasonMap[diagnostics.errorReason] : 'uiNoAddress';
    const errorText = document.createElement('span');
    errorText.textContent = t(reasonKey || 'uiNoAddress');
    errorLine.append(errorIcon, errorText);

    const details = document.createElement('details');
    details.style.margin = '0 0 10px';
    details.style.fontSize = '12px';

    const summary = document.createElement('summary');
    summary.style.cursor = 'pointer';
    summary.style.color = mutedColor;
    summary.style.marginBottom = '6px';
    summary.style.userSelect = 'none';
    summary.textContent = t('uiDetails');
    details.appendChild(summary);

    const diagList = document.createElement('div');
    diagList.setAttribute('style', `
      font-family: monospace; font-size: 11px; line-height: 1.5;
      background: ${codeBg}; border: 1px solid ${codeBorder};
      border-radius: 6px; padding: 8px 10px; word-break: break-all;
    `);

    const addDiagRow = (label: string, value: string) => {
      const row = document.createElement('div');
      const labelSpan = document.createElement('span');
      labelSpan.style.color = mutedColor;
      labelSpan.textContent = label + ': ';
      const valueSpan = document.createElement('span');
      valueSpan.textContent = value;
      row.append(labelSpan, valueSpan);
      diagList.appendChild(row);
    };

    addDiagRow(t('uiDiagScriptsScanned'), String(diagnostics.scriptsScanned));
    addDiagRow(t('uiDiagDataFound'), diagnostics.encodedDataFound ? t('uiDiagYes') : t('uiDiagNo'));
    addDiagRow(t('uiDiagDecodeResult'), diagnostics.decodeSuccess ? t('uiDiagYes') : t('uiDiagNo'));
    addDiagRow(t('uiDiagCoordinates'), diagnostics.coordinatesFound ? t('uiDiagYes') : t('uiDiagNo'));

    if (diagnostics.decodeSuccess && diagnostics.fieldsPopulated.length > 0) {
      addDiagRow('Fields', diagnostics.fieldsPopulated.join(', '));
    }

    if (diagnostics.rawPreview) {
      const rawRow = document.createElement('div');
      rawRow.style.marginTop = '4px';
      const rawLabel = document.createElement('span');
      rawLabel.style.color = mutedColor;
      rawLabel.textContent = t('uiDiagRawPreview') + ':';
      const rawValue = document.createElement('div');
      rawValue.setAttribute('style', `
        margin-top: 2px; padding: 4px 6px; background: ${codeBg};
        border-radius: 4px; overflow-x: auto; white-space: pre-wrap;
        max-height: 60px; overflow-y: auto;
      `);
      rawValue.textContent = diagnostics.rawPreview;
      rawRow.append(rawLabel, rawValue);
      diagList.appendChild(rawRow);
    }

    details.appendChild(diagList);

    const actions = document.createElement('div');
    actions.style.display = 'flex';
    actions.style.gap = '8px';
    actions.style.flexWrap = 'wrap';

    const retryBtn = document.createElement('button');
    retryBtn.setAttribute('style', buttonStyle(theme));
    retryBtn.textContent = t('uiRetry');
    retryBtn.addEventListener('click', () => {
      decoderRunning = false;
      lastDecodeSuccess = false;
      runDecoderOnce();
    });

    const closeBtn = document.createElement('button');
    closeBtn.setAttribute('style', ghost);
    closeBtn.textContent = t('uiClose');
    closeBtn.addEventListener('click', () => {
      overlayState = 'dismissed';
      hideOverlay();
    });

    actions.append(retryBtn, closeBtn);
    div.append(title, errorLine, details, actions);
    document.documentElement.appendChild(div);

    overlayEl = div;
    showOverlay();
  }

  // --- Overlay: Success (address found) ---

  function createSuccessOverlay(address: Address, metadata?: ExposeMetadata, priceComparison?: PriceComparison | null) {
    removeOverlay();

    const { theme, position, mapProvider, showEarth, showDates } = settings;
    const style = overlayBaseStyle(theme, position);
    const btn = buttonStyle(theme);
    const ghost = ghostStyle(theme);

    const div = document.createElement('div');
    div.id = 'is24-address-decoder-overlay';
    div.setAttribute('style', style);

    const titleRow = document.createElement('div');
    titleRow.style.display = 'flex';
    titleRow.style.alignItems = 'center';
    titleRow.style.justifyContent = 'space-between';
    titleRow.style.marginBottom = '6px';
    if (showEarth) titleRow.style.paddingRight = '30px';

    const title = document.createElement('div');
    title.style.fontWeight = '700';
    title.textContent = t('uiTitle');
    titleRow.appendChild(title);

    // Confidence badge
    if (address.confidence) {
      const badge = document.createElement('span');
      const colors: Record<string, string> = {
        exact: '#22c55e',
        high: '#3b82f6',
        medium: '#f59e0b',
        low: '#ef4444',
      };
      const labels: Record<string, string> = {
        exact: '\u2713 Exact',
        high: '\u2713 High',
        medium: '\u25CB Medium',
        low: '\u25CB Approx',
      };
      badge.style.cssText = `
        font-size: 10px; font-weight: 600; padding: 2px 6px; border-radius: 6px;
        background: ${colors[address.confidence] || colors.low}22;
        color: ${colors[address.confidence] || colors.low};
        border: 1px solid ${colors[address.confidence] || colors.low}44;
      `;
      badge.textContent = labels[address.confidence] || address.confidence;
      titleRow.appendChild(badge);
    }

    const { street, houseNumber, postalCode, city, district } = address;
    const hasTextAddress = !!(street || houseNumber || postalCode || city);
    const hasCoords = typeof address.lat === 'number' && typeof address.lng === 'number';

    let addrLine: string;
    if (hasTextAddress) {
      addrLine =
        [street, houseNumber].filter(Boolean).join(' ') +
        ((postalCode || city) ? `\n${[postalCode, city].filter(Boolean).join(' ')}` : '') +
        (district ? `\n(${district})` : '');
      if (hasCoords) {
        addrLine += `\n${address.lat!.toFixed(5)}, ${address.lng!.toFixed(5)}`;
      }
    } else if (hasCoords) {
      addrLine = `${t('uiCoordinateLocation')}\n${address.lat!.toFixed(5)}, ${address.lng!.toFixed(5)}`;
    } else {
      addrLine = '';
    }

    const line = document.createElement('div');
    line.style.margin = '6px 0 10px';
    line.style.whiteSpace = 'pre-wrap';
    line.textContent = addrLine || t('uiNoAddress');

    div.append(titleRow, line);

    // Metadata dates section (upstream feature)
    if (showDates && metadata && (metadata.publishedAt || metadata.lastModifiedAt)) {
      const metadataDiv = document.createElement('div');
      metadataDiv.style.margin = '0 0 10px';
      metadataDiv.style.fontSize = '12px';
      metadataDiv.style.opacity = '0.85';

      if (metadata.publishedAt) {
        const publishedLine = document.createElement('div');
        publishedLine.style.margin = '2px 0';
        publishedLine.textContent = `\uD83D\uDCC5 ${t('uiPublished')}: ${metadata.publishedAt}`;
        metadataDiv.appendChild(publishedLine);
      }

      if (metadata.lastModifiedAt) {
        const modifiedLine = document.createElement('div');
        modifiedLine.style.margin = '2px 0';
        modifiedLine.textContent = `\uD83D\uDD04 ${t('uiModified')}: ${metadata.lastModifiedAt}`;
        metadataDiv.appendChild(modifiedLine);
      }

      div.appendChild(metadataDiv);
    }

    // Price section
    if (priceComparison) {
      const priceDiv = document.createElement('div');
      priceDiv.style.margin = '0 0 10px';
      priceDiv.style.fontSize = '12px';

      const priceLine = document.createElement('div');
      priceLine.style.margin = '2px 0';

      const priceText = formatPriceLine(priceComparison);
      const hasChange = priceComparison.previous !== null && priceComparison.changePercent !== null;

      if (hasChange) {
        const isDown = priceComparison.changePercent! < 0;
        priceLine.style.color = isDown ? '#22c55e' : '#ef4444';
        priceLine.style.fontWeight = '600';
      }

      priceLine.textContent = `\uD83D\uDCB0 ${priceText}`;
      priceDiv.appendChild(priceLine);

      if (priceComparison.currentPerSqm) {
        const sqmLine = document.createElement('div');
        sqmLine.style.margin = '2px 0';
        sqmLine.style.opacity = '0.85';
        sqmLine.textContent = `\uD83D\uDCD0 ${Math.round(priceComparison.currentPerSqm).toLocaleString('de-DE')} \u20AC/m\u00B2`;
        priceDiv.appendChild(sqmLine);
      }

      div.appendChild(priceDiv);
    }

    const actions = document.createElement('div');
    actions.style.display = 'flex';
    actions.style.gap = '8px';
    actions.style.flexWrap = 'wrap';

    const copyBtn = document.createElement('button');
    copyBtn.setAttribute('style', btn);
    copyBtn.textContent = t('uiCopy');
    copyBtn.addEventListener('click', async () => {
      const copyText = hasCoords && !hasTextAddress
        ? `${address.lat!.toFixed(5)}, ${address.lng!.toFixed(5)}`
        : addrLine;
      const ok = await copyToClipboard(copyText);
      copyBtn.textContent = ok ? t('uiCopied') : t('uiCopyFail');
      setTimeout(() => {
        copyBtn.textContent = t('uiCopy');
      }, FEEDBACK_MESSAGE_DURATION);
    });

    const mapBtn = document.createElement('a');
    mapBtn.setAttribute('style', ghost + ' text-decoration:none; display:inline-flex; align-items:center; justify-content:center;');

    // Coordinate-aware map URL
    if (hasCoords && !hasTextAddress) {
      const coord = `${address.lat},${address.lng}`;
      if (mapProvider === 'osm') {
        mapBtn.href = `https://www.openstreetmap.org/?mlat=${address.lat}&mlon=${address.lng}#map=17/${address.lat}/${address.lng}`;
      } else if (mapProvider === 'apple') {
        mapBtn.href = `https://maps.apple.com/?ll=${coord}&q=${coord}`;
      } else {
        mapBtn.href = `https://www.google.com/maps?q=${coord}`;
      }
    } else {
      mapBtn.href = buildMapHref(mapProvider, [street, houseNumber, postalCode, city]);
    }
    mapBtn.target = '_blank';
    mapBtn.rel = 'noopener';
    mapBtn.textContent = t('uiOpenMap');

    const closeBtn = document.createElement('button');
    closeBtn.setAttribute('style', ghost);
    closeBtn.textContent = t('uiClose');
    closeBtn.addEventListener('click', () => {
      overlayState = 'dismissed';
      hideOverlay();
    });

    actions.append(copyBtn, mapBtn, closeBtn);
    div.appendChild(actions);

    // Earth button (upstream feature)
    if (showEarth && (hasTextAddress || hasCoords)) {
      const earthParts = hasTextAddress
        ? [street, houseNumber, postalCode, city]
        : [`${address.lat},${address.lng}`];
      const earthCornerBtn = document.createElement('a');
      earthCornerBtn.setAttribute('style', earthCornerStyle(theme));
      earthCornerBtn.href = buildEarthHref(earthParts);
      earthCornerBtn.target = '_blank';
      earthCornerBtn.rel = 'noopener';
      earthCornerBtn.title = t('uiOpenEarth');
      earthCornerBtn.textContent = '\uD83C\uDF0D';
      div.appendChild(earthCornerBtn);
    }

    document.documentElement.appendChild(div);
    overlayEl = div;
    showOverlay();
  }

  // --- Overlay lifecycle ---

  function removeOverlay() {
    if (overlayEl) {
      overlayEl.remove();
      overlayEl = null;
    }
  }

  function showOverlay() {
    if (!overlayEl) return;
    overlayEl.style.display = 'block';
    overlayState = 'visible';
  }

  function hideOverlay() {
    if (!overlayEl) return;
    overlayEl.style.display = 'none';
    overlayState = (overlayState === 'dismissed') ? 'dismissed' : 'hidden';
  }

  function toggleOverlay() {
    if (!overlayEl) return;
    if (overlayState === 'visible') {
      hideOverlay();
      return;
    }
    overlayState = 'hidden';
    showOverlay();
  }

  // --- URL change detection ---

  let lastUrl = location.href;
  setInterval(() => {
    if (location.href === lastUrl) return;

    lastUrl = location.href;
    overlayState = 'hidden';
    decoderRunning = false;
    lastDecodeSuccess = false;
    cancelRetries();
    removeOverlay();

    setTimeout(runDecoderOnce, MUTATION_OBSERVER_DELAY);
  }, URL_CHECK_INTERVAL);

  // --- Retry logic ---

  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  function cancelRetries() {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  }

  // --- Main decoder loop ---

  function runDecoderOnce() {
    if (overlayState === 'dismissed') return;
    if (decoderRunning) return;
    decoderRunning = true;
    cancelRetries();

    createStatusOverlay('uiSearching');

    // Extract IS24 metadata for dates display
    const is24 = extractIs24Object();
    const metadata = is24 ? extractMetadata(is24) : undefined;

    let attempt = 0;

    async function tryDecode() {
      attempt++;
      if (overlayState === 'dismissed') {
        decoderRunning = false;
        return;
      }

      if (attempt === 1) {
        updateOverlayStatus('uiSearching');
      } else {
        updateOverlayStatus('uiSearching', `${attempt} / ${MAX_RETRIES}`);
      }

      const result = runDecode();

      if (result.address) {
        lastDecodeSuccess = true;

        if (settings.autoCopy) {
          const a = result.address;
          const hasText = !!(a.street || a.houseNumber || a.postalCode || a.city);
          const copyText = hasText
            ? [a.street, a.houseNumber, a.postalCode, a.city].filter(Boolean).join(' ')
            : (typeof a.lat === 'number' && typeof a.lng === 'number')
              ? `${a.lat.toFixed(5)}, ${a.lng.toFixed(5)}`
              : '';
          if (copyText) copyToClipboard(copyText);
        }

        // Track price if metadata has it
        let priceComparison: PriceComparison | null = null;
        if (metadata?.exposeId && metadata.price?.amount) {
          try {
            priceComparison = await trackPrice(
              metadata.exposeId,
              metadata.price.amount,
              metadata.price.pricePerSqm,
              metadata.price.type,
            );
          } catch {
            // Price tracking is non-critical
          }
        }

        createSuccessOverlay(result.address, metadata, priceComparison);
        decoderRunning = false;

        // Determine if refinement is needed
        const hasStreet = !!(result.address.street);
        const isCoordOnly = !(result.address.street || result.address.houseNumber || result.address.postalCode || result.address.city);
        const needsRefinement = isCoordOnly && typeof result.address.lat === 'number';

        if (hasStreet) {
          console.log(`${LOG_PREFIX} %cDecode result: %cFull address %c${[result.address.street, result.address.houseNumber, result.address.postalCode, result.address.city].filter(Boolean).join(' ')} %c\u2014 no refinement needed`,
            LOG_STYLE, '', LOG_SUCCESS, '', LOG_DIM);
        } else if (isCoordOnly) {
          console.log(`${LOG_PREFIX} %cDecode result: %cCoordinate-only %c(${result.address.lat?.toFixed(5)}, ${result.address.lng?.toFixed(5)}) %c\u2014 triggering refinement...`,
            LOG_STYLE, '', LOG_WARN, LOG_DIM, '');
        } else {
          console.log(`${LOG_PREFIX} %cDecode result: %cPartial address %c${[result.address.postalCode, result.address.city, result.address.district].filter(Boolean).join(' ')} %c\u2014 no street, skipping refinement`,
            LOG_STYLE, '', LOG_WARN, '', LOG_DIM);
        }

        if (needsRefinement) {
          triggerRefinement(result.address);
        }
        return;
      }

      // Not found yet — retry if we have attempts left
      if (attempt < MAX_RETRIES) {
        retryTimer = setTimeout(tryDecode, RETRY_BACKOFF[attempt]);
        return;
      }

      // All retries exhausted
      lastDecodeSuccess = false;

      // If we have dates metadata but no address, show dates-only overlay
      const hasDates = settings.showDates && metadata && (metadata.publishedAt || metadata.lastModifiedAt);
      if (hasDates) {
        removeOverlay();

        const { theme, position } = settings;
        const style = overlayBaseStyle(theme, position);
        const ghost = ghostStyle(theme);

        const div = document.createElement('div');
        div.id = 'is24-address-decoder-overlay';
        div.setAttribute('style', style);

        const titleEl = document.createElement('div');
        titleEl.style.fontWeight = '700';
        titleEl.style.marginBottom = '6px';
        titleEl.textContent = t('uiTitleNoAddress');

        const metadataDiv = document.createElement('div');
        metadataDiv.style.margin = '6px 0 10px';
        metadataDiv.style.fontSize = '12px';
        metadataDiv.style.opacity = '0.85';

        if (metadata!.publishedAt) {
          const publishedLine = document.createElement('div');
          publishedLine.style.margin = '2px 0';
          publishedLine.textContent = `\uD83D\uDCC5 ${t('uiPublished')}: ${metadata!.publishedAt}`;
          metadataDiv.appendChild(publishedLine);
        }

        if (metadata!.lastModifiedAt) {
          const modifiedLine = document.createElement('div');
          modifiedLine.style.margin = '2px 0';
          modifiedLine.textContent = `\uD83D\uDD04 ${t('uiModified')}: ${metadata!.lastModifiedAt}`;
          metadataDiv.appendChild(modifiedLine);
        }

        const actions = document.createElement('div');
        actions.style.display = 'flex';
        actions.style.gap = '8px';

        const closeBtn = document.createElement('button');
        closeBtn.setAttribute('style', ghost);
        closeBtn.textContent = t('uiClose');
        closeBtn.addEventListener('click', () => {
          overlayState = 'dismissed';
          hideOverlay();
        });

        actions.appendChild(closeBtn);
        div.append(titleEl, metadataDiv, actions);
        document.documentElement.appendChild(div);

        overlayEl = div;
        showOverlay();
        decoderRunning = false;
        return;
      }

      // Show error overlay
      createErrorOverlay(result.diagnostics);
      decoderRunning = false;
    }

    setTimeout(tryDecode, 50);
  }

  // --- Startup ---

  const start = () => setTimeout(runDecoderOnce, 0);

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    start();
  } else {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  }

  let mutationTimer: ReturnType<typeof setTimeout> | null = null;
  const mo = new MutationObserver(() => {
    if (overlayState === 'dismissed') return;
    if (decoderRunning) return;
    if (overlayEl) return;

    if (mutationTimer) clearTimeout(mutationTimer);
    mutationTimer = setTimeout(runDecoderOnce, MUTATION_OBSERVER_DELAY);
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });

  if (API.runtime && API.runtime.onMessage) {
    API.runtime.onMessage.addListener((msg: ToggleOverlayMessage) => {
      if (!msg || msg.type !== 'IS24_TOGGLE_OVERLAY') return;

      if (!overlayEl) {
        runDecoderOnce();
      } else {
        toggleOverlay();
      }
    });
  }

  if (API.storage && API.storage.onChanged) {
    API.storage.onChanged.addListener((changes: Record<string, { newValue: unknown }>, area: string) => {
      if (area !== 'sync') return;

      Object.assign(settings, ...Object.keys(changes).map(k => ({ [k]: (changes as Record<string, { newValue: unknown }>)[k].newValue })));

      if ('localeOverride' in changes) {
        const newLocale = settings.localeOverride;

        if (newLocale && newLocale !== 'auto') {
          loadLocaleBundle(newLocale).then(bundle => {
            if (!bundle) {
              t = (k: string) => (API?.i18n?.getMessage ? API.i18n.getMessage(k) : k);
            } else {
              t = (k: string) => (k in bundle ? bundle[k] : k);
            }

            removeOverlay();
            decoderRunning = false;
            if (overlayState !== 'dismissed') {
              runDecoderOnce();
            }
          });
        } else {
          t = (k: string) => (API?.i18n?.getMessage ? API.i18n.getMessage(k) : k);

          removeOverlay();
          decoderRunning = false;
          if (overlayState !== 'dismissed') {
            runDecoderOnce();
          }
        }
        return;
      }

      removeOverlay();
      decoderRunning = false;
      if (overlayState !== 'dismissed') {
        runDecoderOnce();
      }
    });
  }
})();
