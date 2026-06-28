/**
 * Equipment ID Utilities
 *
 * Standardized equipment IDs across the entire system:
 * Format: [CITY]-[ZONE]-[TYPE]-[SEQ] (e.g., TLV-A1-CL-001)
 *
 * This eliminates the ID mismatch bug where:
 * - FTTHNetworkV2.ts generated: closure-12 (0-based)
 * - DeckGLFTTHMapView.tsx displayed: CL-013 (+1 conversion)
 * - SpliceDiagramsView.tsx showed: Closure 13 (yet another format)
 */

// City code lookup (Hebrew + English)
// Covers major Israeli cities - expandable as needed
export const CITY_CODES: Record<string, string> = {
  // Tel Aviv area
  "Tel Aviv": "TLV",
  "תל אביב": "TLV",
  "Tel Aviv-Yafo": "TLV",
  "tel-aviv": "TLV",

  // Jerusalem
  Jerusalem: "JLM",
  ירושלים: "JLM",
  jerusalem: "JLM",

  // Haifa
  Haifa: "HFA",
  חיפה: "HFA",
  haifa: "HFA",

  // Central cities
  "Ramat Gan": "RMG",
  "רמת גן": "RMG",
  "ramat-gan": "RMG",
  "Petah Tikva": "PTK",
  "פתח תקווה": "PTK",
  "petah-tikva": "PTK",
  Holon: "HLN",
  חולון: "HLN",
  holon: "HLN",
  "Bat Yam": "BTY",
  "בת ים": "BTY",
  "bat-yam": "BTY",
  "Rishon LeZion": "RLZ",
  "ראשון לציון": "RLZ",
  "rishon-lezion": "RLZ",
  Herzliya: "HRZ",
  הרצליה: "HRZ",
  herzliya: "HRZ",
  "Kfar Saba": "KFS",
  "כפר סבא": "KFS",
  "kfar-saba": "KFS",
  Raanana: "RNN",
  רעננה: "RNN",
  raanana: "RNN",

  // Sharon area
  Netanya: "NTY",
  נתניה: "NTY",
  netanya: "NTY",
  Hadera: "HDR",
  חדרה: "HDR",
  hadera: "HDR",

  // South
  "Beer Sheva": "BSV",
  "באר שבע": "BSV",
  "beer-sheva": "BSV",
  Ashdod: "ASD",
  אשדוד: "ASD",
  ashdod: "ASD",
  Ashkelon: "ASK",
  אשקלון: "ASK",
  ashkelon: "ASK",
};

/**
 * Get 3-letter city code from city name
 * Falls back to first 3 uppercase letters if not in lookup table
 */
export function getCityCode(city: string): string {
  if (!city) return "UNK";

  // Normalize: trim and check lookup
  const trimmed = city.trim();
  if (CITY_CODES[trimmed]) {
    return CITY_CODES[trimmed];
  }

  // Try lowercase version (for slug format like "tel-aviv")
  const lower = trimmed.toLowerCase();
  if (CITY_CODES[lower]) {
    return CITY_CODES[lower];
  }

  // Fallback: first 3 uppercase letters (filter non-letters)
  const letters = trimmed.replace(/[^a-zA-Zא-ת]/g, "");
  if (letters.length >= 3) {
    return letters.substring(0, 3).toUpperCase();
  }

  return "UNK";
}

/**
 * Extract city code from a full address string by scanning for known city names
 * This handles various address formats like:
 *   - "123 Street, Tel Aviv, Israel"
 *   - "רחוב ריינס 22, תל אביב-יפו, ישראל"
 *   - "10 Herzl St, Tel Aviv-Yafo"
 *
 * @param address - Full address string from geocoding
 * @returns 3-letter city code or "UNK" if no known city found
 */
export function extractCityFromAddress(address: string): string {
  if (!address) return "UNK";

  const normalized = address.toLowerCase();

  // Scan for any known city name in the address
  // Check longer names first to avoid partial matches (e.g., "Bat Yam" before "Bat")
  const sortedCityNames = Object.keys(CITY_CODES).sort((a, b) => b.length - a.length);

  for (const cityName of sortedCityNames) {
    const lowerCityName = cityName.toLowerCase();
    // Check if the city name appears in the address
    // Use word boundary check to avoid partial matches
    if (normalized.includes(lowerCityName)) {
      return CITY_CODES[cityName];
    }
  }

  // No known city found
  return "UNK";
}

// Equipment type codes (TIA-606 inspired)
export const EQUIPMENT_TYPES = {
  co: "CO", // Central Office / OLT
  cabinet: "CAB", // T2 Cabinet
  "cabinet-t3": "FDH", // Fiber Distribution Hub (T3 Cabinet)
  closure: "CL", // Closure / Splitter
  den: "CL", // DEN = Distribution Equipment Node (same as closure)
  manhole: "MH", // Manhole
  handhole: "HH", // Handhole
  pole: "PL", // Utility Pole
  olt: "OLT", // Optical Line Terminal
  ont: "ONT", // Optical Network Terminal (at home)
  nap: "NAP", // Network Access Point
} as const;

export type EquipmentType = keyof typeof EQUIPMENT_TYPES;

/**
 * Generate standardized equipment ID
 *
 * @param cityCode - 3-letter city code (e.g., "TLV")
 * @param zoneId - Zone identifier (e.g., "A1", "B2", or "Z1" for fallback)
 * @param type - Equipment type key
 * @param sequence - 1-based sequence number (will be zero-padded to 3 digits)
 * @returns Formatted ID like "TLV-A1-CL-001"
 */
export function generateEquipmentId(
  cityCode: string,
  zoneId: string,
  type: EquipmentType,
  sequence: number,
): string {
  const typeCode = EQUIPMENT_TYPES[type];
  const seq = String(sequence).padStart(3, "0");
  return `${cityCode}-${zoneId}-${typeCode}-${seq}`;
}

/**
 * Parse a standardized equipment ID into its components
 *
 * @param id - Equipment ID like "TLV-A1-CL-001"
 * @returns Parsed components or null if invalid format
 */
export function parseEquipmentId(id: string): {
  city: string;
  zone: string;
  type: string;
  sequence: number;
} | null {
  if (!id) return null;

  // Match format: CITY-ZONE-TYPE-SEQ
  // CITY: 2-3 uppercase letters
  // ZONE: Letter + digits (e.g., A1, B12, Z1)
  // TYPE: 2-3 uppercase letters
  // SEQ: 3+ digits
  const match = id.match(/^([A-Z]{2,3})-([A-Z]\d+)-([A-Z]{2,3})-(\d{3,})$/);
  if (!match) return null;

  return {
    city: match[1],
    zone: match[2],
    type: match[3],
    sequence: parseInt(match[4], 10),
  };
}

/**
 * Check if an ID matches the standardized format
 */
export function isStandardizedId(id: string): boolean {
  return parseEquipmentId(id) !== null;
}

/**
 * Get short ID for ASCII grid display (2 digits)
 * Used in Text Twin grid annotations like [●01]
 *
 * @param id - Full equipment ID
 * @returns 2-digit sequence number or "??" if invalid
 */
export function getGridId(id: string): string {
  const parsed = parseEquipmentId(id);
  if (!parsed) return "??";
  return String(parsed.sequence).padStart(2, "0");
}

/**
 * Get the equipment type code from a standardized ID
 */
export function getTypeFromId(id: string): string | null {
  const parsed = parseEquipmentId(id);
  return parsed?.type ?? null;
}

/**
 * Get the zone from a standardized ID
 */
export function getZoneFromId(id: string): string | null {
  const parsed = parseEquipmentId(id);
  return parsed?.zone ?? null;
}

// Default zone when service area bounds are unavailable
export const DEFAULT_ZONE = "Z1";

// Default city code when city cannot be determined
export const DEFAULT_CITY = "UNK";

/**
 * Calculate zone ID from position within service area bounds
 * Divides the service area into a grid of zones (approximately 200m x 200m)
 *
 * @param position - [longitude, latitude]
 * @param serviceAreaBounds - [minLng, minLat, maxLng, maxLat]
 * @returns Zone ID like "A1", "B2", etc. or DEFAULT_ZONE if out of bounds
 */
export function getZoneFromPosition(
  position: [number, number],
  serviceAreaBounds: [number, number, number, number] | null,
): string {
  if (!serviceAreaBounds) {
    return DEFAULT_ZONE;
  }

  const [minLng, minLat, maxLng, maxLat] = serviceAreaBounds;
  const [lng, lat] = position;

  // Check if position is within bounds
  if (lng < minLng || lng > maxLng || lat < minLat || lat > maxLat) {
    return DEFAULT_ZONE;
  }

  // Zone size in degrees (approximately 200m at Israeli latitudes)
  // 1 degree latitude ≈ 111km, 1 degree longitude ≈ 85km at 32°N
  const ZONE_SIZE_LAT = 0.0018; // ~200m
  const ZONE_SIZE_LNG = 0.0024; // ~200m

  // Calculate zone indices
  const colIndex = Math.floor((lng - minLng) / ZONE_SIZE_LNG);
  const rowIndex = Math.floor((lat - minLat) / ZONE_SIZE_LAT);

  // Clamp to reasonable range (A-Z = 26 rows max)
  const clampedRow = Math.min(rowIndex, 25);
  const clampedCol = Math.min(colIndex, 99);

  // Convert to zone ID: A1, A2, B1, B2, etc.
  const rowLetter = String.fromCharCode(65 + clampedRow); // A, B, C...
  return `${rowLetter}${clampedCol + 1}`;
}

/**
 * Sequence tracker for generating unique IDs per zone and type
 */
export class EquipmentSequenceTracker {
  private sequences: Map<string, number> = new Map();

  /**
   * Get next sequence number for a zone/type combination
   * First call returns 1, subsequent calls increment
   */
  getNextSequence(zoneId: string, type: EquipmentType): number {
    const key = `${zoneId}-${type}`;
    const current = this.sequences.get(key) ?? 0;
    const next = current + 1;
    this.sequences.set(key, next);
    return next;
  }

  /**
   * Reset all sequences (use when starting a new network generation)
   */
  reset(): void {
    this.sequences.clear();
  }

  /**
   * Get current sequence count for debugging
   */
  getCounts(): Record<string, number> {
    const result: Record<string, number> = {};
    for (const [key, value] of this.sequences) {
      result[key] = value;
    }
    return result;
  }
}

// Singleton instance for convenience
export const sequenceTracker = new EquipmentSequenceTracker();
