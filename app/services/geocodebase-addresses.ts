/**
 * DataStore Addresses Service
 *
 * Generates addresses.json for the DataStore virtual file system.
 * This stores enriched address data including survey information (floors, units, demand)
 * as the single source of truth for AI agents.
 *
 * Virtual File: addresses.json (root level - project-wide)
 *
 * Why Root-Level:
 * - Cross-zone queries: AI needs "all addresses on Herzl Street" which may span zones
 * - Consistent with INDEX.json: Both are global lookup files
 * - Single source of truth: Address Matching is project-wide, not zone-scoped
 * - Simpler AI queries: One file to read instead of iterating zones
 */

import type {
  AddressEntry,
  AddressesData,
  AddressFeature,
  AddressProperties,
  AddressSummary,
  LegacyAddressesData,
  NetworkCableInput,
  NetworkNodeInput,
} from "../types/geocodebase";

// =============================================================================
// TYPES
// =============================================================================

/**
 * Survey enrichment data from Address Matching AI
 */
export interface SurveyEnrichment {
  /** Building ID this enrichment applies to */
  buildingId: string;

  /** Number of floors */
  floors: number;

  /** Units per floor */
  unitsPerFloor: number;

  /** Calculated fiber demand */
  demand: number;

  /** Match confidence from AI or data source
   * - "high": From OSM or user-entered survey data
   * - "medium": Partial data available
   * - "low": Default values (no explicit OSM data)
   * - "none": No match found
   */
  confidence: "high" | "medium" | "low" | "none";

  /** AI reasoning for the match */
  reasoning?: string;

  /** Original survey line */
  raw?: string;

  /** When this was imported */
  importedAt: string;
}

/**
 * Input parameters for generating addresses data
 */
export interface GenerateAddressesInput {
  /** House nodes (addresses) */
  houses: NetworkNodeInput[];

  /** Closure nodes */
  closures: NetworkNodeInput[];

  /** All cables in the network */
  cables: NetworkCableInput[];

  /** Map from node ID to zone ID */
  zoneForNode: Map<string, string>;

  /** Survey enrichments keyed by building/house ID */
  surveyEnrichments?: Map<string, SurveyEnrichment>;

  /** Pre-calculated optical loss keyed by house ID */
  opticalLossMap?: Map<string, number>;
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Normalize an address for fuzzy matching
 * - Lowercase
 * - Remove diacritics
 * - Normalize whitespace
 * - Remove common punctuation
 */
export function normalizeAddress(address: string): string {
  return address
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // Remove diacritics
    .replace(/[,.\-'"]/g, " ") // Replace punctuation with spaces
    .replace(/\s+/g, " ") // Normalize whitespace
    .trim();
}

/**
 * Extract street name from a full address
 * Handles various formats:
 * - "123 Herzl Street, Tel Aviv" -> "Herzl Street"
 * - "הרצל 45, תל אביב" -> "הרצל"
 * - "45 Herzl St" -> "Herzl St"
 */
export function extractStreetName(address: string): string | null {
  if (!address) return null;

  // Try English format: number + street name
  const englishMatch = address.match(/^\d+[a-zA-Z]?\s+(.+?)(?:,|$)/);
  if (englishMatch) {
    return englishMatch[1].trim();
  }

  // Try Hebrew format: street name + number
  const hebrewMatch = address.match(/^([א-ת\s]+)\s+\d+/);
  if (hebrewMatch) {
    return hebrewMatch[1].trim();
  }

  // Try to get the first part before comma
  const parts = address.split(",");
  if (parts.length > 1) {
    // Remove numbers from the first part
    const streetPart = parts[0].replace(/\d+[a-zA-Zא-ת]?/g, "").trim();
    if (streetPart) {
      return streetPart;
    }
  }

  return null;
}

/**
 * Extract street number from a full address
 * Handles various formats including Hebrew letter suffixes:
 * - "123 Herzl Street, Tel Aviv" -> "123"
 * - "35א הירקון, Tel Aviv" -> "35א"
 * - "הרצל 45ב, תל אביב" -> "45ב"
 * - "45A Main St" -> "45A"
 */
export function extractStreetNumber(address: string): string | null {
  if (!address) return null;

  // Try Hebrew format: street name + number (possibly with Hebrew letter suffix)
  // Match: "הירקון 35א" or "הרצל 45"
  const hebrewMatch = address.match(/\s(\d+[א-ת]?)(?:\s|,|$)/);
  if (hebrewMatch) {
    return hebrewMatch[1];
  }

  // Try format with number at start: "35א הירקון"
  const startMatch = address.match(/^(\d+[א-תa-zA-Z]?)\s/);
  if (startMatch) {
    return startMatch[1];
  }

  // Try English format: number at start with optional letter suffix
  const englishMatch = address.match(/^(\d+[a-zA-Z]?)\s/);
  if (englishMatch) {
    return englishMatch[1];
  }

  return null;
}

/**
 * Find the serving closure for a house based on drop cables
 */
function findServingClosure(
  houseId: string,
  cables: NetworkCableInput[],
  closures: NetworkNodeInput[],
): string | undefined {
  const closureIds = new Set(closures.map((c) => c.id));

  // Find drop cable that targets this house
  for (const cable of cables) {
    if (cable.cableType === "drop" && cable.target === houseId) {
      if (closureIds.has(cable.source)) {
        return cable.source;
      }
    }
    // Also check reverse direction
    if (cable.cableType === "drop" && cable.source === houseId) {
      if (closureIds.has(cable.target)) {
        return cable.target;
      }
    }
  }

  return undefined;
}

/**
 * Calculate drop cable length for a house
 */
function getDropCableLength(houseId: string, cables: NetworkCableInput[]): number | undefined {
  for (const cable of cables) {
    if (cable.cableType === "drop") {
      if (cable.target === houseId || cable.source === houseId) {
        return cable.length;
      }
    }
  }
  return undefined;
}

// =============================================================================
// MAIN API
// =============================================================================

/**
 * Compute summary statistics from address features
 */
function computeAddressSummary(features: AddressFeature[]): AddressSummary {
  const withSurvey = features.filter((f) => f.properties.floors !== undefined).length;
  const connected = features.filter((f) => f.properties.status === "connected").length;
  const orphaned = features.filter((f) => f.properties.status === "orphaned").length;
  const totalDemand = features.reduce((sum, f) => sum + (f.properties.fiber_demand || 1), 0);
  const lossValues = features
    .map((f) => f.properties.optical_loss_db)
    .filter((v): v is number => v !== undefined);

  return {
    total_addresses: features.length,
    with_survey_data: withSurvey,
    connected,
    orphaned,
    total_fiber_demand: totalDemand,
    avg_optical_loss_db:
      lossValues.length > 0 ? lossValues.reduce((a, b) => a + b, 0) / lossValues.length : undefined,
    max_optical_loss_db: lossValues.length > 0 ? Math.max(...lossValues) : undefined,
  };
}

/**
 * Build by_zone index from address features
 */
function buildByZoneIndex(
  features: AddressFeature[],
): NonNullable<AddressesData["metadata"]>["by_zone"] {
  const byZone: Record<
    string,
    { address_count: number; fiber_demand: number; closures: string[] }
  > = {};

  for (const feature of features) {
    const zone = feature.properties.zone;
    if (!byZone[zone]) {
      byZone[zone] = { address_count: 0, fiber_demand: 0, closures: [] };
    }
    byZone[zone].address_count++;
    byZone[zone].fiber_demand += feature.properties.fiber_demand || 1;
    const closure = feature.properties.serving_closure;
    if (closure && !byZone[zone].closures.includes(closure)) {
      byZone[zone].closures.push(closure);
    }
  }

  return byZone;
}

/**
 * Build by_street index from address features
 */
function buildByStreetIndex(
  features: AddressFeature[],
): NonNullable<AddressesData["metadata"]>["by_street"] {
  const byStreet: Record<string, { address_ids: string[]; total_demand: number; zones: string[] }> =
    {};

  for (const feature of features) {
    const street = extractStreetName(feature.properties.address);
    if (!street) continue;

    if (!byStreet[street]) {
      byStreet[street] = { address_ids: [], total_demand: 0, zones: [] };
    }
    byStreet[street].address_ids.push(feature.properties.address_id);
    byStreet[street].total_demand += feature.properties.fiber_demand || 1;
    if (!byStreet[street].zones.includes(feature.properties.zone)) {
      byStreet[street].zones.push(feature.properties.zone);
    }
  }

  return byStreet;
}

/**
 * Generate addresses.json data for DataStore (GeoJSON FeatureCollection format)
 *
 * @param input - Houses, closures, cables, and enrichment data
 * @returns AddressesData as GeoJSON FeatureCollection
 */
export function generateAddressesData(input: GenerateAddressesInput): AddressesData {
  const { houses, closures, cables, zoneForNode, surveyEnrichments, opticalLossMap } = input;

  // Build GeoJSON features array
  const features: AddressFeature[] = houses.map((house) => {
    const zone = zoneForNode.get(house.id) || "unknown";
    const enrichment = surveyEnrichments?.get(house.id);
    const opticalLoss = opticalLossMap?.get(house.id);
    const servingClosure = findServingClosure(house.id, cables, closures);
    const dropCableLength = getDropCableLength(house.id, cables);

    // Determine connection status
    let status: "connected" | "orphaned" | "planned" = "orphaned";
    if (servingClosure) {
      status = "connected";
    }

    // Parse address components
    const fullAddress = house.address || house.label || `Address ${house.id}`;
    const streetName = extractStreetName(fullAddress);
    const streetNumber = extractStreetNumber(fullAddress);

    // Build the address properties
    const properties: AddressProperties = {
      address_id: house.id,
      address: fullAddress,
      normalized_address: normalizeAddress(fullAddress),
      street_name: streetName || undefined,
      street_number: streetNumber || undefined,
      zone,
      building_id: house.id,
      building_type: house.buildingType || "unknown",
      serving_closure: servingClosure,

      // Survey enrichment (if available)
      floors: enrichment?.floors,
      units_per_floor: enrichment?.unitsPerFloor,
      fiber_demand: enrichment?.demand,
      match_confidence: enrichment?.confidence,
      match_reasoning: enrichment?.reasoning,
      survey_raw: enrichment?.raw,
      survey_imported_at: enrichment?.importedAt,

      // Network data
      optical_loss_db: opticalLoss,
      drop_cable_length: dropCableLength,
      status,
    };

    // Build the GeoJSON feature
    const feature: AddressFeature = {
      type: "Feature",
      id: house.id,
      geometry: {
        type: "Point",
        coordinates: house.position,
      },
      properties,
    };

    return feature;
  });

  return {
    type: "FeatureCollection",
    features,
    metadata: {
      version: "1.0",
      generated_at: new Date().toISOString(),
      summary: computeAddressSummary(features),
      by_zone: buildByZoneIndex(features),
      by_street: buildByStreetIndex(features),
    },
  };
}

// =============================================================================
// QUERY FUNCTIONS (GeoJSON Format)
// =============================================================================

/**
 * Helper: Convert AddressFeature to AddressEntry (adds position from geometry).
 * For Polygon geometries we return the centroid of the outer ring so callers
 * can keep using a single [lng, lat] position.
 */
function featureToEntry(feature: AddressFeature): AddressEntry {
  const position: [number, number] =
    feature.geometry.type === "Point"
      ? feature.geometry.coordinates
      : ringCentroid(feature.geometry.coordinates[0]);
  return {
    ...feature.properties,
    position,
  };
}

function ringCentroid(ring: [number, number][]): [number, number] {
  if (!ring || ring.length === 0) return [0, 0];
  // Drop the closing coord if present (same as first)
  const closed =
    ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1];
  const pts = closed ? ring.slice(0, -1) : ring;
  let sumLng = 0;
  let sumLat = 0;
  for (const [lng, lat] of pts) {
    sumLng += lng;
    sumLat += lat;
  }
  return [sumLng / pts.length, sumLat / pts.length];
}

/**
 * Get all addresses for a specific street
 */
export function getAddressesByStreet(data: AddressesData, streetName: string): AddressEntry[] {
  const normalizedSearch = normalizeAddress(streetName);
  const byStreet = data.metadata?.by_street;

  if (!byStreet) {
    // Fallback: search features directly if no index
    return data.features
      .filter((f) => {
        const street = f.properties.street_name;
        if (!street) return false;
        const normalizedStreet = normalizeAddress(street);
        return (
          normalizedStreet === normalizedSearch ||
          normalizedStreet.includes(normalizedSearch) ||
          normalizedSearch.includes(normalizedStreet)
        );
      })
      .map(featureToEntry);
  }

  // Try exact match first
  for (const [street, info] of Object.entries(byStreet)) {
    if (normalizeAddress(street) === normalizedSearch) {
      return info.address_ids
        .map((id) => data.features.find((f) => f.properties.address_id === id))
        .filter((f): f is AddressFeature => f !== undefined)
        .map(featureToEntry);
    }
  }

  // Try partial match
  for (const [street, info] of Object.entries(byStreet)) {
    if (
      normalizeAddress(street).includes(normalizedSearch) ||
      normalizedSearch.includes(normalizeAddress(street))
    ) {
      return info.address_ids
        .map((id) => data.features.find((f) => f.properties.address_id === id))
        .filter((f): f is AddressFeature => f !== undefined)
        .map(featureToEntry);
    }
  }

  return [];
}

/**
 * Get total fiber demand for a street
 */
export function getStreetFiberDemand(data: AddressesData, streetName: string): number {
  const normalizedSearch = normalizeAddress(streetName);
  const byStreet = data.metadata?.by_street;

  if (!byStreet) {
    // Fallback: calculate from features directly
    return data.features
      .filter((f) => {
        const street = f.properties.street_name;
        if (!street) return false;
        const normalizedStreet = normalizeAddress(street);
        return normalizedStreet === normalizedSearch || normalizedStreet.includes(normalizedSearch);
      })
      .reduce((sum, f) => sum + (f.properties.fiber_demand || 1), 0);
  }

  for (const [street, info] of Object.entries(byStreet)) {
    if (
      normalizeAddress(street) === normalizedSearch ||
      normalizeAddress(street).includes(normalizedSearch)
    ) {
      return info.total_demand;
    }
  }

  return 0;
}

/**
 * Get all addresses in a specific zone
 */
export function getAddressesByZone(data: AddressesData, zoneId: string): AddressEntry[] {
  return data.features.filter((f) => f.properties.zone === zoneId).map(featureToEntry);
}

/**
 * Get all orphaned addresses (not connected to network)
 */
export function getOrphanedAddresses(data: AddressesData): AddressEntry[] {
  return data.features.filter((f) => f.properties.status === "orphaned").map(featureToEntry);
}

/**
 * Get addresses with survey data
 */
export function getAddressesWithSurveyData(data: AddressesData): AddressEntry[] {
  return data.features.filter((f) => f.properties.floors !== undefined).map(featureToEntry);
}

/**
 * Find addresses matching a search query (fuzzy)
 */
export function searchAddresses(data: AddressesData, query: string): AddressEntry[] {
  const normalizedQuery = normalizeAddress(query);

  return data.features
    .filter((f) => {
      const normalizedAddr = f.properties.normalized_address;
      return normalizedAddr.includes(normalizedQuery) || normalizedQuery.includes(normalizedAddr);
    })
    .map(featureToEntry);
}

/**
 * Get summary text for AI agents
 */
export function getAddressesSummary(data: AddressesData): string {
  const summary = data.metadata?.summary;
  const byZone = data.metadata?.by_zone;
  const byStreet = data.metadata?.by_street;

  // If no metadata, compute from features
  const computedSummary = summary || computeAddressSummary(data.features);

  const lines: string[] = [
    `Addresses Summary:`,
    `  Total: ${computedSummary.total_addresses}`,
    `  Connected: ${computedSummary.connected}`,
    `  Orphaned: ${computedSummary.orphaned}`,
    `  With Survey Data: ${computedSummary.with_survey_data}`,
    `  Total Fiber Demand: ${computedSummary.total_fiber_demand}`,
  ];

  if (computedSummary.avg_optical_loss_db !== undefined) {
    lines.push(`  Avg Optical Loss: ${computedSummary.avg_optical_loss_db.toFixed(1)} dB`);
  }

  if (computedSummary.max_optical_loss_db !== undefined) {
    lines.push(`  Max Optical Loss: ${computedSummary.max_optical_loss_db.toFixed(1)} dB`);
  }

  // Add zone breakdown
  const zoneCount = byZone ? Object.keys(byZone).length : 0;
  if (zoneCount > 0) {
    lines.push(`  Zones: ${zoneCount}`);
  }

  // Add street breakdown
  const streetCount = byStreet ? Object.keys(byStreet).length : 0;
  if (streetCount > 0) {
    lines.push(`  Streets: ${streetCount}`);
  }

  return lines.join("\n");
}

// =============================================================================
// CONVERSION FUNCTIONS
// =============================================================================

/**
 * Input type for polygon analysis buildings
 * These come from the service area polygon analysis
 */
export interface PolygonAnalysisBuilding {
  id: string;
  position: [number, number];
  address?: string;
  type?: "residential" | "commercial" | "hotel" | "industrial" | "mixed" | "unknown";
  floors?: number;
  unitsPerFloor?: number;
  estimatedUnits?: number;
  footprint?: [number, number][];
}

/**
 * Zone grid configuration for determining which zone a building belongs to
 */
export interface ZoneGridConfig {
  bounds: {
    minLat: number;
    maxLat: number;
    minLng: number;
    maxLng: number;
  };
  rows: number;
  cols: number;
  zoneSize: number; // meters
}

/**
 * Determine which zone a position belongs to based on grid
 */
function determineZone(position: [number, number], zoneGrid?: ZoneGridConfig): string {
  if (!zoneGrid) {
    return "default";
  }

  const [lng, lat] = position;
  const { bounds, cols } = zoneGrid;

  // Calculate relative position in grid
  const relLng = (lng - bounds.minLng) / (bounds.maxLng - bounds.minLng);
  const relLat = (lat - bounds.minLat) / (bounds.maxLat - bounds.minLat);

  // Clamp to valid range
  const col = Math.min(cols - 1, Math.max(0, Math.floor(relLng * cols)));
  const row = Math.min(zoneGrid.rows - 1, Math.max(0, Math.floor(relLat * zoneGrid.rows)));

  // Convert to zone ID (e.g., "A1", "B2", etc.)
  const colLetter = String.fromCharCode(65 + col); // A, B, C...
  return `${colLetter}${row + 1}`;
}

/**
 * Convert polygon analysis buildings to GeoJSON AddressesData
 *
 * This is called after handlePolygonComplete() to populate addressesData
 * in the DataStore.
 *
 * @param buildings - Buildings detected from polygon analysis
 * @param zoneGrid - Optional zone grid for zone assignment
 * @returns AddressesData as GeoJSON FeatureCollection
 */
export function buildingsToAddressesData(
  buildings: PolygonAnalysisBuilding[],
  zoneGrid?: ZoneGridConfig,
): AddressesData {
  const features: AddressFeature[] = buildings.map((building, index) => {
    const zone = determineZone(building.position, zoneGrid);
    const fullAddress = building.address || `Building ${index + 1}`;
    const fiberDemand =
      building.estimatedUnits || (building.floors || 1) * (building.unitsPerFloor || 1);

    const properties: AddressProperties = {
      address_id: building.id || `addr-${index}`,
      address: fullAddress,
      normalized_address: normalizeAddress(fullAddress),
      street_name: extractStreetName(fullAddress) || undefined,
      street_number: extractStreetNumber(fullAddress) || undefined,
      zone,
      building_id: building.id,
      building_type: building.type || "unknown",
      footprint: building.footprint,
      floors: building.floors,
      units_per_floor: building.unitsPerFloor,
      fiber_demand: fiberDemand,
      status: "planned" as const,
    };

    // Use OSM building footprint as Polygon geometry when available; fall back to Point.
    const ring = building.footprint;
    const hasValidRing = Array.isArray(ring) && ring.length >= 3;
    const closedRing = hasValidRing
      ? // Ensure the ring is closed (first === last)
        ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]
        ? ring
        : [...ring, ring[0]]
      : null;

    const geometry: AddressFeature["geometry"] = closedRing
      ? { type: "Polygon", coordinates: [closedRing] }
      : { type: "Point", coordinates: building.position };

    return {
      type: "Feature" as const,
      id: building.id || `addr-${index}`,
      geometry,
      properties,
    };
  });

  return {
    type: "FeatureCollection",
    features,
    metadata: {
      version: "1.0",
      generated_at: new Date().toISOString(),
      summary: computeAddressSummary(features),
      by_zone: buildByZoneIndex(features),
      by_street: buildByStreetIndex(features),
    },
  };
}

/**
 * Convert legacy AddressesData format to GeoJSON format
 * Use this to migrate old data to the new format
 */
export function legacyToGeoJSONAddresses(legacy: LegacyAddressesData): AddressesData {
  const features: AddressFeature[] = legacy.addresses.map((addr) => ({
    type: "Feature" as const,
    id: addr.address_id,
    geometry: {
      type: "Point" as const,
      coordinates: addr.position,
    },
    properties: {
      address_id: addr.address_id,
      address: addr.address,
      normalized_address: addr.normalized_address,
      street_name: addr.street_name,
      street_number: addr.street_number,
      zone: addr.zone,
      building_id: addr.building_id,
      building_type: addr.building_type,
      serving_closure: addr.serving_closure,
      floors: addr.floors,
      units_per_floor: addr.units_per_floor,
      fiber_demand: addr.fiber_demand,
      match_confidence: addr.match_confidence,
      match_reasoning: addr.match_reasoning,
      survey_raw: addr.survey_raw,
      survey_imported_at: addr.survey_imported_at,
      optical_loss_db: addr.optical_loss_db,
      drop_cable_length: addr.drop_cable_length,
      status: addr.status,
    },
  }));

  return {
    type: "FeatureCollection",
    features,
    metadata: {
      version: "1.0",
      generated_at: legacy.generated_at,
      summary: legacy.summary,
      by_zone: legacy.by_zone,
      by_street: legacy.by_street,
    },
  };
}
