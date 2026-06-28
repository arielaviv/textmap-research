/**
 * DataStore Optical Paths Service
 *
 * Pre-calculates optical loss for every address for instant AI queries.
 * This enables agents to quickly answer questions like:
 * - "Which addresses exceed the optical budget?"
 * - "What's the optical loss to Herzl 45?"
 * - "Show me all critical paths"
 *
 * Virtual File: optical-paths.json
 */

import type { DataStore, NetworkCableInput, NetworkNodeInput } from "../types/geocodebase";
import { calculatePathOpticalLoss } from "./text-twin-optical";

// =============================================================================
// TYPES
// =============================================================================

/**
 * Optical path entry for a single address
 */
export interface OpticalPathEntry {
  /** Address identifier (e.g., "H-001" or "Herzl 45, Tel Aviv") */
  address_id: string;

  /** Zone containing this address */
  zone: string;

  /** Fiber path from CO to house (node IDs) */
  path: string[];

  /** Total optical loss in dB */
  total_loss_db: number;

  /** Breakdown of optical loss by component */
  breakdown: {
    fiber_loss: number;
    splitter_loss: number;
    connector_loss: number;
    splice_loss: number;
    contingency: number;
  };

  /** Available margin (28dB - total_loss) */
  margin: number;

  /** Whether path is compliant (<= 28dB) */
  compliant: boolean;

  /** Optical status: ok, warning, critical */
  status: "ok" | "warning" | "critical";

  /** Optional warnings for this path */
  warnings?: string[];
}

/**
 * Complete optical paths data for the network
 */
export interface OpticalPathsData {
  /** Schema version */
  version: "1.0";

  /** Generation timestamp */
  generated_at: string;

  /** Maximum optical budget in dB */
  max_budget_db: number;

  /** Pre-calculated paths for all addresses */
  paths: OpticalPathEntry[];

  /** Summary statistics */
  summary: {
    total_addresses: number;
    compliant_count: number;
    warning_count: number;
    critical_count: number;
    avg_loss_db: number;
    max_loss_db: number;
    min_loss_db: number;
  };

  /** Addresses grouped by status for quick filtering */
  by_status: {
    ok: string[];
    warning: string[];
    critical: string[];
  };
}

// =============================================================================
// GENERATION FUNCTIONS
// =============================================================================

/**
 * Generate optical paths data for all addresses in the DataStore
 *
 * @param geocodebase The DataStore to analyze
 * @param maxBudget Maximum optical budget (default 28dB)
 * @returns Pre-calculated optical paths data
 */
export function generateOpticalPaths(geocodebase: DataStore, maxBudget = 28): OpticalPathsData {
  const paths: OpticalPathEntry[] = [];
  const byStatus: OpticalPathsData["by_status"] = {
    ok: [],
    warning: [],
    critical: [],
  };

  // Build node lookup map from all zones
  const nodeById = new Map<string, NetworkNodeInput>();
  const cables: NetworkCableInput[] = [];

  for (const [, zone] of geocodebase.zones) {
    // Add equipment as nodes
    for (const eq of zone.equipment) {
      nodeById.set(eq.id, {
        id: eq.id,
        type: eq.type as NetworkNodeInput["type"],
        position: eq.coordinates,
        label: eq.properties.label as string | undefined,
        splitterRatio: eq.properties.splitterRatio as string | undefined,
      });
    }

    // Extract cables from GeoJSON features
    for (const feature of zone.geojson.features) {
      if (
        feature.properties.source &&
        feature.properties.target &&
        feature.geometry.type === "LineString"
      ) {
        const coords = feature.geometry.coordinates as [number, number][];
        cables.push({
          id: feature.id,
          source: feature.properties.source as string,
          target: feature.properties.target as string,
          cableType: feature.properties.cableType as NetworkCableInput["cableType"],
          length: calculateCableLength(coords),
        });
      }
    }
  }

  // Process each address in the index
  if (geocodebase.index) {
    for (const [address, entry] of Object.entries(geocodebase.index.by_address)) {
      const pathToHome = entry.fiber_path;

      if (!pathToHome || pathToHome.length === 0) {
        // No path available - mark as critical
        const criticalEntry: OpticalPathEntry = {
          address_id: address,
          zone: entry.zone,
          path: [],
          total_loss_db: Number.POSITIVE_INFINITY,
          breakdown: {
            fiber_loss: 0,
            splitter_loss: 0,
            connector_loss: 0,
            splice_loss: 0,
            contingency: 0,
          },
          margin: Number.NEGATIVE_INFINITY,
          compliant: false,
          status: "critical",
          warnings: ["No fiber path to CO found"],
        };
        paths.push(criticalEntry);
        byStatus.critical.push(address);
        continue;
      }

      // Calculate optical loss for this path
      const opticalNode = new Map(
        Array.from(nodeById.entries()).map(([id, node]) => [
          id,
          {
            id: node.id,
            type: node.type,
            label: node.label,
            position: node.position,
            splitterRatio: node.splitterRatio,
          },
        ]),
      );

      const opticalCables = cables.map((c) => ({
        id: c.id,
        source: c.source,
        target: c.target,
        length: c.length || 0,
        cableType: c.cableType,
      }));

      const budget = calculatePathOpticalLoss(pathToHome, opticalNode, opticalCables);

      const warnings: string[] = [];

      // Check for cascade depth
      let cascadeDepth = 0;
      for (const nodeId of pathToHome) {
        const node = nodeById.get(nodeId);
        if (node?.splitterRatio) {
          cascadeDepth++;
        }
      }
      if (cascadeDepth > 2) {
        warnings.push(`Cascade depth ${cascadeDepth} exceeds maximum of 2`);
      }

      // Check if close to budget limit
      if (budget.totalLoss > maxBudget * 0.9 && budget.totalLoss <= maxBudget) {
        warnings.push(
          `Optical loss ${budget.totalLoss.toFixed(1)}dB is within 10% of budget limit`,
        );
      }

      const pathEntry: OpticalPathEntry = {
        address_id: address,
        zone: entry.zone,
        path: pathToHome,
        total_loss_db: budget.totalLoss,
        breakdown: {
          fiber_loss: budget.fiberLoss,
          splitter_loss: budget.splitterLoss,
          connector_loss: budget.connectorLoss,
          splice_loss: budget.spliceLoss,
          contingency: budget.contingency,
        },
        margin: budget.margin,
        compliant: budget.isCompliant,
        status: budget.status,
        warnings: warnings.length > 0 ? warnings : undefined,
      };

      paths.push(pathEntry);

      // Add to status groups
      byStatus[budget.status].push(address);
    }
  }

  // Calculate summary statistics
  const losses = paths
    .filter((p) => p.total_loss_db !== Number.POSITIVE_INFINITY)
    .map((p) => p.total_loss_db);

  const summary: OpticalPathsData["summary"] = {
    total_addresses: paths.length,
    compliant_count: paths.filter((p) => p.compliant).length,
    warning_count: byStatus.warning.length,
    critical_count: byStatus.critical.length,
    avg_loss_db:
      losses.length > 0
        ? Math.round((losses.reduce((a, b) => a + b, 0) / losses.length) * 10) / 10
        : 0,
    max_loss_db: losses.length > 0 ? Math.round(Math.max(...losses) * 10) / 10 : 0,
    min_loss_db: losses.length > 0 ? Math.round(Math.min(...losses) * 10) / 10 : 0,
  };

  return {
    version: "1.0",
    generated_at: new Date().toISOString(),
    max_budget_db: maxBudget,
    paths,
    summary,
    by_status: byStatus,
  };
}

/**
 * Generate optical paths from raw network data (without pre-built DataStore)
 */
export function generateOpticalPathsFromNetwork(
  houses: NetworkNodeInput[],
  cables: NetworkCableInput[],
  nodeById: Map<string, NetworkNodeInput>,
  findPathToCO: (houseId: string) => string[] | null,
  zoneForNode: Map<string, string>,
  maxBudget = 28,
): OpticalPathsData {
  const paths: OpticalPathEntry[] = [];
  const byStatus: OpticalPathsData["by_status"] = {
    ok: [],
    warning: [],
    critical: [],
  };

  // Convert to optical calculation format
  const opticalNodes = new Map(
    Array.from(nodeById.entries()).map(([id, node]) => [
      id,
      {
        id: node.id,
        type: node.type,
        label: node.label,
        position: node.position,
        splitterRatio: node.splitterRatio,
      },
    ]),
  );

  const opticalCables = cables.map((c) => ({
    id: c.id,
    source: c.source,
    target: c.target,
    length: c.length || calculateCableLength(c.path || []),
    cableType: c.cableType,
  }));

  for (const house of houses) {
    const pathToHome = findPathToCO(house.id);
    const zone = zoneForNode.get(house.id) || "unknown";
    const addressId = house.address || house.id;

    if (!pathToHome || pathToHome.length === 0) {
      const criticalEntry: OpticalPathEntry = {
        address_id: addressId,
        zone,
        path: [],
        total_loss_db: Number.POSITIVE_INFINITY,
        breakdown: {
          fiber_loss: 0,
          splitter_loss: 0,
          connector_loss: 0,
          splice_loss: 0,
          contingency: 0,
        },
        margin: Number.NEGATIVE_INFINITY,
        compliant: false,
        status: "critical",
        warnings: ["No fiber path to CO found"],
      };
      paths.push(criticalEntry);
      byStatus.critical.push(addressId);
      continue;
    }

    // Reverse path to go from CO to house
    const pathFromCO = [...pathToHome].reverse();

    const budget = calculatePathOpticalLoss(pathFromCO, opticalNodes, opticalCables);

    const warnings: string[] = [];

    // Check cascade depth
    let cascadeDepth = 0;
    for (const nodeId of pathFromCO) {
      const node = nodeById.get(nodeId);
      if (node?.splitterRatio) {
        cascadeDepth++;
      }
    }
    if (cascadeDepth > 2) {
      warnings.push(`Cascade depth ${cascadeDepth} exceeds maximum of 2`);
    }

    // Check proximity to budget limit
    if (budget.totalLoss > maxBudget * 0.9 && budget.totalLoss <= maxBudget) {
      warnings.push(`Optical loss ${budget.totalLoss.toFixed(1)}dB is within 10% of budget limit`);
    }

    const pathEntry: OpticalPathEntry = {
      address_id: addressId,
      zone,
      path: pathFromCO,
      total_loss_db: budget.totalLoss,
      breakdown: {
        fiber_loss: budget.fiberLoss,
        splitter_loss: budget.splitterLoss,
        connector_loss: budget.connectorLoss,
        splice_loss: budget.spliceLoss,
        contingency: budget.contingency,
      },
      margin: budget.margin,
      compliant: budget.isCompliant,
      status: budget.status,
      warnings: warnings.length > 0 ? warnings : undefined,
    };

    paths.push(pathEntry);
    byStatus[budget.status].push(addressId);
  }

  // Calculate summary
  const losses = paths
    .filter((p) => p.total_loss_db !== Number.POSITIVE_INFINITY)
    .map((p) => p.total_loss_db);

  const summary: OpticalPathsData["summary"] = {
    total_addresses: paths.length,
    compliant_count: paths.filter((p) => p.compliant).length,
    warning_count: byStatus.warning.length,
    critical_count: byStatus.critical.length,
    avg_loss_db:
      losses.length > 0
        ? Math.round((losses.reduce((a, b) => a + b, 0) / losses.length) * 10) / 10
        : 0,
    max_loss_db: losses.length > 0 ? Math.round(Math.max(...losses) * 10) / 10 : 0,
    min_loss_db: losses.length > 0 ? Math.round(Math.min(...losses) * 10) / 10 : 0,
  };

  return {
    version: "1.0",
    generated_at: new Date().toISOString(),
    max_budget_db: maxBudget,
    paths,
    summary,
    by_status: byStatus,
  };
}

// =============================================================================
// QUERY FUNCTIONS
// =============================================================================

/**
 * Get optical path for a specific address
 */
export function getOpticalPathForAddress(
  opticalPaths: OpticalPathsData,
  address: string,
): OpticalPathEntry | null {
  // Try exact match first
  let entry = opticalPaths.paths.find((p) => p.address_id === address);

  // Try case-insensitive match
  if (!entry) {
    const lowerAddress = address.toLowerCase();
    entry = opticalPaths.paths.find((p) => p.address_id.toLowerCase() === lowerAddress);
  }

  // Try partial match
  if (!entry) {
    const lowerAddress = address.toLowerCase();
    entry = opticalPaths.paths.find(
      (p) =>
        p.address_id.toLowerCase().includes(lowerAddress) ||
        lowerAddress.includes(p.address_id.toLowerCase()),
    );
  }

  return entry || null;
}

/**
 * Get all addresses with critical optical budget issues
 */
export function getCriticalPaths(opticalPaths: OpticalPathsData): OpticalPathEntry[] {
  return opticalPaths.paths.filter((p) => p.status === "critical");
}

/**
 * Get all addresses with warning optical budget
 */
export function getWarningPaths(opticalPaths: OpticalPathsData): OpticalPathEntry[] {
  return opticalPaths.paths.filter((p) => p.status === "warning");
}

/**
 * Get addresses exceeding a specific loss threshold
 */
export function getPathsExceedingLoss(
  opticalPaths: OpticalPathsData,
  threshold: number,
): OpticalPathEntry[] {
  return opticalPaths.paths.filter((p) => p.total_loss_db > threshold);
}

/**
 * Get addresses in a specific zone
 */
export function getPathsInZone(opticalPaths: OpticalPathsData, zone: string): OpticalPathEntry[] {
  return opticalPaths.paths.filter((p) => p.zone === zone);
}

/**
 * Get the worst optical path (highest loss)
 */
export function getWorstPath(opticalPaths: OpticalPathsData): OpticalPathEntry | null {
  const validPaths = opticalPaths.paths.filter((p) => p.total_loss_db !== Number.POSITIVE_INFINITY);
  if (validPaths.length === 0) return null;

  return validPaths.reduce((worst, current) =>
    current.total_loss_db > worst.total_loss_db ? current : worst,
  );
}

/**
 * Get the best optical path (lowest loss)
 */
export function getBestPath(opticalPaths: OpticalPathsData): OpticalPathEntry | null {
  const validPaths = opticalPaths.paths.filter((p) => p.total_loss_db !== Number.POSITIVE_INFINITY);
  if (validPaths.length === 0) return null;

  return validPaths.reduce((best, current) =>
    current.total_loss_db < best.total_loss_db ? current : best,
  );
}

// =============================================================================
// FORMATTING FUNCTIONS
// =============================================================================

/**
 * Format optical path for AI response
 */
export function formatOpticalPath(path: OpticalPathEntry): string {
  const statusSymbol = path.status === "ok" ? "✓" : path.status === "warning" ? "⚠" : "✗";

  const lines: string[] = [];
  lines.push(`Address: ${path.address_id}`);
  lines.push(`Zone: ${path.zone}`);
  lines.push(`Status: ${statusSymbol} ${path.status.toUpperCase()}`);
  lines.push(`Total Loss: ${path.total_loss_db.toFixed(1)} dB`);
  lines.push(`Margin: ${path.margin.toFixed(1)} dB`);
  lines.push("");
  lines.push("Loss Breakdown:");
  lines.push(`  - Fiber: ${path.breakdown.fiber_loss.toFixed(1)} dB`);
  lines.push(`  - Splitter: ${path.breakdown.splitter_loss.toFixed(1)} dB`);
  lines.push(`  - Connectors: ${path.breakdown.connector_loss.toFixed(1)} dB`);
  lines.push(`  - Splices: ${path.breakdown.splice_loss.toFixed(1)} dB`);
  lines.push(`  - Contingency: ${path.breakdown.contingency.toFixed(1)} dB`);

  if (path.warnings && path.warnings.length > 0) {
    lines.push("");
    lines.push("Warnings:");
    for (const warning of path.warnings) {
      lines.push(`  ⚠ ${warning}`);
    }
  }

  lines.push("");
  lines.push(`Fiber Path: ${path.path.join(" → ")}`);

  return lines.join("\n");
}

/**
 * Format optical paths summary for AI response
 */
export function formatOpticalSummary(opticalPaths: OpticalPathsData): string {
  const s = opticalPaths.summary;
  const complianceRate =
    s.total_addresses > 0 ? ((s.compliant_count / s.total_addresses) * 100).toFixed(1) : "0";

  const lines: string[] = [];
  lines.push("═══════════════════════════════════════");
  lines.push("       OPTICAL PATHS SUMMARY");
  lines.push("═══════════════════════════════════════");
  lines.push("");
  lines.push(`Total Addresses: ${s.total_addresses}`);
  lines.push(`Compliant: ${s.compliant_count} (${complianceRate}%)`);
  lines.push("");
  lines.push("By Status:");
  lines.push(`  ✓ OK: ${opticalPaths.by_status.ok.length}`);
  lines.push(`  ⚠ Warning: ${s.warning_count}`);
  lines.push(`  ✗ Critical: ${s.critical_count}`);
  lines.push("");
  lines.push("Optical Loss Statistics:");
  lines.push(`  Min: ${s.min_loss_db.toFixed(1)} dB`);
  lines.push(`  Avg: ${s.avg_loss_db.toFixed(1)} dB`);
  lines.push(`  Max: ${s.max_loss_db.toFixed(1)} dB`);
  lines.push(`  Budget: ${opticalPaths.max_budget_db} dB`);
  lines.push("");
  lines.push(`Generated: ${opticalPaths.generated_at}`);
  lines.push("═══════════════════════════════════════");

  return lines.join("\n");
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Calculate cable length from coordinate path
 */
function calculateCableLength(coordinates: [number, number][]): number {
  if (!coordinates || coordinates.length < 2) return 0;

  let totalLength = 0;
  for (let i = 0; i < coordinates.length - 1; i++) {
    totalLength += haversineDistance(coordinates[i], coordinates[i + 1]);
  }
  return totalLength;
}

/**
 * Haversine distance calculation between two coordinates
 */
function haversineDistance(coord1: [number, number], coord2: [number, number]): number {
  const R = 6371000; // Earth radius in meters
  const lat1 = (coord1[1] * Math.PI) / 180;
  const lat2 = (coord2[1] * Math.PI) / 180;
  const deltaLat = ((coord2[1] - coord1[1]) * Math.PI) / 180;
  const deltaLon = ((coord2[0] - coord1[0]) * Math.PI) / 180;

  const a =
    Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) * Math.sin(deltaLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
}
