// Geographic utility functions

export interface LatLng {
  lat: number;
  lng: number;
}

export interface Bounds {
  southWest: LatLng;
  northEast: LatLng;
}

const EARTH_RADIUS_M = 6_371_000;

/** Haversine distance in meters between two points. */
export function haversineDistance(a: LatLng, b: LatLng): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h = sinLat * sinLat + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinLng * sinLng;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

/** Check if a point falls within a bounding box. */
export function isInBounds(point: LatLng, bounds: Bounds): boolean {
  return (
    point.lat >= bounds.southWest.lat &&
    point.lat <= bounds.northEast.lat &&
    point.lng >= bounds.southWest.lng &&
    point.lng <= bounds.northEast.lng
  );
}

/** Get the center of a bounding box. */
export function boundsCenter(bounds: Bounds): LatLng {
  return {
    lat: (bounds.southWest.lat + bounds.northEast.lat) / 2,
    lng: (bounds.southWest.lng + bounds.northEast.lng) / 2,
  };
}
