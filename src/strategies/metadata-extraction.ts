// Page metadata extraction — scrapes IS24 expose page for context

import type { Bounds } from '../services/geo-utils.js';

export interface PageMetadata {
  /** Expose title */
  title: string | null;
  /** Expose description (Objektbeschreibung) */
  description: string | null;
  /** Location text (Lage section) */
  locationText: string | null;
  /** Quarter bounding box from mapModel.config.quarterBounds */
  quarterBounds: Bounds | null;
  /** ZIP code */
  zip: string | null;
  /** City name */
  city: string | null;
  /** Quarter / district name */
  quarter: string | null;
  /** GeoCode ID */
  geoCode: string | null;
  /** Whether the full address is visible on the page */
  showFullAddress: boolean;
}

function emptyMetadata(): PageMetadata {
  return {
    title: null,
    description: null,
    locationText: null,
    quarterBounds: null,
    zip: null,
    city: null,
    quarter: null,
    geoCode: null,
    showFullAddress: false,
  };
}

/**
 * Extract metadata from the current IS24 expose page.
 * Uses multiple sources: window.IS24.expose, DOM elements, inline scripts.
 */
export function extractPageMetadata(): PageMetadata {
  const meta = emptyMetadata();

  // 1. Try window.IS24.expose object
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const is24 = (window as any).IS24;
    if (is24?.expose) {
      const expose = is24.expose;

      // Address / location info
      const addr = expose.address || expose.locationAddress || {};
      meta.zip = addr.zip || addr.postcode || null;
      meta.city = addr.city || null;
      meta.quarter = addr.quarter || addr.district || null;
      meta.geoCode = addr.geoCode || expose.geoCode || null;
      meta.showFullAddress = addr.showFullAddress === true;

      // Title
      meta.title = expose.title || null;
    }
  } catch {
    // IS24 object not available
  }

  // 2. Try mapModel.config for quarterBounds
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mapConfig = (window as any).IS24?.mapModel?.config;
    if (mapConfig) {
      const qb = mapConfig.quarterBounds;
      if (qb?.southWest && qb?.northEast) {
        meta.quarterBounds = {
          southWest: { lat: Number(qb.southWest.lat), lng: Number(qb.southWest.lng) },
          northEast: { lat: Number(qb.northEast.lat), lng: Number(qb.northEast.lng) },
        };
      }
    }
  } catch {
    // mapModel not available
  }

  // 3. Scrape DOM for title
  if (!meta.title) {
    const titleEl = document.querySelector('#expose-title, h1[data-qa="expose-title"]');
    if (titleEl) meta.title = titleEl.textContent?.trim() || null;
  }

  // 4. Scrape DOM for description
  try {
    const descEl = document.querySelector('[data-qa="objectDescription"], .is24qa-objektbeschreibung');
    if (descEl) meta.description = descEl.textContent?.trim() || null;
  } catch {}

  // 5. Scrape DOM for location text
  try {
    const locEl = document.querySelector('[data-qa="locationDescription"], .is24qa-lage');
    if (locEl) meta.locationText = locEl.textContent?.trim() || null;
  } catch {}

  // 6. Fallback: scan inline scripts for JSON with location info
  if (!meta.quarterBounds || !meta.zip) {
    try {
      for (const script of Array.from(document.scripts)) {
        const txt = script.textContent || '';
        if (!txt.includes('quarterBounds') && !txt.includes('locationAddress')) continue;

        // Try to extract quarterBounds from JSON
        const qbMatch = txt.match(
          /["']?location["']?\s*:\s*\{[^}]*"quarterBoundsJson"\s*:\s*(\{[^}]*\{[^}]*\}[^}]*\{[^}]*\}[^}]*\})[^}]*"latitude"\s*:\s*([\d.]+)[^}]*"longitude"\s*:\s*([\d.]+)/
        );

        if (qbMatch && !meta.quarterBounds) {
          try {
            const qbJson = JSON.parse(qbMatch[1]);
            if (qbJson.southWest && qbJson.northEast) {
              meta.quarterBounds = {
                southWest: { lat: Number(qbJson.southWest.lat), lng: Number(qbJson.southWest.lng) },
                northEast: { lat: Number(qbJson.northEast.lat), lng: Number(qbJson.northEast.lng) },
              };
            }
          } catch {}
        }

        // Try to extract zip/city from locationAddress
        const addrMatch = txt.match(/"locationAddress"\s*:\s*\{([^}]+)\}/);
        if (addrMatch) {
          try {
            const addrJson = JSON.parse(`{${addrMatch[1]}}`);
            if (!meta.zip) meta.zip = addrJson.zip || addrJson.postcode || null;
            if (!meta.city) meta.city = addrJson.city || null;
            if (!meta.quarter) meta.quarter = addrJson.quarter || addrJson.district || null;
            if (!meta.geoCode) meta.geoCode = addrJson.geoCode || null;
          } catch {}
        }

        if (meta.quarterBounds && meta.zip) break;
      }
    } catch {}
  }

  return meta;
}
