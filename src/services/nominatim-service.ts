// Nominatim geocoding service — forward and reverse geocoding via OpenStreetMap

import type { Bounds, LatLng } from './geo-utils.js';

export interface NominatimResult {
  lat: number;
  lng: number;
  road: string | null;
  houseNumber: string | null;
  postcode: string | null;
  city: string | null;
  suburb: string | null;
  displayName: string;
}

interface NominatimSearchResponse {
  lat: string;
  lon: string;
  display_name: string;
  address?: {
    road?: string;
    house_number?: string;
    postcode?: string;
    city?: string;
    town?: string;
    village?: string;
    suburb?: string;
    neighbourhood?: string;
  };
}

interface NominatimReverseResponse {
  lat: string;
  lon: string;
  display_name: string;
  address?: {
    road?: string;
    house_number?: string;
    postcode?: string;
    city?: string;
    town?: string;
    village?: string;
    suburb?: string;
    neighbourhood?: string;
  };
}

const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org';
const USER_AGENT = 'IS24AddressFinder/1.0';

// Rate limiting: 1 request per second
let lastRequestTime = 0;

async function rateLimitedFetch(url: string): Promise<Response> {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < 1000) {
    await new Promise(resolve => setTimeout(resolve, 1000 - elapsed));
  }
  lastRequestTime = Date.now();

  return fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'application/json',
    },
  });
}

function parseResult(item: NominatimSearchResponse | NominatimReverseResponse): NominatimResult {
  const addr = item.address || {};
  return {
    lat: parseFloat(item.lat),
    lng: parseFloat(item.lon),
    road: addr.road || null,
    houseNumber: addr.house_number || null,
    postcode: addr.postcode || null,
    city: addr.city || addr.town || addr.village || null,
    suburb: addr.suburb || addr.neighbourhood || null,
    displayName: item.display_name,
  };
}

/**
 * Forward geocode: search for a street within a bounded area.
 */
export async function forwardGeocode(
  street: string,
  city: string,
  bounds?: Bounds | null,
  postalCode?: string | null,
): Promise<NominatimResult[]> {
  const params = new URLSearchParams({
    format: 'json',
    addressdetails: '1',
    limit: '5',
    countrycodes: 'de',
    street,
    city,
  });

  if (postalCode) {
    params.set('postalcode', postalCode);
  }

  if (bounds) {
    params.set('viewbox', `${bounds.southWest.lng},${bounds.northEast.lat},${bounds.northEast.lng},${bounds.southWest.lat}`);
    params.set('bounded', '1');
  }

  try {
    const resp = await rateLimitedFetch(`${NOMINATIM_BASE}/search?${params}`);
    if (!resp.ok) return [];
    const data: NominatimSearchResponse[] = await resp.json();
    return data.map(parseResult);
  } catch {
    return [];
  }
}

/**
 * Reverse geocode: get nearest address for a coordinate.
 */
export async function reverseGeocode(point: LatLng): Promise<NominatimResult | null> {
  const params = new URLSearchParams({
    format: 'json',
    addressdetails: '1',
    zoom: '18',
    lat: String(point.lat),
    lon: String(point.lng),
  });

  try {
    const resp = await rateLimitedFetch(`${NOMINATIM_BASE}/reverse?${params}`);
    if (!resp.ok) return null;
    const data: NominatimReverseResponse = await resp.json();
    return parseResult(data);
  } catch {
    return null;
  }
}
