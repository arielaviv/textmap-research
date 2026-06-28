/**
 * DataStore INDEX.json Generation
 *
 * Generates fast O(1) lookup indexes for AI agents to quickly query:
 * - by_address: address string → zone + closure + optical loss
 * - by_street: street name → zones + closures + cabinets + house count
 * - by_element: element ID → type + zone + path
 *
 * This enables instant answers to queries like:
 * - "What closure serves Herzl 45?" → Returns CL-001 in < 10ms
 * - "What's on Ben Yehuda street?" → Returns all equipment and counts
 */

import type {
  AddressIndexEntry,
  ElementIndexEntry,
  GenerateIndexInput,
  DataStoreIndex,
  NetworkCableInput,
  NetworkNodeInput,
  StreetIndexEntry,
} from "../types/geocodebase";

// ============================================================================
// Main Index Generation
// ============================================================================

/**
 * Generate the complete INDEX.json structure
 */
export function generateIndex(input: GenerateIndexInput): DataStoreIndex {
  const { houses, cables, closures, cabinets, nodeById, zoneForNode } = input;

  // Build by_address index
  const by_address = buildAddressIndex(houses, cables, closures, nodeById, zoneForNode);

  // Build by_street index
  const by_street = buildStreetIndex(houses, closures, cabinets, zoneForNode);

  // Build by_element index
  const by_element = buildElementIndex(nodeById, cables, zoneForNode);

  return {
    version: "1.0",
    by_address,
    by_street,
    by_element,
    generated_at: new Date().toISOString(),
    total_addresses: Object.keys(by_address).length,
    total_streets: Object.keys(by_street).length,
    total_elements: Object.keys(by_element).length,
  };
}

// ============================================================================
// Address Index
// ============================================================================

/**
 * Build the by_address lookup index
 * Maps address strings to zone, closure, and fiber path information
 */
function buildAddressIndex(
  houses: NetworkNodeInput[],
  cables: NetworkCableInput[],
  closures: NetworkNodeInput[],
  nodeById: Map<string, NetworkNodeInput>,
  zoneForNode: Map<string, string>,
): Record<string, AddressIndexEntry> {
  const index: Record<string, AddressIndexEntry> = {};

  // Build cable lookup for tracing fiber paths
  const cablesByTarget = new Map<string, NetworkCableInput[]>();
  for (const cable of cables) {
    const existing = cablesByTarget.get(cable.target) || [];
    existing.push(cable);
    cablesByTarget.set(cable.target, existing);
  }

  // Build closure lookup
  const closureById = new Map<string, NetworkNodeInput>();
  for (const closure of closures) {
    closureById.set(closure.id, closure);
  }

  for (const house of houses) {
    const address = house.address || house.label || house.id;
    if (!address) continue;

    const zone = zoneForNode.get(house.id) || "unknown";

    // Find the closure serving this house by tracing the drop cable
    const dropCable = cables.find(
      (c) => c.target === house.id && (c.cableType === "drop" || !c.cableType), // Default to drop for house connections
    );

    let closureId = "unknown";
    let opticalLoss: number | undefined;

    if (dropCable) {
      const sourceNode = nodeById.get(dropCable.source);
      if (sourceNode && (sourceNode.type === "closure" || sourceNode.type === "den")) {
        closureId = dropCable.source;

        // Calculate optical loss for this path
        opticalLoss = calculatePathOpticalLoss(house.id, cables, nodeById, closureById);
      }
    }

    // Trace fiber path from house back to CO
    const fiberPath = traceFiberPath(house.id, cables, nodeById);

    index[normalizeAddress(address)] = {
      zone,
      closure: closureId,
      address_id: house.id,
      optical_loss_db: opticalLoss,
      fiber_path: fiberPath.length > 0 ? fiberPath : undefined,
    };

    // Also index by house ID for direct lookups
    index[house.id] = {
      zone,
      closure: closureId,
      address_id: house.id,
      optical_loss_db: opticalLoss,
      fiber_path: fiberPath.length > 0 ? fiberPath : undefined,
    };
  }

  return index;
}

/**
 * Trace the fiber path from a house back to the CO
 * Returns array of node IDs: [house, closure, cabinet, ..., CO]
 */
export function traceFiberPath(
  houseId: string,
  cables: NetworkCableInput[],
  nodeById: Map<string, NetworkNodeInput>,
): string[] {
  const path: string[] = [houseId];
  const visited = new Set<string>([houseId]);

  // Build cable lookup by target
  const cablesByTarget = new Map<string, NetworkCableInput>();
  for (const cable of cables) {
    cablesByTarget.set(cable.target, cable);
  }

  let currentId = houseId;
  let iterations = 0;
  const maxIterations = 20; // Prevent infinite loops

  while (iterations < maxIterations) {
    iterations++;

    // Find cable where current node is the target
    const incomingCable = cablesByTarget.get(currentId);
    if (!incomingCable) break;

    const sourceId = incomingCable.source;
    if (visited.has(sourceId)) break; // Cycle detection

    visited.add(sourceId);
    path.push(sourceId);

    const sourceNode = nodeById.get(sourceId);
    if (!sourceNode) break;

    // Stop if we reached the CO
    if (sourceNode.type === "co") break;

    currentId = sourceId;
  }

  return path;
}

/**
 * Calculate optical loss for a path from house to CO
 */
function calculatePathOpticalLoss(
  houseId: string,
  cables: NetworkCableInput[],
  nodeById: Map<string, NetworkNodeInput>,
  _closureById: Map<string, NetworkNodeInput>,
): number {
  const FIBER_LOSS_PER_KM = 0.35;
  const CONNECTOR_LOSS = 0.5;
  const SPLICE_LOSS = 0.1;
  const SPLITTER_LOSS: Record<string, number> = {
    "1:2": 3.6,
    "1:4": 7.2,
    "1:8": 10.8,
    "1:16": 14.1,
    "1:32": 17.5,
  };

  let totalLoss = 0;
  const path = traceFiberPath(houseId, cables, nodeById);

  // Build cable lookup
  const cablesByEndpoints = new Map<string, NetworkCableInput>();
  for (const cable of cables) {
    cablesByEndpoints.set(`${cable.source}->${cable.target}`, cable);
    cablesByEndpoints.set(`${cable.target}->${cable.source}`, cable);
  }

  for (let i = 0; i < path.length - 1; i++) {
    const fromId = path[i];
    const toId = path[i + 1];

    // Find cable between these nodes
    const cable =
      cablesByEndpoints.get(`${fromId}->${toId}`) || cablesByEndpoints.get(`${toId}->${fromId}`);

    if (cable?.length) {
      // Fiber loss
      totalLoss += (cable.length / 1000) * FIBER_LOSS_PER_KM;
    }

    // Check if target is a splitter (closure/DEN)
    const toNode = nodeById.get(toId);
    if (toNode && (toNode.type === "closure" || toNode.type === "den")) {
      // Add splitter loss
      const ratio = toNode.splitterRatio || "1:8";
      totalLoss += SPLITTER_LOSS[ratio] || 10.8;

      // Add splice loss
      totalLoss += SPLICE_LOSS;
    }

    // Add connector loss at each node
    totalLoss += CONNECTOR_LOSS;
  }

  return Math.round(totalLoss * 100) / 100;
}

// ============================================================================
// Street Index
// ============================================================================

/**
 * Build the by_street lookup index
 * Maps street names to zones, closures, cabinets, and house counts
 */
function buildStreetIndex(
  houses: NetworkNodeInput[],
  closures: NetworkNodeInput[],
  cabinets: NetworkNodeInput[],
  zoneForNode: Map<string, string>,
): Record<string, StreetIndexEntry> {
  const index: Record<string, StreetIndexEntry> = {};

  // Helper to extract street name from address
  const extractStreet = (address: string): string | null => {
    if (!address) return null;

    // Try to extract street name (various formats)
    // "123 Main Street, City" -> "Main Street"
    // "Main Street 123, City" -> "Main Street"
    // "רחוב הרצל 45" -> "הרצל"

    // Remove numbers at start or end
    let street = address
      .replace(/^\d+[א-ת]?\s*/, "") // Remove leading numbers (including Hebrew letters)
      .replace(/\s*\d+[א-ת]?$/, "") // Remove trailing numbers
      .replace(/,.*$/, "") // Remove everything after comma
      .trim();

    // Remove common prefixes
    street = street
      .replace(/^רחוב\s+/i, "")
      .replace(/^street\s+/i, "")
      .replace(/^st\.?\s+/i, "")
      .trim();

    return street || null;
  };

  // Index houses by street
  for (const house of houses) {
    const address = house.address || house.label || "";
    const street = extractStreet(address);
    if (!street) continue;

    const normalizedStreet = normalizeStreetName(street);
    const zone = zoneForNode.get(house.id) || "unknown";

    if (!index[normalizedStreet]) {
      index[normalizedStreet] = {
        zones: [],
        closures: [],
        cabinets: [],
        houses_count: 0,
      };
    }

    const entry = index[normalizedStreet];
    if (!entry.zones.includes(zone)) {
      entry.zones.push(zone);
    }
    entry.houses_count++;
  }

  // Add closures to their streets
  for (const closure of closures) {
    const address = closure.label || "";
    const street = extractStreet(address);
    if (!street) continue;

    const normalizedStreet = normalizeStreetName(street);
    const zone = zoneForNode.get(closure.id) || "unknown";

    if (!index[normalizedStreet]) {
      index[normalizedStreet] = {
        zones: [],
        closures: [],
        cabinets: [],
        houses_count: 0,
      };
    }

    const entry = index[normalizedStreet];
    if (!entry.closures.includes(closure.id)) {
      entry.closures.push(closure.id);
    }
    if (!entry.zones.includes(zone)) {
      entry.zones.push(zone);
    }
  }

  // Add cabinets to their streets
  for (const cabinet of cabinets) {
    const address = cabinet.label || "";
    const street = extractStreet(address);
    if (!street) continue;

    const normalizedStreet = normalizeStreetName(street);
    const zone = zoneForNode.get(cabinet.id) || "unknown";

    if (!index[normalizedStreet]) {
      index[normalizedStreet] = {
        zones: [],
        closures: [],
        cabinets: [],
        houses_count: 0,
      };
    }

    const entry = index[normalizedStreet];
    if (!entry.cabinets.includes(cabinet.id)) {
      entry.cabinets.push(cabinet.id);
    }
    if (!entry.zones.includes(zone)) {
      entry.zones.push(zone);
    }
  }

  return index;
}

// ============================================================================
// Element Index
// ============================================================================

/**
 * Build the by_element lookup index
 * Maps element IDs to type, zone, and virtual file path
 */
function buildElementIndex(
  nodeById: Map<string, NetworkNodeInput>,
  cables: NetworkCableInput[],
  zoneForNode: Map<string, string>,
): Record<string, ElementIndexEntry> {
  const index: Record<string, ElementIndexEntry> = {};

  // Index nodes
  for (const [nodeId, node] of nodeById) {
    const zone = zoneForNode.get(nodeId) || "unknown";
    const type = mapNodeTypeToElementType(node.type);

    let path: string;
    switch (node.type) {
      case "co":
        path = `zones/${zone}/equipment/co.json`;
        break;
      case "cabinet":
        path = `zones/${zone}/equipment/cabinets.json`;
        break;
      case "closure":
      case "den":
        path = `zones/${zone}/equipment/closures/${nodeId}/info.json`;
        break;
      case "house":
        path = `addresses.json#${nodeId}`;
        break;
      default:
        path = `zones/${zone}/equipment/${node.type}s.json`;
    }

    index[nodeId] = { type, zone, path };
  }

  // Index cables
  for (const cable of cables) {
    const sourceZone = zoneForNode.get(cable.source) || "unknown";
    const targetZone = zoneForNode.get(cable.target) || "unknown";

    // Use source zone as primary, note if cross-zone
    const zone = sourceZone;
    const cableType = cable.cableType || "distribution";

    let path: string;
    switch (cableType) {
      case "feeder":
        path = `zones/${zone}/cables/feeder.json`;
        break;
      case "distribution":
        path = `zones/${zone}/cables/distribution.json`;
        break;
      case "drop":
        path = `zones/${zone}/cables/drop.json`;
        break;
      default:
        path = `zones/${zone}/cables/${cableType}.json`;
    }

    // Note cross-zone cables
    if (sourceZone !== targetZone) {
      path = `cross-zone.json#${cable.id}`;
    }

    index[cable.id] = { type: "cable", zone, path };
  }

  return index;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Normalize address string for consistent lookups
 */
function normalizeAddress(address: string): string {
  return address
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ") // Normalize whitespace
    .replace(/,\s*/g, ", "); // Normalize comma spacing
}

/**
 * Normalize street name for consistent lookups
 */
function normalizeStreetName(street: string): string {
  return street
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    .replace(/^(street|st\.?|road|rd\.?|avenue|ave\.?)\s+/i, "")
    .replace(/\s+(street|st\.?|road|rd\.?|avenue|ave\.?)$/i, "");
}

/**
 * Map node type to element index type
 */
function mapNodeTypeToElementType(
  nodeType: string,
): "co" | "cabinet" | "closure" | "cable" | "house" {
  switch (nodeType) {
    case "co":
      return "co";
    case "cabinet":
      return "cabinet";
    case "closure":
    case "den":
      return "closure";
    case "house":
      return "house";
    default:
      return "house";
  }
}

// ============================================================================
// Query Functions (for agents to use)
// ============================================================================

/**
 * Query the index by address
 */
export function queryByAddress(index: DataStoreIndex, address: string): AddressIndexEntry | null {
  const normalized = normalizeAddress(address);
  return index.by_address[normalized] || null;
}

/**
 * Query the index by street name
 */
export function queryByStreet(
  index: DataStoreIndex,
  streetName: string,
): StreetIndexEntry | null {
  const normalized = normalizeStreetName(streetName);
  return index.by_street[normalized] || null;
}

/**
 * Query the index by element ID
 */
export function queryByElement(
  index: DataStoreIndex,
  elementId: string,
): ElementIndexEntry | null {
  return index.by_element[elementId] || null;
}

/**
 * Fuzzy search addresses
 */
export function searchAddresses(
  index: DataStoreIndex,
  query: string,
  limit: number = 10,
): string[] {
  const normalized = normalizeAddress(query).toLowerCase();
  const matches: string[] = [];

  for (const address of Object.keys(index.by_address)) {
    if (address.toLowerCase().includes(normalized)) {
      matches.push(address);
      if (matches.length >= limit) break;
    }
  }

  return matches;
}

/**
 * Fuzzy search streets
 */
export function searchStreets(
  index: DataStoreIndex,
  query: string,
  limit: number = 10,
): string[] {
  const normalized = normalizeStreetName(query).toLowerCase();
  const matches: string[] = [];

  for (const street of Object.keys(index.by_street)) {
    if (street.toLowerCase().includes(normalized)) {
      matches.push(street);
      if (matches.length >= limit) break;
    }
  }

  return matches;
}
