// Price tracking service — stores and compares listing prices across visits

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const API: any = (typeof browser !== 'undefined') ? (browser as any) : chrome;

export interface PriceRecord {
  amount: number;
  pricePerSqm: number | null;
  type: 'buy' | 'rent' | null;
  firstSeen: string;   // ISO date
  lastSeen: string;    // ISO date
  previousAmount: number | null;
  previousPricePerSqm: number | null;
  changeDate: string | null;  // ISO date of last price change
}

export interface PriceComparison {
  current: number;
  currentPerSqm: number | null;
  type: 'buy' | 'rent' | null;
  previous: number | null;
  previousPerSqm: number | null;
  changePercent: number | null;  // negative = price dropped
  changeDate: string | null;
  firstSeen: string;
  isNew: boolean;  // first time seeing this listing
}

const STORAGE_PREFIX = 'price_';
const MAX_TRACKED = 500;  // cap to avoid filling storage

function storageKey(exposeId: string): string {
  return `${STORAGE_PREFIX}${exposeId}`;
}

function getStorage(): Promise<Record<string, PriceRecord>> {
  return new Promise(resolve => {
    try {
      API.storage.local.get(null, (items: Record<string, unknown>) => {
        const records: Record<string, PriceRecord> = {};
        for (const [key, value] of Object.entries(items)) {
          if (key.startsWith(STORAGE_PREFIX) && value && typeof value === 'object') {
            records[key] = value as PriceRecord;
          }
        }
        resolve(records);
      });
    } catch {
      resolve({});
    }
  });
}

function setStorage(key: string, record: PriceRecord): Promise<void> {
  return new Promise(resolve => {
    try {
      API.storage.local.set({ [key]: record }, () => resolve());
    } catch {
      resolve();
    }
  });
}

async function pruneOldEntries(): Promise<void> {
  const all = await getStorage();
  const entries = Object.entries(all);
  if (entries.length <= MAX_TRACKED) return;

  // Remove oldest by lastSeen
  entries.sort((a, b) => a[1].lastSeen.localeCompare(b[1].lastSeen));
  const toRemove = entries.slice(0, entries.length - MAX_TRACKED).map(([key]) => key);

  return new Promise(resolve => {
    try {
      API.storage.local.remove(toRemove, () => resolve());
    } catch {
      resolve();
    }
  });
}

/**
 * Track the current price for a listing and return comparison data.
 */
export async function trackPrice(
  exposeId: string,
  amount: number,
  pricePerSqm: number | null,
  type: 'buy' | 'rent' | null,
): Promise<PriceComparison> {
  const key = storageKey(exposeId);
  const now = new Date().toISOString();

  const existing = await new Promise<PriceRecord | null>(resolve => {
    try {
      API.storage.local.get(key, (items: Record<string, unknown>) => {
        const val = items[key];
        resolve(val && typeof val === 'object' ? val as PriceRecord : null);
      });
    } catch {
      resolve(null);
    }
  });

  if (!existing) {
    // First time seeing this listing
    const record: PriceRecord = {
      amount,
      pricePerSqm,
      type,
      firstSeen: now,
      lastSeen: now,
      previousAmount: null,
      previousPricePerSqm: null,
      changeDate: null,
    };
    await setStorage(key, record);
    await pruneOldEntries();

    return {
      current: amount,
      currentPerSqm: pricePerSqm,
      type,
      previous: null,
      previousPerSqm: null,
      changePercent: null,
      changeDate: null,
      firstSeen: now,
      isNew: true,
    };
  }

  // Returning visitor — check for price change
  const priceChanged = existing.amount !== amount;

  const record: PriceRecord = {
    amount,
    pricePerSqm,
    type,
    firstSeen: existing.firstSeen,
    lastSeen: now,
    previousAmount: priceChanged ? existing.amount : existing.previousAmount,
    previousPricePerSqm: priceChanged ? existing.pricePerSqm : existing.previousPricePerSqm,
    changeDate: priceChanged ? now : existing.changeDate,
  };
  await setStorage(key, record);

  const previous = record.previousAmount;
  const changePercent = previous !== null
    ? ((amount - previous) / previous) * 100
    : null;

  return {
    current: amount,
    currentPerSqm: pricePerSqm,
    type,
    previous,
    previousPerSqm: record.previousPricePerSqm,
    changePercent,
    changeDate: record.changeDate,
    firstSeen: existing.firstSeen,
    isNew: false,
  };
}

/**
 * Format a price for display: 829000 → "829.000"
 */
export function formatPrice(amount: number): string {
  return Math.round(amount).toLocaleString('de-DE');
}

/**
 * Format a compact price line with optional change indicator.
 * Examples:
 *   "829.000 €"
 *   "829.000 € ↓8% (was 899.000 €)"
 *   "1.200 €/mo ↑5% (was 1.140 €/mo)"
 */
export function formatPriceLine(comparison: PriceComparison): string {
  const suffix = comparison.type === 'rent' ? ' \u20AC/mo' : ' \u20AC';
  const current = formatPrice(comparison.current) + suffix;

  if (comparison.previous === null || comparison.changePercent === null) {
    return current;
  }

  const pct = Math.abs(Math.round(comparison.changePercent));
  const arrow = comparison.changePercent < 0 ? '\u2193' : '\u2191';
  const prev = formatPrice(comparison.previous) + suffix;

  return `${current} ${arrow}${pct}% (was ${prev})`;
}
