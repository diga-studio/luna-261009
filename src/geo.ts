const EARTH_RADIUS_METERS = 6371000;
const DEG_TO_RAD = Math.PI / 180;

/**
 * Great-circle (shortest arc) distance in meters between two points on a
 * sphere of radius 6371000 m, using the haversine formula.
 *
 * The antimeridian needs no special casing: sin^2(dLon/2) is periodic with
 * 360 degrees, so lon = 179.999 and lon = -179.999 are correctly treated
 * as close together.
 */
export function haversineMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const phi1 = lat1 * DEG_TO_RAD;
  const phi2 = lat2 * DEG_TO_RAD;
  const dPhi = (lat2 - lat1) * DEG_TO_RAD;
  const dLambda = (lon2 - lon1) * DEG_TO_RAD;
  const sinDPhi = Math.sin(dPhi / 2);
  const sinDLambda = Math.sin(dLambda / 2);
  const a =
    sinDPhi * sinDPhi +
    Math.cos(phi1) * Math.cos(phi2) * sinDLambda * sinDLambda;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(a)));
}
