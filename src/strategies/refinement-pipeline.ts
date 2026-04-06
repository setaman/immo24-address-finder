// Refinement Pipeline — async coordinate precision improvement

import type { Address, AddressConfidence } from '../types.js';
import type { PageMetadata } from './metadata-extraction.js';
import type { StreetCandidate } from './text-analysis-strategy.js';
import { extractStreetCandidates } from './text-analysis-strategy.js';
import { forwardGeocode } from '../services/nominatim-service.js';
import { haversineDistance, isInBounds } from '../services/geo-utils.js';
import type { LatLng } from '../services/geo-utils.js';

export interface RefinementResult {
  address: Address;
  confidence: AddressConfidence;
  source: string;
}

/**
 * Refine approximate coordinates using text analysis and geocoding.
 *
 * Pipeline:
 * 1. Extract street name candidates from listing text
 * 2. Forward geocode best candidates (constrained by quarter bounds)
 * 3. Validate results are within bounds and near approximate coords
 * 4. Fall back to reverse geocoding if no street found
 */
const LOG = '%c[IS24 Decoder]';
const LS = 'color: #3b82f6; font-weight: bold';
const DIM = 'color: #9ca3af';

export async function refineCoordinates(
  approxAddress: Address,
  metadata: PageMetadata,
): Promise<RefinementResult> {
  const approxPoint: LatLng | null =
    typeof approxAddress.lat === 'number' && typeof approxAddress.lng === 'number'
      ? { lat: approxAddress.lat, lng: approxAddress.lng }
      : null;

  // Step 1: Extract street candidates from text
  const candidates = extractStreetCandidates(
    metadata.title,
    metadata.description,
    metadata.locationText,
  );

  if (candidates.length > 0) {
    console.log(`${LOG} %cStreet candidates found: %c${candidates.length}`, LS, '', 'color: #22c55e; font-weight: bold');
    candidates.forEach((c, i) => {
      console.log(`${LOG}   %c${i + 1}. %c"${c.name}" %cscore=${c.score.toFixed(2)} from=${c.source}`, LS, DIM, 'color: #f59e0b', DIM);
    });
  } else {
    console.log(`${LOG} %cNo street candidates found in listing text`, LS, DIM);
  }

  // Step 2: Try forward geocoding with best candidates
  if (candidates.length > 0 && metadata.city) {
    console.log(`${LOG} %cTrying forward geocoding...`, LS, '');
    const result = await tryForwardGeocode(candidates, metadata, approxPoint);
    if (result) return result;
    console.log(`${LOG} %cForward geocoding: no valid results within bounds`, LS, DIM);
  }

  // No reverse geocoding — approximate coords are too imprecise for it to be useful
  console.log(`${LOG} %cNo street candidates matched. Keeping approximate coordinates.`, LS, DIM);

  // Return original with low confidence
  return {
    address: { ...approxAddress, confidence: 'low', source: 'approximate-coordinates' },
    confidence: 'low',
    source: 'approximate-coordinates',
  };
}

async function tryForwardGeocode(
  candidates: StreetCandidate[],
  metadata: PageMetadata,
  approxPoint: LatLng | null,
): Promise<RefinementResult | null> {
  // Try top 3 candidates at most
  const topCandidates = candidates.slice(0, 3);

  for (const candidate of topCandidates) {
    console.log(`${LOG}   %cForward geocoding: %c"${candidate.name}, ${metadata.zip || ''} ${metadata.city}"`, LS, DIM, 'color: #f59e0b');

    const results = await forwardGeocode(
      candidate.name,
      metadata.city!,
      metadata.quarterBounds,
      metadata.zip,
    );

    if (results.length === 0) {
      console.log(`${LOG}   %c→ No results from Nominatim`, LS, DIM);
      continue;
    }

    console.log(`${LOG}   %c→ ${results.length} result(s) from Nominatim`, LS, DIM);

    // Find the best result: within bounds and closest to approximate coords
    let bestResult = results[0];
    let bestDistance = Infinity;

    for (const r of results) {
      const point: LatLng = { lat: r.lat, lng: r.lng };
      const inBounds = !metadata.quarterBounds || isInBounds(point, metadata.quarterBounds);
      const dist = approxPoint ? haversineDistance(point, approxPoint) : 0;

      console.log(`${LOG}     %c• %c${r.road || '?'} ${r.houseNumber || ''}, ${r.postcode || ''} ${r.city || ''} %c(${r.lat.toFixed(5)}, ${r.lng.toFixed(5)}) %cdist=${Math.round(dist)}m inBounds=${inBounds}`,
        LS, DIM, '', DIM, inBounds && dist <= 3000 ? 'color: #22c55e' : 'color: #ef4444');

      if (!inBounds) continue;
      if (approxPoint) {
        if (dist > 3000) continue;
        if (dist < bestDistance) {
          bestDistance = dist;
          bestResult = r;
        }
      }
    }

    // If we found a valid result within bounds
    if (bestDistance < 3000 || !approxPoint) {
      const confidence: AddressConfidence = 'high';
      console.log(`${LOG}   %c✓ Best match: %c"${bestResult.road || candidate.name}" %cat ${Math.round(bestDistance)}m from approx coords`,
        LS, 'color: #22c55e; font-weight: bold', 'color: #f59e0b', DIM);
      console.log(`${LOG}   %cKeeping original IS24 coordinates — only adding street info from geocoding`,
        LS, DIM);
      return {
        address: {
          street: bestResult.road || candidate.name,
          houseNumber: '',
          postalCode: bestResult.postcode || metadata.zip || '',
          city: bestResult.city || metadata.city || '',
          district: bestResult.suburb || metadata.quarter || '',
          lat: approxPoint?.lat,
          lng: approxPoint?.lng,
          confidence,
          source: `forward-geocode:${candidate.source}`,
        },
        confidence,
        source: `forward-geocode:${candidate.source}`,
      };
    }
  }

  return null;
}
