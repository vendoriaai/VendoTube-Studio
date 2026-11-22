/**
 * Small offline gazetteer for map cards. The Director may supply lat/lon;
 * when it doesn't, common documentary locations resolve here so a map still
 * lands honestly (a marker is never placed at a guessed coordinate).
 */
export interface GeoPoint {
  lat: number
  lon: number
}

const PLACES: Record<string, GeoPoint> = {
  paris: { lat: 48.8566, lon: 2.3522 },
  'new york': { lat: 40.7128, lon: -74.006 },
  'new york city': { lat: 40.7128, lon: -74.006 },
  london: { lat: 51.5074, lon: -0.1278 },
  moscow: { lat: 55.7558, lon: 37.6173 },
  berlin: { lat: 52.52, lon: 13.405 },
  'los angeles': { lat: 34.0522, lon: -118.2437 },
  hollywood: { lat: 34.0928, lon: -118.3287 },
  toronto: { lat: 43.6532, lon: -79.3832 },
  montreal: { lat: 45.5017, lon: -73.5673 },
  inukjuak: { lat: 58.45, lon: -78.1 },
  'port harrison': { lat: 58.45, lon: -78.1 },
  ottawa: { lat: 45.4215, lon: -75.6972 },
  washington: { lat: 38.9072, lon: -77.0369 },
  'washington dc': { lat: 38.9072, lon: -77.0369 },
  chicago: { lat: 41.8781, lon: -87.6298 },
  rome: { lat: 41.9028, lon: 12.4964 },
  vienna: { lat: 48.2082, lon: 16.3738 },
  tokyo: { lat: 35.6762, lon: 139.6503 },
  sydney: { lat: -33.8688, lon: 151.2093 },
  'cape town': { lat: -33.9249, lon: 18.4241 },
  mumbai: { lat: 19.076, lon: 72.8777 },
  delhi: { lat: 28.6139, lon: 77.209 },
  cairo: { lat: 30.0444, lon: 31.2357 },
  'buenos aires': { lat: -34.6037, lon: -58.3816 },
  'mexico city': { lat: 19.4326, lon: -99.1332 },
  'san francisco': { lat: 37.7749, lon: -122.4194 },
  seattle: { lat: 47.6062, lon: -122.3321 },
  boston: { lat: 42.3601, lon: -71.0589 },
  philadelphia: { lat: 39.9526, lon: -75.1652 },
  amsterdam: { lat: 52.3676, lon: 4.9041 },
  brussels: { lat: 50.8503, lon: 4.3517 },
  geneva: { lat: 46.2044, lon: 6.1432 },
  zurich: { lat: 47.3769, lon: 8.5417 },
  stockholm: { lat: 59.3293, lon: 18.0686 },
  copenhagen: { lat: 55.6761, lon: 12.5683 },
  oslo: { lat: 59.9139, lon: 10.7522 },
  helsinki: { lat: 60.1699, lon: 24.9384 },
  madrid: { lat: 40.4168, lon: -3.7038 },
  lisbon: { lat: 38.7223, lon: -9.1393 },
  athens: { lat: 37.9838, lon: 23.7275 },
  istanbul: { lat: 41.0082, lon: 28.9784 },
  jerusalem: { lat: 31.7683, lon: 35.2137 },
  tehran: { lat: 35.6892, lon: 51.389 },
  beijing: { lat: 39.9042, lon: 116.4074 },
  shanghai: { lat: 31.2304, lon: 121.4737 },
  'hong kong': { lat: 22.3193, lon: 114.1694 },
  seoul: { lat: 37.5665, lon: 126.978 },
  singapore: { lat: 1.3521, lon: 103.8198 },
  nairobi: { lat: -1.2921, lon: 36.8219 },
  lagos: { lat: 6.5244, lon: 3.3792 },
  johannesburg: { lat: -26.2041, lon: 28.0473 },
  'rio de janeiro': { lat: -22.9068, lon: -43.1729 },
  'sao paulo': { lat: -23.5505, lon: -46.6333 },
  lima: { lat: -12.0464, lon: -77.0428 },
  bogota: { lat: 4.711, lon: -74.0721 },
  santiago: { lat: -33.4489, lon: -70.6693 },
  havana: { lat: 23.1136, lon: -82.3666 },
  reykjavik: { lat: 64.1466, lon: -21.9426 },
  dublin: { lat: 53.3498, lon: -6.2603 },
  edinburgh: { lat: 55.9533, lon: -3.1883 },
  glasgow: { lat: 55.8642, lon: -4.2518 },
  manchester: { lat: 53.4808, lon: -2.2426 },
  liverpool: { lat: 53.4084, lon: -2.9916 },
  bristol: { lat: 51.4545, lon: -2.5879 },
  cardiff: { lat: 51.4816, lon: -3.1791 },
  belfast: { lat: 54.5973, lon: -5.9301 },
  wellington: { lat: -41.2866, lon: 174.7756 },
  auckland: { lat: -36.8485, lon: 174.7633 },
  melbourne: { lat: -37.8136, lon: 144.9631 },
  brisbane: { lat: -27.4698, lon: 153.0251 },
  perth: { lat: -31.9505, lon: 115.8605 }
}

function norm(s: string): string {
  return String(s ?? '')
    .toLowerCase()
    .replace(/^the\s+/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/** Resolve a place name to coordinates, or null when unknown (never guess). */
export function lookupPlace(name: string): GeoPoint | null {
  const full = norm(name)
  if (PLACES[full]) return PLACES[full]
  const head = norm(String(name ?? '').split(',')[0])
  return PLACES[head] ?? null
}