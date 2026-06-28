/**
 * DataStore Zone System (formerly Zone-Based Text Twin)
 *
 * Divides large service areas into manageable zones, each with:
 * - High-resolution ASCII spatial grid (100x50 chars, ~2m per cell)
 * - GeoJSON source data (editable by Claude)
 * - Equipment list with exact coordinates
 * - Cross-zone connection tracking
 *
 * This enables Claude to work with FTTH networks like code:
 * - Zones are like "files"
 * - Cross-zone cables are like "imports"
 * - The ASCII grid provides spatial context
 * - GeoJSON is the editable source of truth
 */

import type {
  ClosureHardwareData,
  ClosureIndexData,
  ClosureOpticalBudgetData,
  ClosurePhotosData,
  ClosureVerificationData,
} from "../types/closure-codex";
// Import types from the canonical geocodebase types file
import type {
  AdjacentZones,
  ClosureFibersData,
  CrossZoneLink,
  GenerateIndexInput,
  DataStore,
  DataStoreZone,
  InfrastructureBuilding,
  InfrastructurePole,
  InfrastructureRoad,
  NetworkCableInput,
  NetworkNodeInput,
  ZoneBounds,
  ZoneEquipment,
  ZoneFeature,
  ZoneGeoJSON,
  ZoneIssue,
} from "../types/geocodebase";
import {
  generateClosureHardware,
  generateClosureIndex,
  generateClosureMd,
  generateClosureOpticalBudget,
  generateClosurePhotos,
  generateClosureVerification,
} from "./closure-codex-generators";
import { getGridId, parseEquipmentId } from "./equipment-id";
import { generateAddressesData, type SurveyEnrichment } from "./geocodebase-addresses";
import { generateClosureFibersJson } from "./geocodebase-fibers";
import { generateIndex } from "./geocodebase-index";
import { generateProjectMd } from "./geocodebase-project-memory";
import { generateClosureSpliceTxt } from "./geocodebase-splice-diagram";
import { addStreetLabelsToGrid } from "./geocodebase-street-labels";
import { exportRoutingGraphToJSON, type RoutingGraph, type RoutingNode } from "./routing-graph";

// Re-export all types from geocodebase for backward compatibility
export type {
  AdjacentZones,
  CrossZoneLink,
  DataStore,
  DataStoreZone,
  InfrastructureBuilding,
  InfrastructurePole,
  InfrastructureRoad,
  ZoneBounds,
  ZoneEquipment,
  ZoneFeature,
  ZoneGeoJSON,
  ZoneId,
  ZoneIssue,
} from "../types/geocodebase";

// ============================================================================
// Type Aliases for Backward Compatibility
// ============================================================================

/** @deprecated Use DataStoreZone instead */
export type ZoneTextTwin = DataStoreZone;

/** @deprecated Use DataStore instead */
export type ServiceAreaTextTwin = DataStore;

// ============================================================================
// Constants
// ============================================================================

/** Default zone size in meters */
export const DEFAULT_ZONE_SIZE = { width: 200, height: 200 };

/** ASCII grid dimensions (default — used when no override is provided) */
export const GRID_WIDTH = 100;
export const GRID_HEIGHT = 50;

// ---------------------------------------------------------------------------
// Configurable grid resolution
// ---------------------------------------------------------------------------

/** Configuration for grid resolution. */
export interface GridResolutionConfig {
  gridWidth: number;
  gridHeight: number;
  /** Optional sidewalk rendering width in cells (default 2). */
  sidewalkWidth?: number;
}

/** Pre-defined resolution presets keyed by density class. */
export const GRID_RESOLUTION_PRESETS: Record<string, GridResolutionConfig> = {
  rural: { gridWidth: 100, gridHeight: 50 },
  suburban: { gridWidth: 150, gridHeight: 75 },
  urban: { gridWidth: 200, gridHeight: 100 },
  "ultra-dense": { gridWidth: 200, gridHeight: 200 },
};

/**
 * Select a grid resolution preset based on the number of buildings in a zone.
 * Returns one of the predefined presets; callers can override individual fields.
 */
export function selectGridResolution(buildingCount: number): GridResolutionConfig {
  if (buildingCount <= 5) return GRID_RESOLUTION_PRESETS.rural;
  if (buildingCount <= 15) return GRID_RESOLUTION_PRESETS.suburban;
  if (buildingCount <= 40) return GRID_RESOLUTION_PRESETS.urban;
  return GRID_RESOLUTION_PRESETS["ultra-dense"];
}

/** Symbols for ASCII grid */
export const SYMBOLS = {
  // Equipment symbols
  co: "★",
  cabinet: "◆",
  cabinet_t3: "◇", // T3/FDH cabinet
  closure: "●",
  den: "●", // DEN nodes are closures/splitters - same symbol
  house: "○",
  pole: "│",

  // Infrastructure symbols
  building: "▓",
  sidewalk: "░",
  road_h: "═",
  road_v: "║",
  road_cross: "╬",
  road_corner_ne: "╗",
  road_corner_nw: "╔",
  road_corner_se: "╝",
  road_corner_sw: "╚",

  // Legacy cable symbols (for backwards compatibility)
  cable_underground: "━",
  cable_aerial: "~",
  cable_drop: "─",

  // NEW: Cable type symbols with visual distinction
  // Feeder cables (CO → Cabinet): Double line
  cable_feeder_h: "═", // Feeder horizontal
  cable_feeder_v: "║", // Feeder vertical
  // Distribution cables (Cabinet → Closure): Single line
  cable_distribution_h: "─", // Distribution horizontal
  cable_distribution_v: "│", // Distribution vertical
  // Drop cables (Closure → Home): Dotted
  cable_drop_h: "·", // Drop horizontal
  cable_drop_v: ":", // Drop vertical

  // NEW: Infrastructure path symbols
  conduit_h: "┄", // Underground conduit (dashed horizontal)
  conduit_v: "┆", // Underground conduit (dashed vertical)
  aerial_span_h: "~", // Aerial span horizontal
  aerial_span_v: "∿", // Aerial span vertical

  // NEW: Optical status symbols
  optical_ok: "✓",
  optical_warning: "⚠",
  optical_critical: "✗",

  // Utility symbols
  empty: " ",
  error: "×",
  zone_link: "→",

  // Composite symbols for overlapping elements
  cable_road_h: "╪", // Drop cable crossing horizontal road
  cable_road_v: "╫", // Drop cable crossing vertical road
  cable_building: "▒", // Cable passing through/near building
  house_connected: "◎", // House with drop cable connected
  closure_connected: "●", // Closure with cables (same as closure, it's the hub)

  // Connection indicators
  connection_node: "●",
  connection_junction: "┼",
} as const;

/** Numbered closure symbols for LLM-optimized spatial reasoning */
export const NUMBERED_CLOSURE_SYMBOLS = [
  "⓪",
  "①",
  "②",
  "③",
  "④",
  "⑤",
  "⑥",
  "⑦",
  "⑧",
  "⑨",
  "⑩",
  "⑪",
  "⑫",
  "⑬",
  "⑭",
  "⑮",
  "⑯",
  "⑰",
  "⑱",
  "⑲",
  "⑳",
  "㉑",
  "㉒",
  "㉓",
  "㉔",
  "㉕",
  "㉖",
  "㉗",
  "㉘",
  "㉙",
  "㉚",
  "㉛",
  "㉜",
  "㉝",
  "㉞",
  "㉟",
  "㊱",
  "㊲",
  "㊳",
  "㊴",
  "㊵",
  "㊶",
  "㊷",
  "㊸",
  "㊹",
  "㊺",
  "㊻",
  "㊼",
  "㊽",
  "㊾",
] as const;

/** Numbered house symbols for LLM-optimized spatial reasoning
 * Uses same circled number symbols as closures - allows LLM to uniquely identify each house
 * Format: ①②③...⑳ (for houses 1-20), then ㉑㉒...㊾ (for houses 21-50)
 */
export const NUMBERED_HOUSE_SYMBOLS = [
  "⓪", // 0 (rarely used)
  "①",
  "②",
  "③",
  "④",
  "⑤",
  "⑥",
  "⑦",
  "⑧",
  "⑨",
  "⑩",
  "⑪",
  "⑫",
  "⑬",
  "⑭",
  "⑮",
  "⑯",
  "⑰",
  "⑱",
  "⑲",
  "⑳",
  "㉑",
  "㉒",
  "㉓",
  "㉔",
  "㉕",
  "㉖",
  "㉗",
  "㉘",
  "㉙",
  "㉚",
  "㉛",
  "㉜",
  "㉝",
  "㉞",
  "㉟",
  "㊱",
  "㊲",
  "㊳",
  "㊴",
  "㊵",
  "㊶",
  "㊷",
  "㊸",
  "㊹",
  "㊺",
  "㊻",
  "㊼",
  "㊽",
  "㊾",
] as const;

/** Numbered house symbols for LLM-optimized spatial reasoning */
export const NUMBERED_HOUSE_PREFIXES = ["H", "h"] as const;

/** Numbered building symbols for LLM-optimized spatial reasoning */
export const NUMBERED_BUILDING_PREFIXES = ["B"] as const;

// ============================================================================
// Building Grid Info & Schema-Driven Symbols
// ============================================================================

/** Tracks a building's position and identity on the ASCII grid */
export interface BuildingGridInfo {
  /** Building ID from the infrastructure data */
  id: string;
  /** Short label shown on the grid (e.g., "B01", "B02") */
  label: string;
  /** All grid cells [col, row] covered by this building */
  cells: [number, number][];
  /** Grid centroid [col, row] of the building footprint */
  centroid: [number, number];
  /** Street-facing edge cell [col, row] nearest to a road, or null */
  entrance: [number, number] | null;
  /** Street address if available */
  address?: string;
  /** Building type */
  type?: string;
  /** Number of floors if available */
  floors?: number;
}

/**
 * Schema-driven symbol configuration for the ASCII grid.
 * When provided, overrides the hardcoded FTTH SYMBOLS for equipment rendering.
 */
export interface GridSymbolConfig {
  /** Map from entity type ID (e.g., "pump_station") → single-char grid symbol */
  entitySymbols: Record<string, string>;
  /** Map from entity type ID → single-char prefix for [X01] annotations */
  annotationPrefixes: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Three-Layer Text Twin Types
// ---------------------------------------------------------------------------

/** Shared grid context created once and reused by all three layers. */
export interface GridContext {
  gw: number;
  gh: number;
  zoneBounds: ZoneBounds;
  metersPerCellX: number;
  metersPerCellY: number;
  cellWidth: number;
  cellHeight: number;
  /** Convert [lng, lat] → [col, row] (row 0 = north/max lat). */
  toGrid: (coord: [number, number]) => [number, number];
}

/** Result from Base Twin generation (pure geography). */
export interface BaseTwinResult {
  /** Formatted ASCII string with headers/borders. */
  grid: string;
  /** Raw 2D character array for programmatic access. */
  rawGrid: string[][];
  /** Building-to-grid mapping with entrance data. */
  buildingPositions: Map<string, BuildingGridInfo>;
  /** Set of "col,row" strings that are road cells. */
  roadCells: Set<string>;
  /** Map from "col,row" → building ID for cells occupied by buildings. */
  buildingCellOwner: Map<string, string>;
}

/** A junction node in the Route Twin corridor topology. */
export interface RouteTwinJunction {
  id: string;
  gridPos: [number, number];
  type: "intersection" | "access_point" | "equipment_site";
  streetName?: string;
}

/** A corridor segment in the Route Twin. */
export interface RouteTwinCorridor {
  id: string;
  fromJunction: string;
  toJunction: string;
  type: "conduit" | "sidewalk" | "road" | "aerial";
  lengthM: number;
  costMultiplier: number;
  capacity?: number;
}

/** Result from Route Twin generation (corridor topology). */
export interface RouteTwinResult {
  /** Formatted ASCII string with headers/borders. */
  grid: string;
  /** Raw 2D character array. */
  rawGrid: string[][];
  /** Junction nodes extracted from routing graph. */
  junctions: RouteTwinJunction[];
  /** Corridor segments extracted from routing graph. */
  corridors: RouteTwinCorridor[];
}

/** Result from Work Twin generation (sparse network overlay). */
export interface WorkTwinResult {
  /** Formatted ASCII string with headers/borders. */
  grid: string;
  /** Raw 2D character array (mostly spaces). */
  rawGrid: string[][];
  /** Equipment ID → [col, row] mapping. */
  equipmentPositions: Map<string, [number, number]>;
}

/** Building registry entry for the JSON companion layer. */
export interface BuildingRegistryEntry {
  id: string;
  type: string;
  floors?: number;
  gridCells: [number, number][];
  entrance: [number, number] | null;
  entranceFacing?: string;
  frontageStreet?: string;
  address?: string;
}

/** Corridor graph entry for the JSON companion layer. */
export interface CorridorGraphEntry {
  id: string;
  name?: string;
  type: "primary" | "secondary" | "residential" | "sidewalk" | "conduit" | "aerial";
  gridCells: [number, number][];
  widthM?: number;
}

/** Combined result from three-layer generation. */
export interface ThreeLayerTwinResult {
  base: BaseTwinResult;
  route: RouteTwinResult;
  work: WorkTwinResult;
  /** Building registry JSON companion. */
  buildingRegistry: Record<string, BuildingRegistryEntry>;
  /** Corridor graph JSON companion. */
  corridorGraph: Record<string, CorridorGraphEntry>;
  /** Composited grid (Work on top of Base, for display). */
  composited: string;
}

/**
 * Build a GridSymbolConfig from an ResolvedDomainBundle.
 * Uses entity iconSymbol when available, falls back to tier-based defaults.
 */
export function buildGridSymbolConfig(schema: {
  entities: Array<{
    id: string;
    iconSymbol?: string;
    tier?: number;
    name: string;
  }>;
  solverConfig?: {
    decisionEntities?: Array<{ entityTypeId: string; role: string }>;
  } | null;
}): GridSymbolConfig {
  const entitySymbols: Record<string, string> = {};
  const annotationPrefixes: Record<string, string> = {};

  // Build role lookup from solver config
  const roleMap = new Map<string, string>();
  if (schema.solverConfig?.decisionEntities) {
    for (const de of schema.solverConfig.decisionEntities) {
      roleMap.set(de.entityTypeId, de.role);
    }
  }

  // Tier/role → fallback symbol
  const roleFallback: Record<string, string> = {
    source: "★",
    hub: "◆",
    distributor: "●",
    endpoint: "○",
  };

  for (const entity of schema.entities) {
    // Symbol: prefer iconSymbol → role fallback → tier fallback → "?"
    if (entity.iconSymbol) {
      entitySymbols[entity.id] = entity.iconSymbol;
    } else {
      const role = roleMap.get(entity.id);
      if (role && roleFallback[role]) {
        entitySymbols[entity.id] = roleFallback[role];
      } else if (entity.tier !== undefined && entity.tier <= 0) {
        entitySymbols[entity.id] = "★";
      } else {
        entitySymbols[entity.id] = "?";
      }
    }

    // Annotation prefix: first char of entity name, uppercased
    const prefix = entity.name.charAt(0).toUpperCase();
    annotationPrefixes[entity.id] = prefix;
  }

  return { entitySymbols, annotationPrefixes };
}

/**
 * Get a numbered symbol for a house based on its index within a zone
 * Uses circled numbers for compact 1-character representation
 * Falls back to [Hnn] format for indices beyond the symbol array
 *
 * @param index - 1-based house index within the zone
 * @returns Single circled number symbol (①) or [Hnn] format for overflow
 */
export function getNumberedHouseSymbol(index: number): string {
  if (index >= 0 && index < NUMBERED_HOUSE_SYMBOLS.length) {
    return NUMBERED_HOUSE_SYMBOLS[index];
  }
  // For houses beyond the symbol array, use [Hnn] format
  return `[H${String(index).padStart(2, "0")}]`;
}

/**
 * Get a numbered symbol for a closure based on its index
 * Falls back to [N] format for indices beyond the symbol array
 */
export function getNumberedClosureSymbol(index: number): string {
  if (index >= 0 && index < NUMBERED_CLOSURE_SYMBOLS.length) {
    return NUMBERED_CLOSURE_SYMBOLS[index];
  }
  return `[${index}]`;
}

/**
 * Cable tier type for FTTH hierarchy
 */
export type CableTierType = "feeder" | "distribution" | "drop";

/**
 * Get cable symbol based on cable tier and direction
 * - Feeder (CO → Cabinet): Double line ═║
 * - Distribution (Cabinet → Closure): Single line ─│
 * - Drop (Closure → Home): Dotted ·:
 *
 * @param cableType - Cable tier type
 * @param direction - "horizontal" or "vertical"
 * @returns Appropriate symbol for ASCII grid
 */
export function getCableSymbolByType(
  cableType: CableTierType,
  direction: "horizontal" | "vertical",
): string {
  const symbols = {
    feeder: {
      horizontal: SYMBOLS.cable_feeder_h,
      vertical: SYMBOLS.cable_feeder_v,
    },
    distribution: {
      horizontal: SYMBOLS.cable_distribution_h,
      vertical: SYMBOLS.cable_distribution_v,
    },
    drop: {
      horizontal: SYMBOLS.cable_drop_h,
      vertical: SYMBOLS.cable_drop_v,
    },
  };
  return symbols[cableType][direction];
}

/**
 * Get infrastructure symbol based on type and direction
 * - Conduit: Dashed ┄┆
 * - Aerial span: Wavy ~∿
 *
 * @param infraType - Infrastructure type
 * @param direction - "horizontal" or "vertical"
 * @returns Appropriate symbol for ASCII grid
 */
export function getInfrastructureSymbol(
  infraType: "conduit" | "aerial_span",
  direction: "horizontal" | "vertical",
): string {
  const symbols = {
    conduit: {
      horizontal: SYMBOLS.conduit_h,
      vertical: SYMBOLS.conduit_v,
    },
    aerial_span: {
      horizontal: SYMBOLS.aerial_span_h,
      vertical: SYMBOLS.aerial_span_v,
    },
  };
  return symbols[infraType][direction];
}

/**
 * Get optical status symbol
 * - ok: ✓ (within budget)
 * - warning: ⚠ (>25dB but <28dB)
 * - critical: ✗ (>28dB)
 *
 * @param status - Optical status
 * @returns Status symbol
 */
export function getOpticalStatusSymbol(status: "ok" | "warning" | "critical"): string {
  const symbols = {
    ok: SYMBOLS.optical_ok,
    warning: SYMBOLS.optical_warning,
    critical: SYMBOLS.optical_critical,
  };
  return symbols[status];
}

/**
 * Determine cable tier type from source and target node types
 *
 * @param sourceType - Source node type
 * @param targetType - Target node type
 * @returns Cable tier type
 */
export function determineCableTier(sourceType: string, targetType: string): CableTierType {
  // CO → Cabinet = Feeder
  if (
    (sourceType === "co" && targetType === "cabinet") ||
    (targetType === "co" && sourceType === "cabinet")
  ) {
    return "feeder";
  }

  // Cabinet → Closure/DEN = Distribution
  if (
    (sourceType === "cabinet" && (targetType === "closure" || targetType === "den")) ||
    (targetType === "cabinet" && (sourceType === "closure" || sourceType === "den"))
  ) {
    return "distribution";
  }

  // Closure/DEN → House = Drop
  if (
    ((sourceType === "closure" || sourceType === "den") && targetType === "house") ||
    ((targetType === "closure" || targetType === "den") && sourceType === "house")
  ) {
    return "drop";
  }

  // Default to distribution for closure-to-closure connections
  return "distribution";
}

/**
 * Extract closure index from node ID
 * Supports both old format (closure-3 → 3) and new standardized format (TLV-A1-CL-001 → 1)
 */
export function extractClosureIndex(nodeId: string): number {
  // Try new standardized format first: [CITY]-[ZONE]-[TYPE]-[SEQ] (e.g., TLV-A1-CL-001)
  const parsed = parseEquipmentId(nodeId);
  if (parsed) {
    return parsed.sequence;
  }

  // Fallback to old format: closure-N or closure_N (e.g., closure-3)
  const match = nodeId.match(/closure-?(\d+)/i);
  if (match) {
    return parseInt(match[1], 10);
  }
  return -1;
}

/**
 * Get grid annotation for equipment in format [SYMBOL+SEQ]
 * Examples: [●01] for closure, [◆01] for cabinet, [★01] for CO
 *
 * @param nodeId - Equipment ID (standardized or legacy format)
 * @param nodeType - Equipment type (closure, cabinet, co, etc.)
 * @returns 5-character annotation like "[●01]" or single symbol if no sequence
 */
export function getEquipmentGridAnnotation(
  nodeId: string,
  nodeType: "co" | "cabinet" | "cabinet-t3" | "closure" | "den" | "house" | "pole",
): string {
  // Get base symbol for equipment type
  const symbolMap: Record<string, string> = {
    co: "★",
    cabinet: "◆",
    "cabinet-t3": "◇", // Hollow diamond for T3/FDH
    closure: "●",
    den: "●",
    house: "○",
    pole: "│",
  };
  const baseSymbol = symbolMap[nodeType] || "?";

  // Get sequence number from standardized ID
  const gridId = getGridId(nodeId); // Returns "01", "02", etc. or "??"

  // Only create annotation for equipment that benefits from numbering
  if (
    nodeType === "co" ||
    nodeType === "cabinet" ||
    nodeType === "cabinet-t3" ||
    nodeType === "closure" ||
    nodeType === "den"
  ) {
    return `[${baseSymbol}${gridId}]`; // "[●01]" format (5 chars)
  }

  // Houses and poles just use single symbol
  return baseSymbol;
}

/**
 * Extract cable sequence number from cable ID
 * Handles various cable ID formats:
 * - Standardized: "TLV-A1-D-001" (drop), "TLV-A1-F-001" (feeder), "TLV-A1-T-001" (distribution/trunk)
 * - Legacy: "drop-5", "feeder-3", "distribution-12", "cable-7"
 *
 * @param cableId - Cable ID string
 * @returns Sequence number or -1 if not found
 */
export function extractCableIndex(cableId: string): number {
  if (!cableId) return -1;

  // Try standardized format: [CITY]-[ZONE]-[TYPE]-[SEQ]
  const standardMatch = cableId.match(/[A-Z]{2,3}-[A-Z]\d+-[DFT]-(\d{3,})$/);
  if (standardMatch) {
    return parseInt(standardMatch[1], 10);
  }

  // Try legacy format: type-N or cable-N
  const legacyMatch = cableId.match(/(?:drop|feeder|distribution|cable|dist)-?(\d+)/i);
  if (legacyMatch) {
    return parseInt(legacyMatch[1], 10);
  }

  // Try any trailing number
  const anyNumber = cableId.match(/(\d+)$/);
  if (anyNumber) {
    return parseInt(anyNumber[1], 10);
  }

  return -1;
}

/**
 * Get grid annotation for cable in format [TYPE+SEQ]
 * Examples: [D01] for drop, [F01] for feeder, [T01] for distribution (trunk)
 *
 * @param cableId - Cable ID (standardized or legacy format)
 * @param cableType - Cable type (drop, feeder, distribution)
 * @returns 5-character annotation like "[D01]" or "[F??]" if no sequence
 */
export function getCableGridAnnotation(
  cableId: string,
  cableType: "drop" | "feeder" | "distribution" | undefined,
): string {
  // Type letter: D=Drop, F=Feeder, T=Trunk/Distribution
  const typeMap: Record<string, string> = {
    drop: "D",
    feeder: "F",
    distribution: "T", // T for Trunk (distribution)
  };
  const typeLetter = typeMap[cableType || "drop"] || "?";

  // Get sequence number
  const seqNum = extractCableIndex(cableId);
  const seqStr = seqNum >= 0 ? String(seqNum).padStart(2, "0") : "??";

  return `[${typeLetter}${seqStr}]`; // "[D01]" format (5 chars)
}

/** Optical loss constants */
const OPTICAL_CONSTANTS = {
  fiberLossPerKm: 0.35,
  connectorLoss: 0.5,
  spliceLoss: 0.1,
  splitterLoss: {
    "1:2": 3.6,
    "1:4": 7.2,
    "1:8": 10.8,
    "1:16": 14.1,
    "1:32": 17.5,
  } as Record<string, number>,
  maxBudget: 28,
};

// ============================================================================
// Zone Division
// ============================================================================

/**
 * Divide a service area into zones
 */
export function divideIntoZones(
  bounds: ZoneBounds,
  zoneSize: { width: number; height: number } = DEFAULT_ZONE_SIZE,
): { zoneGrid: { rows: number; cols: number }; zoneBounds: Map<string, ZoneBounds> } {
  // Calculate service area size in meters
  const widthMeters = haversineDistance(
    [bounds.minLng, bounds.minLat],
    [bounds.maxLng, bounds.minLat],
  );
  const heightMeters = haversineDistance(
    [bounds.minLng, bounds.minLat],
    [bounds.minLng, bounds.maxLat],
  );

  // Calculate number of zones needed
  const cols = Math.ceil(widthMeters / zoneSize.width);
  const rows = Math.ceil(heightMeters / zoneSize.height);

  // Calculate actual zone size in degrees
  const lngPerZone = (bounds.maxLng - bounds.minLng) / cols;
  const latPerZone = (bounds.maxLat - bounds.minLat) / rows;

  // Generate zone bounds
  const zoneBounds = new Map<string, ZoneBounds>();

  for (let row = 0; row < rows; row++) {
    const rowLetter = String.fromCharCode(65 + row); // A, B, C, ...

    for (let col = 0; col < cols; col++) {
      const zoneId = `${rowLetter}${col + 1}`;

      zoneBounds.set(zoneId, {
        minLng: bounds.minLng + col * lngPerZone,
        maxLng: bounds.minLng + (col + 1) * lngPerZone,
        minLat: bounds.maxLat - (row + 1) * latPerZone, // North to South
        maxLat: bounds.maxLat - row * latPerZone,
      });
    }
  }

  return {
    zoneGrid: { rows, cols },
    zoneBounds,
  };
}

/**
 * Get zone ID for a coordinate
 */
export function getZoneForCoordinate(
  coord: [number, number],
  bounds: ZoneBounds,
  zoneGrid: { rows: number; cols: number },
): string | null {
  const [lng, lat] = coord;

  if (lng < bounds.minLng || lng > bounds.maxLng || lat < bounds.minLat || lat > bounds.maxLat) {
    return null;
  }

  const lngPerZone = (bounds.maxLng - bounds.minLng) / zoneGrid.cols;
  const latPerZone = (bounds.maxLat - bounds.minLat) / zoneGrid.rows;

  const col = Math.min(Math.floor((lng - bounds.minLng) / lngPerZone), zoneGrid.cols - 1);
  const row = Math.min(Math.floor((bounds.maxLat - lat) / latPerZone), zoneGrid.rows - 1);

  const rowLetter = String.fromCharCode(65 + row);
  return `${rowLetter}${col + 1}`;
}

/**
 * Get adjacent zone IDs
 */
export function getAdjacentZones(
  zoneId: string,
  zoneGrid: { rows: number; cols: number },
): AdjacentZones {
  const row = zoneId.charCodeAt(0) - 65;
  const col = parseInt(zoneId.slice(1), 10) - 1;

  const adjacent: AdjacentZones = {};

  if (row > 0) {
    adjacent.north = `${String.fromCharCode(64 + row)}${col + 1}`;
  }
  if (row < zoneGrid.rows - 1) {
    adjacent.south = `${String.fromCharCode(66 + row)}${col + 1}`;
  }
  if (col > 0) {
    adjacent.west = `${String.fromCharCode(65 + row)}${col}`;
  }
  if (col < zoneGrid.cols - 1) {
    adjacent.east = `${String.fromCharCode(65 + row)}${col + 2}`;
  }

  return adjacent;
}

// ============================================================================
// Three-Layer Text Twin — Shared Utilities
// ============================================================================

/**
 * Create a shared grid context for coordinate conversion and dimensions.
 * All three layers use the same context so cells align perfectly.
 */
export function createGridContext(
  zoneBounds: ZoneBounds,
  gridWidth?: number,
  gridHeight?: number,
): GridContext {
  const gw = gridWidth ?? GRID_WIDTH;
  const gh = gridHeight ?? GRID_HEIGHT;

  const centerLat = (zoneBounds.minLat + zoneBounds.maxLat) / 2;
  const widthMeters = haversineDistance(
    [zoneBounds.minLng, centerLat],
    [zoneBounds.maxLng, centerLat],
  );
  const heightMeters = haversineDistance(
    [zoneBounds.minLng, zoneBounds.minLat],
    [zoneBounds.minLng, zoneBounds.maxLat],
  );

  const metersPerCellX = widthMeters / gw;
  const metersPerCellY = heightMeters / gh;
  const cellWidth = (zoneBounds.maxLng - zoneBounds.minLng) / gw;
  const cellHeight = (zoneBounds.maxLat - zoneBounds.minLat) / gh;

  const toGrid = (coord: [number, number]): [number, number] => {
    const x = Math.floor((coord[0] - zoneBounds.minLng) / cellWidth);
    const y = gh - 1 - Math.floor((coord[1] - zoneBounds.minLat) / cellHeight);
    return [Math.max(0, Math.min(gw - 1, x)), Math.max(0, Math.min(gh - 1, y))];
  };

  return { gw, gh, zoneBounds, metersPerCellX, metersPerCellY, cellWidth, cellHeight, toGrid };
}

/** Create an empty gw × gh grid filled with the given character. */
function createEmptyGrid(gw: number, gh: number, fill: string = SYMBOLS.empty): string[][] {
  return Array(gh)
    .fill(null)
    .map(() => Array(gw).fill(fill));
}

/**
 * Format a raw 2D character grid into an ASCII string with column headers,
 * row labels, and borders. Shared by all three layers.
 */
export function formatGridToAscii(
  rawGrid: string[][],
  gw: number,
  gh: number,
  header?: string,
): string {
  const lines: string[] = [];

  if (header) {
    lines.push(`// ${header}`);
  }

  const colHeader = `    ${Array.from({ length: Math.ceil(gw / 10) }, (_, i) => String(i).padEnd(10)).join("")}`;
  lines.push(colHeader);

  const colNumbers = `    ${Array.from({ length: gw }, (_, i) => String(i % 10)).join("")}`;
  lines.push(colNumbers);

  lines.push(`   ┌${"─".repeat(gw)}┐`);

  for (let y = 0; y < gh; y++) {
    const rowLabel = String.fromCharCode(65 + (y % 26));
    lines.push(` ${rowLabel} │${rawGrid[y].join("")}│`);
  }

  lines.push(`   └${"─".repeat(gw)}┘`);

  return lines.join("\n");
}

// ============================================================================
// Base Twin — Pure geography layer (roads, sidewalks, buildings, street labels)
// ============================================================================

/**
 * Generate the Base Twin — a pure geographic grid with NO network equipment.
 *
 * Contains:
 * - Roads with direction-aware symbols (═ horizontal, ║ vertical, ╬ crossing)
 * - Sidewalks (░ buffer around buildings)
 * - Building footprints with IDs (▓B01▓) and entrance markers (▸)
 * - Street name labels (never overwritten because no equipment exists)
 *
 * Replicates phases 1, 2, 3, and 6b from generateZoneAsciiGrid() but produces
 * a clean geographic canvas with no network overlay.
 */
export function generateBaseTwin(
  ctx: GridContext,
  infrastructure: {
    roads?: InfrastructureRoad[];
    buildings?: InfrastructureBuilding[];
  },
  debug: boolean = false,
): BaseTwinResult {
  const { gw, gh, zoneBounds, toGrid } = ctx;
  const grid = createEmptyGrid(gw, gh);

  // Track road cells for entrance detection
  const roadCells = new Set<string>();
  // Per-building cell tracking
  const buildingCellOwner = new Map<string, string>();
  const buildingCellLists = new Map<string, [number, number][]>();
  // Building position results
  const buildingPositions = new Map<string, BuildingGridInfo>();

  // Helper: determine road direction symbol from geographic bearing
  const getRoadSymbol = (from: [number, number], to: [number, number]): string => {
    const dx = Math.abs(to[0] - from[0]);
    const dy = Math.abs(to[1] - from[1]);
    return dx >= dy ? SYMBOLS.road_h : SYMBOLS.road_v;
  };

  // ── Phase 1: Roads ────────────────────────────────────────────────────
  if (infrastructure.roads) {
    for (const road of infrastructure.roads) {
      if (!road.coordinates || road.coordinates.length < 2) continue;
      for (let i = 0; i < road.coordinates.length - 1; i++) {
        const from = toGrid(road.coordinates[i]);
        const to = toGrid(road.coordinates[i + 1]);
        const symbol = getRoadSymbol(road.coordinates[i], road.coordinates[i + 1]);
        drawLineWithSymbol(grid, from, to, symbol, gw, gh);
      }
    }
    // Record all road cells after drawing
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        const c = grid[y][x];
        if (
          c === SYMBOLS.road_h ||
          c === SYMBOLS.road_v ||
          c === SYMBOLS.road_cross ||
          c === SYMBOLS.road_corner_ne ||
          c === SYMBOLS.road_corner_nw ||
          c === SYMBOLS.road_corner_se ||
          c === SYMBOLS.road_corner_sw
        ) {
          roadCells.add(`${x},${y}`);
        }
      }
    }
  }

  // ── Phase 2: Sidewalks ────────────────────────────────────────────────
  if (infrastructure.buildings) {
    // First pass: identify all building cells
    const buildingCellSet = new Set<string>();
    for (const building of infrastructure.buildings) {
      const thisCells: [number, number][] = [];
      if (building.coordinates && building.coordinates.length > 0) {
        for (const ring of building.coordinates) {
          if (ring.length >= 3) {
            const gridPolygon: [number, number][] = ring.map((coord) => toGrid(coord));
            const minX = Math.max(0, Math.floor(Math.min(...gridPolygon.map((p) => p[0]))));
            const maxX = Math.min(gw - 1, Math.ceil(Math.max(...gridPolygon.map((p) => p[0]))));
            const minY = Math.max(0, Math.floor(Math.min(...gridPolygon.map((p) => p[1]))));
            const maxY = Math.min(gh - 1, Math.ceil(Math.max(...gridPolygon.map((p) => p[1]))));
            for (let y = minY; y <= maxY; y++) {
              for (let x = minX; x <= maxX; x++) {
                if (pointInPolygon(x, y, gridPolygon)) {
                  buildingCellSet.add(`${x},${y}`);
                  thisCells.push([x, y]);
                  buildingCellOwner.set(`${x},${y}`, building.id);
                }
              }
            }
          }
        }
      }
      // Fallback: use centroid if no polygon fill
      if (thisCells.length === 0 && building.center) {
        const [cx, cy] = toGrid(building.center);
        buildingCellSet.add(`${cx},${cy}`);
        thisCells.push([cx, cy]);
        buildingCellOwner.set(`${cx},${cy}`, building.id);
      }
      buildingCellLists.set(building.id, thisCells);
    }

    // Draw sidewalks: 2-cell buffer around building footprints
    const SIDEWALK_WIDTH = 2;
    for (const key of buildingCellSet) {
      const [bx, by] = key.split(",").map(Number);
      for (let dy = -SIDEWALK_WIDTH; dy <= SIDEWALK_WIDTH; dy++) {
        for (let dx = -SIDEWALK_WIDTH; dx <= SIDEWALK_WIDTH; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = bx + dx;
          const ny = by + dy;
          if (nx >= 0 && nx < gw && ny >= 0 && ny < gh) {
            const cellKey = `${nx},${ny}`;
            if (!buildingCellSet.has(cellKey) && grid[ny][nx] === SYMBOLS.empty) {
              grid[ny][nx] = SYMBOLS.sidewalk;
            }
          }
        }
      }
    }

    // ── Phase 3: Building footprints with IDs and entrances ─────────────
    for (let bIdx = 0; bIdx < infrastructure.buildings.length; bIdx++) {
      const building = infrastructure.buildings[bIdx];
      const cells = buildingCellLists.get(building.id) ?? [];

      // Fill building footprint
      if (building.coordinates && building.coordinates.length > 0) {
        for (const ring of building.coordinates) {
          if (ring.length >= 3) {
            const gridPolygon: [number, number][] = ring.map((coord) => toGrid(coord));
            fillPolygon(
              grid,
              gridPolygon,
              SYMBOLS.building,
              [SYMBOLS.empty, SYMBOLS.sidewalk],
              gw,
              gh,
            );
          }
        }
      } else if (building.center) {
        // Fallback: single cell for point buildings
        const [cx, cy] = toGrid(building.center);
        if (cx >= 0 && cx < gw && cy >= 0 && cy < gh) {
          grid[cy][cx] = SYMBOLS.building;
        }
      }

      // Embed building ID label inside footprint
      const label = `B${String(bIdx + 1).padStart(2, "0")}`;
      // Compute centroid
      let centroidX = 0;
      let centroidY = 0;
      if (cells.length > 0) {
        for (const [cx, cy] of cells) {
          centroidX += cx;
          centroidY += cy;
        }
        centroidX = Math.round(centroidX / cells.length);
        centroidY = Math.round(centroidY / cells.length);
      } else if (building.center) {
        [centroidX, centroidY] = toGrid(building.center);
      }

      // Try to place label centered within building footprint
      if (cells.length >= 4) {
        // Find horizontal extent at centroid row for centering
        let minXAtRow = gw;
        let maxXAtRow = 0;
        for (const [cx, cy] of cells) {
          if (cy === centroidY) {
            minXAtRow = Math.min(minXAtRow, cx);
            maxXAtRow = Math.max(maxXAtRow, cx);
          }
        }
        const labelStart = Math.floor((minXAtRow + maxXAtRow - label.length + 1) / 2);
        for (let i = 0; i < label.length; i++) {
          const lx = labelStart + i;
          if (lx >= 0 && lx < gw && grid[centroidY]?.[lx] === SYMBOLS.building) {
            grid[centroidY][lx] = label[i];
          }
        }
      } else if (cells.length >= 1) {
        // Small building: single marker at centroid
        const numStr = String(bIdx + 1);
        if (grid[centroidY]?.[centroidX] === SYMBOLS.building) {
          grid[centroidY][centroidX] = numStr.length === 1 ? numStr : numStr[numStr.length - 1];
        }
      }

      // Detect entrance: building edge cell closest to any road cell
      let entrance: [number, number] | null = null;
      let minRoadDist = Infinity;
      for (const [cx, cy] of cells) {
        const isEdge =
          !buildingCellOwner.has(`${cx - 1},${cy}`) ||
          buildingCellOwner.get(`${cx - 1},${cy}`) !== building.id ||
          !buildingCellOwner.has(`${cx + 1},${cy}`) ||
          buildingCellOwner.get(`${cx + 1},${cy}`) !== building.id ||
          !buildingCellOwner.has(`${cx},${cy - 1}`) ||
          buildingCellOwner.get(`${cx},${cy - 1}`) !== building.id ||
          !buildingCellOwner.has(`${cx},${cy + 1}`) ||
          buildingCellOwner.get(`${cx},${cy + 1}`) !== building.id;
        if (!isEdge) continue;

        for (let rdy = -10; rdy <= 10; rdy++) {
          for (let rdx = -10; rdx <= 10; rdx++) {
            const dist = Math.abs(rdx) + Math.abs(rdy);
            if (dist >= minRoadDist) continue;
            if (roadCells.has(`${cx + rdx},${cy + rdy}`)) {
              minRoadDist = dist;
              entrance = [cx, cy];
            }
          }
        }
      }

      // Mark entrance on grid with ▸ symbol
      if (entrance) {
        const [ex, ey] = entrance;
        if (grid[ey]?.[ex] === SYMBOLS.building) {
          grid[ey][ex] = "▸";
        }
      }

      // Determine entrance facing direction
      let entranceFacing: string | undefined;
      if (entrance) {
        const [ex, ey] = entrance;
        if (centroidY > 0 && cells.length > 0) {
          const dex = ex - centroidX;
          const dey = ey - centroidY;
          if (Math.abs(dex) > Math.abs(dey)) {
            entranceFacing = dex > 0 ? "east" : "west";
          } else {
            entranceFacing = dey > 0 ? "south" : "north";
          }
        }
      }

      buildingPositions.set(building.id, {
        id: building.id,
        label,
        cells,
        centroid: [centroidX, centroidY],
        entrance,
        address: building.address,
        type: building.type,
        floors: building.floors,
        entranceFacing,
      });
    }
  }

  // ── Phase 6b: Street labels ───────────────────────────────────────────
  // Labels are placed on the Base Twin and never overwritten (no equipment here)
  if (infrastructure.roads && infrastructure.roads.length > 0) {
    const streetLabelResult = addStreetLabelsToGrid(grid, infrastructure.roads, zoneBounds, gw, gh);
    if (debug && streetLabelResult.streetLabels.length > 0) {
      console.log(
        `[Base Twin] Added ${streetLabelResult.streetLabels.length} street labels:`,
        streetLabelResult.streetLabels.map((l) => l.name),
      );
    }
  }

  // Build zone metadata header
  const buildingCount = infrastructure.buildings?.length ?? 0;
  const streetCount = infrastructure.roads
    ? new Set(infrastructure.roads.map((r) => r.name).filter(Boolean)).size
    : 0;
  const resH = ctx.metersPerCellX.toFixed(1);
  const resV = ctx.metersPerCellY.toFixed(1);
  const header = `Base Twin | ${gw}x${gh} | ${buildingCount} buildings | ${streetCount} streets | ~${resH}m/cell H, ~${resV}m/cell V`;

  return {
    grid: formatGridToAscii(grid, gw, gh, header),
    rawGrid: grid,
    buildingPositions,
    roadCells,
    buildingCellOwner,
  };
}

// ============================================================================
// Route Twin Generation (corridor topology for routing)
// ============================================================================

/** Path type → ASCII corridor symbol mapping. */
const CORRIDOR_SYMBOLS: Record<string, string> = {
  conduit: "┄",
  sidewalk: "░",
  road_crossing: "╳",
  aerial_span: "~",
};

/** Node type → junction symbol priority (higher = more important). */
const JUNCTION_PRIORITY: Record<string, number> = {
  intersection: 3,
  pole: 2,
  handhole: 2,
  conduit_access: 1,
  street: 0,
};

/**
 * Generate the Route Twin — a corridor topology layer for routing decisions.
 *
 * Unlike the Base Twin (pure geography) and Work Twin (placed equipment),
 * the Route Twin shows WHERE cables/pipes CAN be routed:
 * - Junction nodes (◎Jxx) at graph intersections and access points
 * - Corridor segments with type-specific symbols (conduit ┄, sidewalk ░, road ═, aerial ~)
 * - Building no-go zones (▒) where routing is impossible
 *
 * The Route Twin is generated from a RoutingGraph — it is entirely NEW data,
 * not a refactor of existing phases.
 */
export function generateRouteTwin(
  ctx: GridContext,
  routingGraph: RoutingGraph,
  baseContext?: {
    roadCells?: Set<string>;
    buildingCellOwner?: Map<string, string>;
  },
): RouteTwinResult {
  const { gw, gh, zoneBounds, toGrid } = ctx;
  const grid = createEmptyGrid(gw, gh);

  const junctions: RouteTwinJunction[] = [];
  const corridors: RouteTwinCorridor[] = [];

  // ── Phase R1: Mark building no-go zones ──────────────────────────────
  // If we have building cell data from the Base Twin, mark those cells
  // as ▒ so the agent can see where routing is blocked.
  if (baseContext?.buildingCellOwner) {
    for (const key of baseContext.buildingCellOwner.keys()) {
      const [colStr, rowStr] = key.split(",");
      const col = Number.parseInt(colStr, 10);
      const row = Number.parseInt(rowStr, 10);
      if (col >= 0 && col < gw && row >= 0 && row < gh) {
        grid[row][col] = "▒";
      }
    }
  }

  // ── Phase R2: Identify junctions from routing graph nodes ────────────
  // A junction is a routing graph node that falls within this zone's bounds.
  // We assign sequential IDs (J01, J02, ...) and classify by node type.

  /** Map from routing graph node ID → junction ID (e.g., "J01") */
  const nodeToJunction = new Map<string, string>();
  /** Map from routing graph node ID → grid [col, row] */
  const nodeToGridPos = new Map<string, [number, number]>();

  // Collect all in-zone nodes and sort by priority (intersections first)
  const inZoneNodes: Array<{ nodeId: string; node: RoutingNode; gridPos: [number, number] }> = [];

  for (const [nodeId, node] of routingGraph.nodes) {
    const [lng, lat] = node.position;
    // Check if node is within zone bounds
    if (
      lng >= zoneBounds.minLng &&
      lng <= zoneBounds.maxLng &&
      lat >= zoneBounds.minLat &&
      lat <= zoneBounds.maxLat
    ) {
      const [col, row] = toGrid([lng, lat]);
      if (col >= 0 && col < gw && row >= 0 && row < gh) {
        inZoneNodes.push({ nodeId, node, gridPos: [col, row] });
      }
    }
  }

  // Sort by priority so intersections get lower IDs
  inZoneNodes.sort((a, b) => {
    const pa = JUNCTION_PRIORITY[a.node.type] ?? 0;
    const pb = JUNCTION_PRIORITY[b.node.type] ?? 0;
    return pb - pa; // higher priority first
  });

  // Deduplicate: only one junction per grid cell (highest priority wins)
  const cellToJunction = new Map<string, string>();
  let junctionCounter = 0;

  for (const { nodeId, node, gridPos } of inZoneNodes) {
    const [col, row] = gridPos;
    const cellKey = `${col},${row}`;

    // Skip if this cell already has a junction
    if (cellToJunction.has(cellKey)) {
      // Still map this node to the existing junction for corridor resolution
      const existingJId = cellToJunction.get(cellKey)!;
      nodeToJunction.set(nodeId, existingJId);
      nodeToGridPos.set(nodeId, gridPos);
      continue;
    }

    junctionCounter++;
    const jId = `J${String(junctionCounter).padStart(2, "0")}`;
    nodeToJunction.set(nodeId, jId);
    nodeToGridPos.set(nodeId, gridPos);
    cellToJunction.set(cellKey, jId);

    // Classify junction type
    let jType: RouteTwinJunction["type"] = "access_point";
    if (node.type === "intersection") {
      jType = "intersection";
    } else if (node.type === "pole" || node.type === "handhole") {
      jType = "equipment_site";
    }

    junctions.push({
      id: jId,
      gridPos: [col, row],
      type: jType,
      streetName: node.streetName,
    });

    // Render junction on grid: ◎Jxx
    // Place the ◎ symbol at the junction cell, and try to fit the ID label
    grid[row][col] = "◎";
    // Place label to the right if there's room and the cells are empty
    const label = jId;
    let placed = false;
    if (col + label.length < gw) {
      let canPlace = true;
      for (let k = 0; k < label.length; k++) {
        if (grid[row][col + 1 + k] !== " ") {
          canPlace = false;
          break;
        }
      }
      if (canPlace) {
        for (let k = 0; k < label.length; k++) {
          grid[row][col + 1 + k] = label[k];
        }
        placed = true;
      }
    }
    // If can't place to the right, try below
    if (!placed && row + 1 < gh) {
      let canPlace = true;
      for (let k = 0; k < Math.min(label.length, gw - col); k++) {
        if (grid[row + 1][col + k] !== " ") {
          canPlace = false;
          break;
        }
      }
      if (canPlace) {
        for (let k = 0; k < Math.min(label.length, gw - col); k++) {
          grid[row + 1][col + k] = label[k];
        }
      }
    }
  }

  // ── Phase R3: Draw corridor segments from routing graph edges ────────
  // Each edge becomes a corridor with type-specific symbols drawn between
  // its endpoint junctions. Only edges where BOTH endpoints are in-zone
  // (or at least mappable) get drawn.

  let corridorCounter = 0;

  for (const [_edgeId, edge] of routingGraph.edges) {
    const fromGridPos = nodeToGridPos.get(edge.fromNodeId);
    const toGridPos = nodeToGridPos.get(edge.toNodeId);

    // Skip edges where either endpoint is outside this zone
    if (!fromGridPos || !toGridPos) continue;

    const fromJId = nodeToJunction.get(edge.fromNodeId);
    const toJId = nodeToJunction.get(edge.toNodeId);
    if (!fromJId || !toJId) continue;
    // Skip self-loops (both endpoints map to same grid cell)
    if (fromJId === toJId) continue;

    corridorCounter++;
    const cId = `C${String(corridorCounter).padStart(2, "0")}`;

    // Map edge pathType to corridor type
    let corridorType: RouteTwinCorridor["type"] = "sidewalk";
    if (edge.pathType === "conduit") corridorType = "conduit";
    else if (edge.pathType === "aerial_span") corridorType = "aerial";
    else if (edge.pathType === "road_crossing") corridorType = "road";

    // Use underground cost as default cost multiplier
    const costMult = edge.costs.underground / Math.max(edge.distance, 0.1);

    corridors.push({
      id: cId,
      fromJunction: fromJId,
      toJunction: toJId,
      type: corridorType,
      lengthM: edge.distance,
      costMultiplier: Math.round(costMult * 100) / 100,
    });

    // Draw the corridor line on the grid using Bresenham-like traversal
    const sym = CORRIDOR_SYMBOLS[edge.pathType] ?? "─";
    const [c0, r0] = fromGridPos;
    const [c1, r1] = toGridPos;

    // Simple Bresenham line between the two endpoints
    const dc = Math.abs(c1 - c0);
    const dr = Math.abs(r1 - r0);
    const sc = c0 < c1 ? 1 : -1;
    const sr = r0 < r1 ? 1 : -1;
    let err = dc - dr;
    let cx = c0;
    let cy = r0;

    // Maximum iterations to prevent infinite loops on degenerate cases
    const maxSteps = dc + dr + 2;
    let steps = 0;

    while (steps < maxSteps) {
      // Don't overwrite junction symbols or building no-go zones
      if (cx >= 0 && cx < gw && cy >= 0 && cy < gh) {
        const existing = grid[cy][cx];
        if (existing === " " || existing === "·") {
          grid[cy][cx] = sym;
        }
      }

      if (cx === c1 && cy === r1) break;

      const e2 = 2 * err;
      if (e2 > -dr) {
        err -= dr;
        cx += sc;
      }
      if (e2 < dc) {
        err += dc;
        cy += sr;
      }
      steps++;
    }
  }

  // ── Phase R4: Build zone metadata header ─────────────────────────────
  const header = `Route Twin | ${gw}x${gh} | ${junctions.length} junctions | ${corridors.length} corridors`;

  return {
    grid: formatGridToAscii(grid, gw, gh, header),
    rawGrid: grid,
    junctions,
    corridors,
  };
}

// ============================================================================
// Step 5 — Work Twin (Sparse Network Overlay)
// ============================================================================

/**
 * Generate a sparse Work Twin overlay for a zone.
 *
 * The Work Twin contains ONLY network equipment, cables, and cross-zone link
 * annotations — no geography. It mirrors DeckGL data layers rendered on top of
 * a basemap. Most cells are empty (space). The agent reads the Work Twin to
 * understand what equipment is placed, where cables run, and what's connected.
 *
 * Phases:
 *   W1 — Draw cables with direction-aware symbols and midpoint annotations
 *   W2 — Draw equipment sorted by rendering priority (houses first, closures last)
 *   W3 — Mark cross-zone link arrows at zone boundary edges
 *   W4 — Build zone metadata header
 */
export function generateWorkTwin(
  ctx: GridContext,
  nodes: ZoneEquipment[],
  cables: ZoneFeature[],
  crossZoneLinks: CrossZoneLink[],
  issues: ZoneIssue[],
  symbolConfig?: GridSymbolConfig,
): WorkTwinResult {
  const { gw, gh, toGrid } = ctx;

  // Sparse grid — mostly whitespace
  const grid = createEmptyGrid(gw, gh);

  // Track equipment positions for downstream consumers
  const equipmentPositions = new Map<string, [number, number]>();

  // ── Phase W1: Draw cables ─────────────────────────────────────────────
  // Track which cells have cables (for composite symbol detection)
  const cableLayer = new Set<string>();
  // Track cable endpoints (source/target node positions)
  const cableEndpoints = new Set<string>();
  // Track cable midpoints for annotation placement
  const cableMidpoints: Array<{
    cableId: string;
    cableType: "drop" | "feeder" | "distribution" | undefined;
    midpoint: [number, number];
  }> = [];

  for (const cable of cables) {
    if (cable.geometry.type !== "LineString") continue;

    const coords = cable.geometry.coordinates as [number, number][];
    const cableType = cable.properties.cableType as "drop" | "feeder" | "distribution" | undefined;

    // Direction-aware cable symbol selection
    // (For the Work Twin we use simpler symbols since there are no roads to composite with)
    const hSymbol =
      cableType === "feeder"
        ? SYMBOLS.cable_feeder_h
        : cableType === "distribution"
          ? SYMBOLS.cable_distribution_h
          : SYMBOLS.cable_drop_h;
    const vSymbol =
      cableType === "feeder"
        ? SYMBOLS.cable_feeder_v
        : cableType === "distribution"
          ? SYMBOLS.cable_distribution_v
          : SYMBOLS.cable_drop_v;

    // Track endpoints
    if (coords.length >= 2) {
      const [startX, startY] = toGrid(coords[0]);
      const [endX, endY] = toGrid(coords[coords.length - 1]);
      cableEndpoints.add(`${startX},${startY}`);
      cableEndpoints.add(`${endX},${endY}`);

      // Calculate midpoint for annotation
      let midCoord: [number, number];
      if (coords.length > 2) {
        const midIdx = Math.floor(coords.length / 2);
        midCoord = coords[midIdx];
      } else {
        midCoord = [(coords[0][0] + coords[1][0]) / 2, (coords[0][1] + coords[1][1]) / 2];
      }
      cableMidpoints.push({
        cableId: cable.id,
        cableType,
        midpoint: toGrid(midCoord),
      });
    }

    // Draw cable segments using Bresenham with direction-aware symbols
    for (let i = 0; i < coords.length - 1; i++) {
      drawWorkTwinCableLine(
        grid,
        toGrid(coords[i]),
        toGrid(coords[i + 1]),
        hSymbol,
        vSymbol,
        cableLayer,
        gw,
        gh,
      );
    }
  }

  // W1b: Cable ID annotations at midpoints (skip drops — too numerous)
  for (const cableMid of cableMidpoints) {
    if (cableMid.cableType === "drop") continue;

    const [x, y] = cableMid.midpoint;
    const annotation = getCableGridAnnotation(cableMid.cableId, cableMid.cableType);

    // Write 5-char annotation; only overwrite empty or cable cells
    for (let i = 0; i < annotation.length && x + i < gw; i++) {
      const currentCell = grid[y]?.[x + i];
      if (
        currentCell === SYMBOLS.empty ||
        currentCell === SYMBOLS.cable_drop_h ||
        currentCell === SYMBOLS.cable_drop_v ||
        currentCell === SYMBOLS.cable_feeder_h ||
        currentCell === SYMBOLS.cable_feeder_v ||
        currentCell === SYMBOLS.cable_distribution_h ||
        currentCell === SYMBOLS.cable_distribution_v ||
        currentCell === SYMBOLS.cable_drop ||
        currentCell === SYMBOLS.cable_underground ||
        currentCell === SYMBOLS.cable_aerial
      ) {
        grid[y][x + i] = annotation[i];
      }
    }
  }

  // ── Phase W2: Draw equipment (top layer) ──────────────────────────────
  // Priority order: houses (0) drawn first → closures (4) drawn last
  const nodePriority = (type: string): number => {
    switch (type) {
      case "house":
        return 0;
      case "pole":
        return 1;
      case "cabinet":
        return 2;
      case "co":
        return 3;
      case "closure":
      case "den":
        return 4;
      default:
        return 0;
    }
  };
  const sortedNodes = [...nodes].sort((a, b) => nodePriority(a.type) - nodePriority(b.type));

  // Schema-driven symbol resolution with FTTH fallback
  const resolveSymbol = (nodeType: string): string => {
    if (symbolConfig?.entitySymbols[nodeType]) {
      return symbolConfig.entitySymbols[nodeType];
    }
    const sym = SYMBOLS[nodeType as keyof typeof SYMBOLS];
    return typeof sym === "string" ? sym : "?";
  };

  // Build house index map for numbered symbols (①②③…)
  const houseNodes = nodes.filter((n) => n.type === "house");
  const houseIndexMap = new Map<string, number>();
  houseNodes.forEach((house, index) => {
    houseIndexMap.set(house.id, index + 1);
  });

  // Set of nodes with issues (renders × symbol)
  const issueNodeIds = new Set(issues.filter((i) => i.nodeId).map((i) => i.nodeId));

  for (const node of sortedNodes) {
    const [x, y] = toGrid(node.coordinates);
    equipmentPositions.set(node.id, [x, y]);

    const hasIssue = issueNodeIds.has(node.id);

    // Determine if this equipment type gets multi-character annotation
    const isAnnotatedEquipment = symbolConfig
      ? node.type !== "house" && node.type !== "pole" && !!symbolConfig.entitySymbols[node.type]
      : node.type === "co" ||
        node.type === "cabinet" ||
        node.type === "cabinet-t3" ||
        node.type === "closure" ||
        node.type === "den";

    if (hasIssue) {
      grid[y][x] = SYMBOLS.error;
    } else if (isAnnotatedEquipment) {
      const sym = resolveSymbol(node.type);
      const gridId = getGridId(node.id);
      const annotation = `[${sym}${gridId}]`;
      for (let i = 0; i < annotation.length && x + i < gw; i++) {
        grid[y][x + i] = annotation[i];
      }
    } else if (node.type === "house") {
      const houseIndex = houseIndexMap.get(node.id) || 0;
      grid[y][x] = getNumberedHouseSymbol(houseIndex);
    } else {
      grid[y][x] = resolveSymbol(node.type);
    }
  }

  // ── Phase W3: Cross-zone link arrows ──────────────────────────────────
  for (const link of crossZoneLinks) {
    if (link.sourceZone === link.targetZone) continue;

    let x: number;
    let y: number;
    let symbol: string;

    switch (link.direction) {
      case "east":
        x = gw - 1;
        y = Math.floor(gh / 2);
        symbol = "→";
        break;
      case "west":
        x = 0;
        y = Math.floor(gh / 2);
        symbol = "←";
        break;
      case "north":
        x = Math.floor(gw / 2);
        y = 0;
        symbol = "↑";
        break;
      case "south":
        x = Math.floor(gw / 2);
        y = gh - 1;
        symbol = "↓";
        break;
    }

    grid[y][x] = symbol;
  }

  // ── Phase W4: Metadata header ─────────────────────────────────────────
  const equipCount = nodes.filter((n) => n.type !== "house" && n.type !== "pole").length;
  const houseCount = houseNodes.length;
  const cableCount = cables.length;
  const header = `Work Twin | ${gw}x${gh} | ${equipCount} equip | ${houseCount} houses | ${cableCount} cables`;

  return {
    grid: formatGridToAscii(grid, gw, gh, header),
    rawGrid: grid,
    equipmentPositions,
  };
}

// ---------------------------------------------------------------------------
// Work Twin helper — Bresenham cable line with direction-aware symbols
// ---------------------------------------------------------------------------

/**
 * Draw a cable line on a sparse Work Twin grid.
 *
 * Unlike `drawLineWithCableTracking` (used by the original single-grid generator),
 * this version does NOT produce composite road/building symbols because the Work
 * Twin has no roads or buildings — it's a sparse overlay. Instead it:
 *   1. Picks horizontal or vertical cable symbol based on Bresenham step direction.
 *   2. Tracks all cable positions in `cableLayer` for later use.
 *   3. Never overwrites existing equipment characters.
 */
function drawWorkTwinCableLine(
  grid: string[][],
  from: [number, number],
  to: [number, number],
  hChar: string,
  vChar: string,
  cableLayer: Set<string>,
  gw: number,
  gh: number,
): void {
  let [x0, y0] = from;
  const [x1, y1] = to;

  // Bounds check
  if (y0 < 0 || y0 >= gh || x0 < 0 || x0 >= gw) return;
  if (y1 < 0 || y1 >= gh || x1 < 0 || x1 >= gw) return;

  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;

  while (true) {
    if (y0 >= 0 && y0 < gh && x0 >= 0 && x0 < gw) {
      const cellKey = `${x0},${y0}`;
      cableLayer.add(cellKey);

      const currentCell = grid[y0][x0];
      // Only draw on empty cells — don't overwrite equipment or annotations
      if (currentCell === SYMBOLS.empty) {
        // Pick symbol based on step direction: more horizontal → hChar, else vChar
        grid[y0][x0] = dx >= dy ? hChar : vChar;
      }
    }

    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      x0 += sx;
    }
    if (e2 < dx) {
      err += dx;
      y0 += sy;
    }
  }
}

// ---------------------------------------------------------------------------
// Step 6: JSON Companion Data Generators
// ---------------------------------------------------------------------------

/**
 * Build a Building Registry from the Base Twin's building positions.
 *
 * Maps building short labels (e.g., "B01") to structured entries with
 * grid cells, entrance location, frontage street, and building metadata.
 * The registry gives the AI agent a JSON-queryable representation of
 * every building in the zone without having to parse the ASCII grid.
 */
export function buildBuildingRegistry(
  baseTwin: BaseTwinResult,
  infrastructure: {
    roads?: InfrastructureRoad[];
    buildings?: InfrastructureBuilding[];
  },
): Record<string, BuildingRegistryEntry> {
  const registry: Record<string, BuildingRegistryEntry> = {};

  for (const [buildingId, info] of baseTwin.buildingPositions) {
    // Find the original InfrastructureBuilding to get extra metadata
    const srcBuilding = infrastructure.buildings?.find((b) => b.id === buildingId);

    // Determine frontage street: find the road cell closest to the entrance
    let frontageStreet: string | undefined;
    if (info.entrance && infrastructure.roads) {
      frontageStreet = findClosestRoadName(
        info.entrance,
        baseTwin.roadCells,
        baseTwin.rawGrid,
        infrastructure.roads,
      );
    }

    registry[info.label] = {
      id: buildingId,
      type: srcBuilding?.type ?? info.type ?? "residential",
      floors: srcBuilding?.floors ?? info.floors,
      gridCells: info.cells,
      entrance: info.entrance,
      entranceFacing: info.entrance ? inferEntranceFacing(info.centroid, info.entrance) : undefined,
      frontageStreet,
      address: srcBuilding?.address ?? info.address,
    };
  }

  return registry;
}

/**
 * Find the road name closest to a given grid position by scanning nearby
 * road cells and matching them against InfrastructureRoad segments.
 */
function findClosestRoadName(
  gridPos: [number, number],
  roadCells: Set<string>,
  _rawGrid: string[][],
  roads: InfrastructureRoad[],
): string | undefined {
  const [col, row] = gridPos;
  // Search in a small neighborhood for a road cell
  const searchRadius = 5;
  let closestDist = Number.POSITIVE_INFINITY;
  let closestRoadCell: [number, number] | undefined;

  for (let dy = -searchRadius; dy <= searchRadius; dy++) {
    for (let dx = -searchRadius; dx <= searchRadius; dx++) {
      const key = `${col + dx},${row + dy}`;
      if (roadCells.has(key)) {
        const dist = Math.abs(dx) + Math.abs(dy);
        if (dist < closestDist) {
          closestDist = dist;
          closestRoadCell = [col + dx, row + dy];
        }
      }
    }
  }

  if (!closestRoadCell) return undefined;

  // Return the name of the first named road (most roads are named in OSM data)
  // In a more sophisticated version, we'd map grid coords back to geo coords
  // and find the closest road segment by distance. For now, return the first
  // named road as a reasonable heuristic.
  for (const road of roads) {
    if (road.name) return road.name;
  }

  return undefined;
}

/**
 * Infer which compass direction the entrance faces based on the vector
 * from building centroid to entrance cell.
 */
function inferEntranceFacing(centroid: [number, number], entrance: [number, number]): string {
  const dc = entrance[0] - centroid[0]; // col delta (east-positive)
  const dr = entrance[1] - centroid[1]; // row delta (south-positive, since row 0 = north)

  if (Math.abs(dc) >= Math.abs(dr)) {
    return dc >= 0 ? "east" : "west";
  }
  return dr >= 0 ? "south" : "north";
}

/**
 * Build a Corridor Graph from the Route Twin's junctions and corridors.
 *
 * Maps corridor IDs to structured entries with grid cells and metadata.
 * Unlike the Route Twin's ASCII grid (which shows corridors as drawn lines),
 * the corridor graph provides a queryable JSON representation of the
 * routing topology.
 */
export function buildCorridorGraph(
  routeTwin: RouteTwinResult,
  ctx: GridContext,
): Record<string, CorridorGraphEntry> {
  const graph: Record<string, CorridorGraphEntry> = {};

  // Build a junction lookup for grid positions
  const junctionById = new Map<string, RouteTwinJunction>();
  for (const j of routeTwin.junctions) {
    junctionById.set(j.id, j);
  }

  for (const corridor of routeTwin.corridors) {
    const fromJunction = junctionById.get(corridor.fromJunction);
    const toJunction = junctionById.get(corridor.toJunction);

    if (!fromJunction || !toJunction) continue;

    // Collect grid cells along the corridor using Bresenham traversal
    const gridCells = bresenhamCells(fromJunction.gridPos, toJunction.gridPos, ctx.gw, ctx.gh);

    // Map corridor type to CorridorGraphEntry type
    const entryType = mapCorridorType(corridor.type);

    // Determine road name from junctions if available
    const name = fromJunction.streetName ?? toJunction.streetName;

    graph[corridor.id] = {
      id: corridor.id,
      name,
      type: entryType,
      gridCells,
      widthM: corridor.type === "road" ? 12 : corridor.type === "sidewalk" ? 2 : undefined,
    };
  }

  return graph;
}

/**
 * Map Route Twin corridor types to Corridor Graph entry types.
 * Route Twin uses routing graph types ("conduit", "sidewalk", "road", "aerial").
 * Corridor Graph uses OSM-style types for roads.
 */
function mapCorridorType(corridorType: RouteTwinCorridor["type"]): CorridorGraphEntry["type"] {
  switch (corridorType) {
    case "conduit":
      return "conduit";
    case "sidewalk":
      return "sidewalk";
    case "aerial":
      return "aerial";
    case "road":
      // Default to "residential" since we don't have OSM classification here.
      // The InfrastructureRoad type has "primary"/"secondary"/"residential"
      // but that info is lost by the time we have RouteTwinCorridors.
      return "residential";
  }
}

/**
 * Collect all grid cells along a Bresenham line between two points.
 * Returns an array of [col, row] pairs. Used by the corridor graph builder
 * to enumerate cells that a corridor occupies.
 */
function bresenhamCells(
  from: [number, number],
  to: [number, number],
  gw: number,
  gh: number,
): [number, number][] {
  const cells: [number, number][] = [];
  let [x0, y0] = from;
  const [x1, y1] = to;

  if (x0 < 0 || x0 >= gw || y0 < 0 || y0 >= gh) return cells;
  if (x1 < 0 || x1 >= gw || y1 < 0 || y1 >= gh) return cells;

  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;

  const maxSteps = dx + dy + 2;
  let steps = 0;

  while (steps < maxSteps) {
    if (x0 >= 0 && x0 < gw && y0 >= 0 && y0 < gh) {
      cells.push([x0, y0]);
    }
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      x0 += sx;
    }
    if (e2 < dx) {
      err += dx;
      y0 += sy;
    }
    steps++;
  }

  return cells;
}

// ---------------------------------------------------------------------------
// Step 7: Three-Layer Twin Orchestrator
// ---------------------------------------------------------------------------

/**
 * Generate the full three-layer Text Twin for a zone.
 *
 * This is the main entry point for the new architecture. It:
 *   1. Creates a shared `GridContext` (once)
 *   2. Generates the Base Twin (pure geography)
 *   3. Generates the Route Twin (corridor topology)
 *   4. Generates the Work Twin (sparse network overlay)
 *   5. Builds the Building Registry and Corridor Graph companions
 *   6. Composites the Work Twin on top of the Base Twin for display
 *
 * The three layers share the same grid dimensions and coordinate system,
 * so cell [col, row] maps to the same geographic position in each layer.
 */
export function generateThreeLayerTwin(
  zoneBounds: ZoneBounds,
  infrastructure: {
    roads?: InfrastructureRoad[];
    buildings?: InfrastructureBuilding[];
  },
  routingGraph: RoutingGraph,
  nodes: ZoneEquipment[],
  cables: ZoneFeature[],
  crossZoneLinks: CrossZoneLink[],
  issues: ZoneIssue[],
  options?: {
    gridWidth?: number;
    gridHeight?: number;
    symbolConfig?: GridSymbolConfig;
  },
): ThreeLayerTwinResult {
  // ── 1. Create shared grid context ────────────────────────────────────
  const ctx = createGridContext(zoneBounds, options?.gridWidth, options?.gridHeight);

  // ── 2. Generate the three layers ─────────────────────────────────────
  const base = generateBaseTwin(ctx, infrastructure);

  const route = generateRouteTwin(ctx, routingGraph, {
    roadCells: base.roadCells,
    buildingCellOwner: base.buildingCellOwner,
  });

  const work = generateWorkTwin(ctx, nodes, cables, crossZoneLinks, issues, options?.symbolConfig);

  // ── 3. Build JSON companion layers ───────────────────────────────────
  const buildingRegistry = buildBuildingRegistry(base, infrastructure);
  const corridorGraph = buildCorridorGraph(route, ctx);

  // ── 4. Composite: Work Twin layered on top of Base Twin ──────────────
  const composited = compositeGrids(base.rawGrid, work.rawGrid, ctx.gw, ctx.gh);

  return {
    base,
    route,
    work,
    buildingRegistry,
    corridorGraph,
    composited,
  };
}

/**
 * Composite two raw grids by overlaying the Work Twin on top of the Base Twin.
 * For each cell, show the Work Twin character if non-empty (not a space),
 * otherwise show the Base Twin character. Returns a formatted ASCII string.
 */
function compositeGrids(
  baseGrid: string[][],
  workGrid: string[][],
  gw: number,
  gh: number,
): string {
  const composited: string[][] = [];
  for (let r = 0; r < gh; r++) {
    composited[r] = [];
    for (let c = 0; c < gw; c++) {
      const workCell = workGrid[r]?.[c];
      const baseCell = baseGrid[r]?.[c];
      composited[r][c] = workCell && workCell !== " " ? workCell : (baseCell ?? " ");
    }
  }

  const header = `Composited Twin | ${gw}x${gh} | Work + Base overlay`;
  return formatGridToAscii(composited, gw, gh, header);
}

// ============================================================================
// ASCII Grid Generation (Original — kept for backward compatibility)
// ============================================================================

/**
 * Generate high-resolution ASCII grid for a zone
 *
 * The grid represents geographic coordinates mapped to character positions.
 * We use aspect ratio correction to ensure buildings/roads appear aligned
 * with real-world orientations (not diagonal).
 */
export function generateZoneAsciiGrid(
  zoneBounds: ZoneBounds,
  nodes: ZoneEquipment[],
  cables: ZoneFeature[],
  infrastructure: {
    roads?: InfrastructureRoad[];
    buildings?: InfrastructureBuilding[];
  },
  crossZoneLinks: CrossZoneLink[],
  issues: ZoneIssue[],
  debug: boolean = false,
  symbolConfig?: GridSymbolConfig,
  gridWidth?: number,
  gridHeight?: number,
): {
  grid: string;
  equipmentPositions: Map<string, [number, number]>;
  buildingPositions: Map<string, BuildingGridInfo>;
} {
  // Effective grid dimensions — use caller override or module defaults
  const gw = gridWidth ?? GRID_WIDTH;
  const gh = gridHeight ?? GRID_HEIGHT;

  // Initialize grid
  const grid: string[][] = Array(gh)
    .fill(null)
    .map(() => Array(gw).fill(SYMBOLS.empty));

  // Calculate zone dimensions in METERS (critical for aspect ratio)
  const centerLat = (zoneBounds.minLat + zoneBounds.maxLat) / 2;
  const widthMeters = haversineDistance(
    [zoneBounds.minLng, centerLat],
    [zoneBounds.maxLng, centerLat],
  );
  const heightMeters = haversineDistance(
    [zoneBounds.minLng, zoneBounds.minLat],
    [zoneBounds.minLng, zoneBounds.maxLat],
  );

  // Meters per grid cell
  const _metersPerCellX = widthMeters / gw;
  const _metersPerCellY = heightMeters / gh;

  // Degrees per grid cell (for coordinate conversion)
  const cellWidth = (zoneBounds.maxLng - zoneBounds.minLng) / gw;
  const cellHeight = (zoneBounds.maxLat - zoneBounds.minLat) / gh;

  // Map coordinate to grid position
  // Y-axis is inverted: grid row 0 = north (max lat), row gh-1 = south (min lat)
  const toGrid = (coord: [number, number]): [number, number] => {
    const x = Math.floor((coord[0] - zoneBounds.minLng) / cellWidth);
    const y = gh - 1 - Math.floor((coord[1] - zoneBounds.minLat) / cellHeight);
    return [Math.max(0, Math.min(gw - 1, x)), Math.max(0, Math.min(gh - 1, y))];
  };

  // Track equipment positions
  const equipmentPositions = new Map<string, [number, number]>();

  // Build house index map for numbered symbols (①②③...)
  // Houses are numbered 1-N within the zone for LLM reference
  const houseNodes = nodes.filter((n) => n.type === "house");
  const houseIndexMap = new Map<string, number>();
  houseNodes.forEach((house, index) => {
    houseIndexMap.set(house.id, index + 1); // 1-based indexing for display
  });

  // Set of nodes with issues
  const issueNodeIds = new Set(issues.filter((i) => i.nodeId).map((i) => i.nodeId));

  // Helper: determine if a road segment is more horizontal or vertical
  const getRoadSymbol = (from: [number, number], to: [number, number]): string => {
    const dx = Math.abs(to[0] - from[0]);
    const dy = Math.abs(to[1] - from[1]);
    // If dx > dy, road runs more east-west (horizontal)
    // If dy > dx, road runs more north-south (vertical)
    return dx >= dy ? SYMBOLS.road_h : SYMBOLS.road_v;
  };

  // Track road cells for building entrance detection
  const roadCells = new Set<string>();

  // 1. Draw roads (background layer) - with direction-aware symbols
  if (infrastructure.roads) {
    for (const road of infrastructure.roads) {
      // Skip roads without valid coordinates
      if (!road.coordinates || road.coordinates.length < 2) continue;

      for (let i = 0; i < road.coordinates.length - 1; i++) {
        const from = toGrid(road.coordinates[i]);
        const to = toGrid(road.coordinates[i + 1]);
        const symbol = getRoadSymbol(road.coordinates[i], road.coordinates[i + 1]);
        drawLineWithSymbol(grid, from, to, symbol, gw, gh);
      }
    }
    // Record all road cells after drawing
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        const c = grid[y][x];
        if (
          c === SYMBOLS.road_h ||
          c === SYMBOLS.road_v ||
          c === SYMBOLS.road_cross ||
          c === SYMBOLS.road_corner_ne ||
          c === SYMBOLS.road_corner_nw ||
          c === SYMBOLS.road_corner_se ||
          c === SYMBOLS.road_corner_sw
        ) {
          roadCells.add(`${x},${y}`);
        }
      }
    }
  }

  // Per-building cell tracking: cell key → building ID
  const buildingCellOwner = new Map<string, string>();
  // Per-building cell list: buildingId → list of [col, row]
  const buildingCellLists = new Map<string, [number, number][]>();

  // 2. Draw sidewalks/pavement adjacent to buildings
  // Sidewalks appear between buildings and roads - they represent potential equipment placement zones
  if (infrastructure.buildings) {
    // First pass: identify all building cells and which building owns them
    const buildingCellSet = new Set<string>();
    for (const building of infrastructure.buildings) {
      const thisCells: [number, number][] = [];
      if (building.coordinates && building.coordinates.length > 0) {
        for (const ring of building.coordinates) {
          if (ring.length >= 3) {
            const gridPolygon: [number, number][] = ring.map((coord) => toGrid(coord));
            const minX = Math.max(0, Math.floor(Math.min(...gridPolygon.map((p) => p[0]))));
            const maxX = Math.min(gw - 1, Math.ceil(Math.max(...gridPolygon.map((p) => p[0]))));
            const minY = Math.max(0, Math.floor(Math.min(...gridPolygon.map((p) => p[1]))));
            const maxY = Math.min(gh - 1, Math.ceil(Math.max(...gridPolygon.map((p) => p[1]))));
            for (let y = minY; y <= maxY; y++) {
              for (let x = minX; x <= maxX; x++) {
                if (pointInPolygon(x, y, gridPolygon)) {
                  const key = `${x},${y}`;
                  buildingCellSet.add(key);
                  buildingCellOwner.set(key, building.id);
                  thisCells.push([x, y]);
                }
              }
            }
          }
        }
      } else if (building.centroid) {
        const [cx, cy] = toGrid(building.centroid);
        for (let dy = -1; dy <= 0; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const y = cy + dy;
            const x = cx + dx;
            if (y >= 0 && y < gh && x >= 0 && x < gw) {
              const key = `${x},${y}`;
              buildingCellSet.add(key);
              buildingCellOwner.set(key, building.id);
              thisCells.push([x, y]);
            }
          }
        }
      }
      if (thisCells.length > 0) {
        buildingCellLists.set(building.id, thisCells);
      }
    }

    // Second pass: add sidewalks adjacent to buildings (1-2 cells away)
    const SIDEWALK_WIDTH = 2;
    for (const cellKey of buildingCellSet) {
      const [cx, cy] = cellKey.split(",").map(Number);
      for (let dy = -SIDEWALK_WIDTH; dy <= SIDEWALK_WIDTH; dy++) {
        for (let dx = -SIDEWALK_WIDTH; dx <= SIDEWALK_WIDTH; dx++) {
          if (dx === 0 && dy === 0) continue;
          const x = cx + dx;
          const y = cy + dy;
          const key = `${x},${y}`;
          if (y >= 0 && y < gh && x >= 0 && x < gw) {
            // Only add sidewalk if not already a building or road
            if (!buildingCellSet.has(key) && grid[y][x] === SYMBOLS.empty) {
              grid[y][x] = SYMBOLS.sidewalk;
            }
          }
        }
      }
    }
  }

  // 3. Draw buildings (fill footprint polygons if available, otherwise centroid)
  // Buildings are drawn AFTER sidewalks so they overwrite the sidewalk cells
  // Then embed building ID labels at each building's grid centroid
  const buildingPositions = new Map<string, BuildingGridInfo>();

  if (infrastructure.buildings) {
    for (const building of infrastructure.buildings) {
      // If building has footprint coordinates, fill the polygon
      if (building.coordinates && building.coordinates.length > 0) {
        for (const ring of building.coordinates) {
          if (ring.length >= 3) {
            const gridPolygon: [number, number][] = ring.map((coord) => toGrid(coord));
            fillPolygon(grid, gridPolygon, SYMBOLS.building, undefined, gw, gh);
          }
        }
      } else if (building.centroid) {
        // Fallback: draw a small block at centroid (3x2 chars to be visible)
        const [cx, cy] = toGrid(building.centroid);
        for (let dy = -1; dy <= 0; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const y = cy + dy;
            const x = cx + dx;
            if (y >= 0 && y < gh && x >= 0 && x < gw) {
              if (
                grid[y][x] === SYMBOLS.empty ||
                grid[y][x] === SYMBOLS.road_h ||
                grid[y][x] === SYMBOLS.sidewalk
              ) {
                grid[y][x] = SYMBOLS.building;
              }
            }
          }
        }
      }
    }

    // 3b. Embed building ID labels and detect entrances
    const sortedBuildings = [...infrastructure.buildings].sort((a, b) => a.id.localeCompare(b.id));

    for (let bIdx = 0; bIdx < sortedBuildings.length; bIdx++) {
      const building = sortedBuildings[bIdx];
      const cells = buildingCellLists.get(building.id);
      if (!cells || cells.length === 0) continue;

      const label = `B${String(bIdx + 1).padStart(2, "0")}`;

      // Compute grid centroid of this building's cells
      let sumX = 0;
      let sumY = 0;
      for (const [cx, cy] of cells) {
        sumX += cx;
        sumY += cy;
      }
      const centroidX = Math.round(sumX / cells.length);
      const centroidY = Math.round(sumY / cells.length);

      // Determine building width at the centroid row
      const cellsAtCentroidRow = cells.filter(([, cy]) => cy === centroidY);
      const buildingWidth = cellsAtCentroidRow.length;

      // Embed label in the grid if building is wide enough (≥3 cells for "B01")
      if (buildingWidth >= 3) {
        // Find leftmost cell at centroid row to center the label
        const minXAtRow = Math.min(...cellsAtCentroidRow.map(([cx]) => cx));
        const maxXAtRow = Math.max(...cellsAtCentroidRow.map(([cx]) => cx));
        const labelStart = Math.floor((minXAtRow + maxXAtRow - label.length + 1) / 2);
        for (let i = 0; i < label.length; i++) {
          const lx = labelStart + i;
          if (lx >= 0 && lx < gw && grid[centroidY]?.[lx] === SYMBOLS.building) {
            grid[centroidY][lx] = label[i];
          }
        }
      } else if (cells.length >= 1) {
        // Small building: place a single marker at centroid
        // Use the label's number part if it fits, otherwise just the number
        const numStr = String(bIdx + 1);
        if (grid[centroidY]?.[centroidX] === SYMBOLS.building) {
          grid[centroidY][centroidX] = numStr.length === 1 ? numStr : numStr[numStr.length - 1];
        }
      }

      // Detect entrance: building edge cell closest to any road cell
      let entrance: [number, number] | null = null;
      let minRoadDist = Infinity;
      // Find edge cells (cells that have at least one non-building neighbor)
      for (const [cx, cy] of cells) {
        const isEdge =
          !buildingCellOwner.has(`${cx - 1},${cy}`) ||
          buildingCellOwner.get(`${cx - 1},${cy}`) !== building.id ||
          !buildingCellOwner.has(`${cx + 1},${cy}`) ||
          buildingCellOwner.get(`${cx + 1},${cy}`) !== building.id ||
          !buildingCellOwner.has(`${cx},${cy - 1}`) ||
          buildingCellOwner.get(`${cx},${cy - 1}`) !== building.id ||
          !buildingCellOwner.has(`${cx},${cy + 1}`) ||
          buildingCellOwner.get(`${cx},${cy + 1}`) !== building.id;
        if (!isEdge) continue;

        // Check Manhattan distance to nearest road cell (scan 10-cell radius)
        for (let rdy = -10; rdy <= 10; rdy++) {
          for (let rdx = -10; rdx <= 10; rdx++) {
            const dist = Math.abs(rdx) + Math.abs(rdy);
            if (dist >= minRoadDist) continue;
            if (roadCells.has(`${cx + rdx},${cy + rdy}`)) {
              minRoadDist = dist;
              entrance = [cx, cy];
            }
          }
        }
      }

      buildingPositions.set(building.id, {
        id: building.id,
        label,
        cells,
        centroid: [centroidX, centroidY],
        entrance,
        address: building.address,
        type: building.type,
        floors: building.floors,
      });
    }
  }

  // 4. Draw cables with tracking layer for composite symbols
  // Track which cells have cables passing through them
  const cableLayer = new Set<string>();

  // Track cable endpoints (source/target node positions)
  const cableEndpoints = new Set<string>();

  // Track cable midpoints for ID annotation placement
  const cableMidpoints: Array<{
    cableId: string;
    cableType: "drop" | "feeder" | "distribution" | undefined;
    midpoint: [number, number]; // grid coordinates
  }> = [];

  for (const cable of cables) {
    if (cable.geometry.type !== "LineString") continue;

    const coords = cable.geometry.coordinates as [number, number][];
    const cableType = cable.properties.cableType as "drop" | "feeder" | "distribution" | undefined;
    const symbol =
      cableType === "drop"
        ? SYMBOLS.cable_drop
        : cableType === "feeder"
          ? SYMBOLS.cable_underground
          : SYMBOLS.cable_underground;

    // Track cable endpoints
    if (coords.length >= 2) {
      const [startX, startY] = toGrid(coords[0]);
      const [endX, endY] = toGrid(coords[coords.length - 1]);
      cableEndpoints.add(`${startX},${startY}`);
      cableEndpoints.add(`${endX},${endY}`);

      // Calculate midpoint for cable ID annotation
      // Use the middle coordinate of the path, or average of start/end if only 2 points
      let midCoord: [number, number];
      if (coords.length > 2) {
        const midIdx = Math.floor(coords.length / 2);
        midCoord = coords[midIdx];
      } else {
        midCoord = [(coords[0][0] + coords[1][0]) / 2, (coords[0][1] + coords[1][1]) / 2];
      }
      const midGrid = toGrid(midCoord);

      cableMidpoints.push({
        cableId: cable.id,
        cableType,
        midpoint: midGrid,
      });
    }

    for (let i = 0; i < coords.length - 1; i++) {
      drawLineWithCableTracking(
        grid,
        toGrid(coords[i]),
        toGrid(coords[i + 1]),
        symbol,
        cableLayer,
        gw,
        gh,
      );
    }
  }

  // 4b. Draw cable ID annotations at midpoints
  // Only show annotations for feeder and distribution cables (drop cables are too numerous)
  for (const cableMid of cableMidpoints) {
    // Skip drop cables - they're too numerous and would clutter the grid
    if (cableMid.cableType === "drop") continue;

    const [x, y] = cableMid.midpoint;
    const annotation = getCableGridAnnotation(cableMid.cableId, cableMid.cableType);

    // Write 5-character annotation across consecutive cells
    for (let i = 0; i < annotation.length && x + i < gw; i++) {
      // Only overwrite empty, sidewalk, or cable cells (not buildings or equipment)
      const currentCell = grid[y]?.[x + i];
      if (
        currentCell === SYMBOLS.empty ||
        currentCell === SYMBOLS.sidewalk ||
        currentCell === SYMBOLS.cable_drop ||
        currentCell === SYMBOLS.cable_underground ||
        currentCell === SYMBOLS.cable_aerial
      ) {
        grid[y][x + i] = annotation[i];
      }
    }
  }

  // 5. Draw nodes (top layer) - now with cable-aware composite symbols and numbered closures
  // Sort nodes so that closures/DENs are drawn LAST (highest visibility priority)
  // This prevents houses from overwriting closure symbols when they share the same grid cell
  const nodePriority = (type: string): number => {
    switch (type) {
      case "house":
        return 0; // Draw first (lowest priority)
      case "pole":
        return 1;
      case "cabinet":
        return 2;
      case "co":
        return 3;
      case "closure":
      case "den":
        return 4; // Draw last (highest priority)
      default:
        return 0;
    }
  };
  const sortedNodes = [...nodes].sort((a, b) => nodePriority(a.type) - nodePriority(b.type));

  // Resolve symbol for an equipment node, using schema config when available
  const resolveSymbol = (nodeType: string): string => {
    if (symbolConfig?.entitySymbols[nodeType]) {
      return symbolConfig.entitySymbols[nodeType];
    }
    // Fallback to hardcoded FTTH symbols
    const sym = SYMBOLS[nodeType as keyof typeof SYMBOLS];
    return typeof sym === "string" ? sym : "?";
  };

  for (const node of sortedNodes) {
    const [x, y] = toGrid(node.coordinates);
    equipmentPositions.set(node.id, [x, y]);

    const hasIssue = issueNodeIds.has(node.id);
    const cellKey = `${x},${y}`;
    const _hasCableConnection = cableEndpoints.has(cellKey) || cableLayer.has(cellKey);

    // Determine if this equipment type gets multi-character annotation
    // For schema-driven mode: any non-house, non-pole entity with a symbol gets annotation
    const isAnnotatedEquipment = symbolConfig
      ? node.type !== "house" && node.type !== "pole" && !!symbolConfig.entitySymbols[node.type]
      : node.type === "co" ||
        node.type === "cabinet" ||
        node.type === "cabinet-t3" ||
        node.type === "closure" ||
        node.type === "den";

    if (hasIssue) {
      // Error nodes get single error symbol
      grid[y][x] = SYMBOLS.error;
    } else if (isAnnotatedEquipment) {
      // Build annotation: [SYMBOL+SEQ] format
      // Schema-driven: use iconSymbol from config + prefix for annotation
      const sym = resolveSymbol(node.type);
      const gridId = getGridId(node.id);
      const annotation = `[${sym}${gridId}]`;
      // Write multi-character annotation across consecutive cells
      for (let i = 0; i < annotation.length && x + i < gw; i++) {
        grid[y][x + i] = annotation[i];
      }
    } else if (node.type === "house") {
      // Houses get numbered symbols (①②③...) for LLM reference
      const houseIndex = houseIndexMap.get(node.id) || 0;
      const houseSymbol = getNumberedHouseSymbol(houseIndex);
      grid[y][x] = houseSymbol;
    } else {
      // Other nodes (poles, etc.) use resolved symbol
      grid[y][x] = resolveSymbol(node.type);
    }
  }

  // 5. Mark zone exits for cross-zone links
  for (const link of crossZoneLinks) {
    if (link.sourceZone === link.targetZone) continue;

    let x: number, y: number;
    let symbol: string;

    switch (link.direction) {
      case "east":
        x = gw - 1;
        y = Math.floor(gh / 2);
        symbol = "→";
        break;
      case "west":
        x = 0;
        y = Math.floor(gh / 2);
        symbol = "←";
        break;
      case "north":
        x = Math.floor(gw / 2);
        y = 0;
        symbol = "↑";
        break;
      case "south":
        x = Math.floor(gw / 2);
        y = gh - 1;
        symbol = "↓";
        break;
    }

    grid[y][x] = symbol;
  }

  // 6. Add street name labels to the grid
  // This makes the grid more readable for agents by showing street names
  if (infrastructure.roads && infrastructure.roads.length > 0) {
    const streetLabelResult = addStreetLabelsToGrid(grid, infrastructure.roads, zoneBounds, gw, gh);
    // streetLabelResult contains the updated grid and label metadata
    // The grid is modified in place, so no need to reassign
    if (debug && streetLabelResult.streetLabels.length > 0) {
      console.log(
        `[Zone Grid] Added ${streetLabelResult.streetLabels.length} street labels:`,
        streetLabelResult.streetLabels.map((l) => l.name),
      );
    }
  }

  // Generate ASCII string
  const lines: string[] = [];

  // Header with column numbers
  const colHeader = `    ${Array.from({ length: Math.ceil(gw / 10) }, (_, i) => String(i).padEnd(10)).join("")}`;
  lines.push(colHeader);

  const colNumbers = `    ${Array.from({ length: gw }, (_, i) => String(i % 10)).join("")}`;
  lines.push(colNumbers);

  // Top border
  lines.push(`   ┌${"─".repeat(gw)}┐`);

  // Grid rows
  for (let y = 0; y < gh; y++) {
    const rowLabel = String.fromCharCode(65 + (y % 26));
    lines.push(` ${rowLabel} │${grid[y].join("")}│`);
  }

  // Bottom border
  lines.push(`   └${"─".repeat(gw)}┘`);

  return {
    grid: lines.join("\n"),
    equipmentPositions,
    buildingPositions,
  };
}

/**
 * Draw a line on the grid using Bresenham's algorithm
 * @deprecated Use drawLineWithCableTracking for cables (tracks positions and uses composite symbols)
 */
function _drawLine(
  grid: string[][],
  from: [number, number],
  to: [number, number],
  char: string,
): void {
  let [x0, y0] = from;
  const [x1, y1] = to;

  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;

  while (true) {
    // Don't overwrite important symbols
    if (
      grid[y0][x0] === SYMBOLS.empty ||
      grid[y0][x0] === SYMBOLS.road_h ||
      grid[y0][x0] === SYMBOLS.road_v ||
      grid[y0][x0] === SYMBOLS.sidewalk
    ) {
      grid[y0][x0] = char;
    }

    if (x0 === x1 && y0 === y1) break;

    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      x0 += sx;
    }
    if (e2 < dx) {
      err += dx;
      y0 += sy;
    }
  }
}

/**
 * Draw a cable line with tracking and composite symbols
 * This function:
 * 1. Tracks all cable positions in cableLayer for later use
 * 2. Uses composite symbols when crossing roads or buildings
 * 3. Always draws the cable, even through buildings (using cable_building symbol)
 */
function drawLineWithCableTracking(
  grid: string[][],
  from: [number, number],
  to: [number, number],
  char: string,
  cableLayer: Set<string>,
  gw: number = GRID_WIDTH,
  gh: number = GRID_HEIGHT,
): void {
  let [x0, y0] = from;
  const [x1, y1] = to;

  // Bounds check
  if (y0 < 0 || y0 >= gh || x0 < 0 || x0 >= gw) return;
  if (y1 < 0 || y1 >= gh || x1 < 0 || x1 >= gw) return;

  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;

  while (true) {
    if (y0 >= 0 && y0 < gh && x0 >= 0 && x0 < gw) {
      const cellKey = `${x0},${y0}`;
      const currentCell = grid[y0][x0];

      // Always track the cable position
      cableLayer.add(cellKey);

      // Determine the appropriate symbol based on what's already in the cell
      if (currentCell === SYMBOLS.empty || currentCell === SYMBOLS.sidewalk) {
        // Empty or sidewalk - just draw the cable
        grid[y0][x0] = char;
      } else if (currentCell === SYMBOLS.road_h) {
        // Cable crossing horizontal road
        grid[y0][x0] = SYMBOLS.cable_road_h;
      } else if (currentCell === SYMBOLS.road_v) {
        // Cable crossing vertical road
        grid[y0][x0] = SYMBOLS.cable_road_v;
      } else if (currentCell === SYMBOLS.road_cross) {
        // Cable crossing road intersection - keep road cross but track cable
        // The cable is tracked in cableLayer, we just don't visually override the crossing
        grid[y0][x0] = SYMBOLS.cable_road_h; // Use horizontal cable cross for visibility
      } else if (currentCell === SYMBOLS.building) {
        // Cable passing through/near building - use composite symbol
        grid[y0][x0] = SYMBOLS.cable_building;
      }
      // For other symbols (equipment nodes, other cables), just track but don't overwrite
      // The equipment will be drawn later and will use the cableLayer to know about connections
    }

    if (x0 === x1 && y0 === y1) break;

    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      x0 += sx;
    }
    if (e2 < dx) {
      err += dx;
      y0 += sy;
    }
  }
}

/**
 * Draw a line on the grid using Bresenham's algorithm with direction-aware symbol
 * Uses the provided symbol for the entire line - handles road directions properly
 */
function drawLineWithSymbol(
  grid: string[][],
  from: [number, number],
  to: [number, number],
  symbol: string,
  gw: number = GRID_WIDTH,
  gh: number = GRID_HEIGHT,
): void {
  let [x0, y0] = from;
  const [x1, y1] = to;

  // Bounds check
  if (y0 < 0 || y0 >= gh || x0 < 0 || x0 >= gw) return;
  if (y1 < 0 || y1 >= gh || x1 < 0 || x1 >= gw) return;

  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;

  while (true) {
    // Roads can overwrite empty space and sidewalks, but not buildings or equipment
    if (y0 >= 0 && y0 < gh && x0 >= 0 && x0 < gw) {
      const currentCell = grid[y0][x0];
      if (currentCell === SYMBOLS.empty || currentCell === SYMBOLS.sidewalk) {
        grid[y0][x0] = symbol;
      } else if (currentCell === SYMBOLS.road_h && symbol === SYMBOLS.road_v) {
        // Roads crossing - use cross symbol
        grid[y0][x0] = SYMBOLS.road_cross;
      } else if (currentCell === SYMBOLS.road_v && symbol === SYMBOLS.road_h) {
        // Roads crossing - use cross symbol
        grid[y0][x0] = SYMBOLS.road_cross;
      }
    }

    if (x0 === x1 && y0 === y1) break;

    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      x0 += sx;
    }
    if (e2 < dx) {
      err += dx;
      y0 += sy;
    }
  }
}

/**
 * Check if a point is inside a polygon using ray casting algorithm
 */
function pointInPolygon(x: number, y: number, polygon: [number, number][]): boolean {
  let inside = false;
  const n = polygon.length;

  for (let i = 0, j = n - 1; i < n; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];

    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }

  return inside;
}

/**
 * Fill a polygon on the grid with the specified character
 * Uses scanline algorithm for efficient filling
 */
function fillPolygon(
  grid: string[][],
  polygon: [number, number][],
  char: string,
  allowOverwrite: string[] = [SYMBOLS.empty, SYMBOLS.road_h, SYMBOLS.road_v, SYMBOLS.sidewalk],
  gw: number = GRID_WIDTH,
  gh: number = GRID_HEIGHT,
): void {
  if (polygon.length < 3) return;

  // Find bounding box of polygon in grid coordinates
  let minX = Infinity,
    maxX = -Infinity;
  let minY = Infinity,
    maxY = -Infinity;

  for (const [x, y] of polygon) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }

  // Clamp to grid bounds
  minX = Math.max(0, Math.floor(minX));
  maxX = Math.min(gw - 1, Math.ceil(maxX));
  minY = Math.max(0, Math.floor(minY));
  maxY = Math.min(gh - 1, Math.ceil(maxY));

  // Fill all cells inside the polygon
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      if (pointInPolygon(x, y, polygon)) {
        if (grid[y] && allowOverwrite.includes(grid[y][x])) {
          grid[y][x] = char;
        }
      }
    }
  }
}

// ============================================================================
// GeoJSON Generation
// ============================================================================

/**
 * Generate GeoJSON for a zone
 */
export function generateZoneGeoJSON(
  zoneId: string,
  zoneBounds: ZoneBounds,
  nodes: NetworkNode[],
  cables: NetworkCable[],
): ZoneGeoJSON {
  const features: ZoneFeature[] = [];

  // Add node features
  for (const node of nodes) {
    features.push({
      type: "Feature",
      id: node.id,
      geometry: {
        type: "Point",
        coordinates: node.position,
      },
      properties: {
        nodeType: node.type,
        splitterRatio: node.splitterRatio,
        label: node.label,
        fiberCount: node.totalFibers,
        ...(node.type === "co" && { ports: node.ports }),
      },
    });
  }

  // Add cable features
  for (const cable of cables) {
    features.push({
      type: "Feature",
      id: cable.id,
      geometry: {
        type: "LineString",
        coordinates: cable.path || [
          nodes.find((n) => n.id === cable.source)?.position || [0, 0],
          nodes.find((n) => n.id === cable.target)?.position || [0, 0],
        ],
      },
      properties: {
        cableType: cable.cableType,
        source: cable.source,
        target: cable.target,
        fiberCount: cable.fiberCount,
        length: cable.length,
      },
    });
  }

  return {
    type: "FeatureCollection",
    zone: zoneId,
    bounds: [
      [zoneBounds.minLng, zoneBounds.minLat],
      [zoneBounds.maxLng, zoneBounds.maxLat],
    ],
    features,
  };
}

// ============================================================================
// Zone Text Twin Generation
// ============================================================================

/**
 * Generate complete DataStore zone data
 */
export function generateDataStoreZone(
  zoneId: string,
  zoneBounds: ZoneBounds,
  nodes: NetworkNode[],
  cables: NetworkCable[],
  infrastructure: {
    roads?: InfrastructureRoad[];
    buildings?: InfrastructureBuilding[];
  },
  zoneGrid: { rows: number; cols: number },
  debug: boolean = false,
): ZoneTextTwin {
  // Get adjacent zones
  const adjacent = getAdjacentZones(zoneId, zoneGrid);

  // Generate GeoJSON
  const geojson = generateZoneGeoJSON(zoneId, zoneBounds, nodes, cables);

  // Build equipment list with [●01] annotation format for major equipment
  const equipment: ZoneEquipment[] = nodes.map((node) => {
    let symbol: string;
    // Use [●01] format for closures, cabinets, and COs
    if (
      node.type === "closure" ||
      node.type === "den" ||
      node.type === "cabinet" ||
      node.type === "cabinet-t3" ||
      node.type === "co"
    ) {
      symbol = getEquipmentGridAnnotation(
        node.id,
        node.type as "closure" | "den" | "cabinet" | "cabinet-t3" | "co",
      );
    } else {
      symbol = SYMBOLS[node.type] || "?";
    }
    return {
      id: node.id,
      symbol,
      type: node.type,
      coordinates: node.position,
      gridPosition: [0, 0], // Will be set by ASCII generator
      properties: {
        splitterRatio: node.splitterRatio,
        fiberCount: node.totalFibers,
        label: node.label,
      },
    };
  });

  // Detect cross-zone links
  const crossZoneLinks = detectCrossZoneLinks(zoneId, cables, nodes, zoneBounds, zoneGrid);

  // Run validation (including building crossing detection)
  const issues = validateZone(nodes, cables, zoneBounds, infrastructure.buildings || []);

  // Generate ASCII grid
  const cableFeatures = geojson.features.filter((f) => f.geometry.type === "LineString");
  const { grid, equipmentPositions } = generateZoneAsciiGrid(
    zoneBounds,
    equipment,
    cableFeatures,
    infrastructure,
    crossZoneLinks,
    issues,
    debug,
  );

  // Update equipment with grid positions
  for (const eq of equipment) {
    const pos = equipmentPositions.get(eq.id);
    if (pos) {
      eq.gridPosition = pos;
    }
  }

  // Calculate zone size in meters
  const widthMeters = haversineDistance(
    [zoneBounds.minLng, zoneBounds.minLat],
    [zoneBounds.maxLng, zoneBounds.minLat],
  );
  const heightMeters = haversineDistance(
    [zoneBounds.minLng, zoneBounds.minLat],
    [zoneBounds.minLng, zoneBounds.maxLat],
  );

  // Calculate statistics
  const houses = nodes.filter((n) => n.type === "house");
  const totalCableLength = cables.reduce((sum, c) => sum + (c.length || 0), 0);
  const maxOpticalLoss = calculateMaxOpticalLoss(nodes, cables);

  return {
    zoneId,
    bounds: zoneBounds,
    sizeMeters: { width: widthMeters, height: heightMeters },
    adjacent,
    asciiGrid: grid,
    equipment,
    geojson,
    crossZoneLinks,
    issues,
    stats: {
      nodeCount: nodes.length,
      cableCount: cables.length,
      houseCount: houses.length,
      totalCableLength,
      maxOpticalLoss,
    },
  };
}

/**
 * Detect cables that cross zone boundaries
 */
function detectCrossZoneLinks(
  zoneId: string,
  cables: NetworkCable[],
  nodes: NetworkNode[],
  zoneBounds: ZoneBounds,
  zoneGrid: { rows: number; cols: number },
): CrossZoneLink[] {
  const links: CrossZoneLink[] = [];
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  for (const cable of cables) {
    const sourceNode = nodeById.get(cable.source);
    const targetNode = nodeById.get(cable.target);

    if (!sourceNode || !targetNode) continue;

    const sourceInZone = isInBounds(sourceNode.position, zoneBounds);
    const targetInZone = isInBounds(targetNode.position, zoneBounds);

    if (sourceInZone && !targetInZone) {
      // Cable exits this zone
      const targetZone = getZoneForCoordinate(
        targetNode.position,
        {
          minLng: zoneBounds.minLng - (zoneBounds.maxLng - zoneBounds.minLng) * zoneGrid.cols,
          maxLng: zoneBounds.maxLng + (zoneBounds.maxLng - zoneBounds.minLng) * zoneGrid.cols,
          minLat: zoneBounds.minLat - (zoneBounds.maxLat - zoneBounds.minLat) * zoneGrid.rows,
          maxLat: zoneBounds.maxLat + (zoneBounds.maxLat - zoneBounds.minLat) * zoneGrid.rows,
        },
        zoneGrid,
      );

      if (targetZone) {
        links.push({
          cableId: cable.id,
          sourceZone: zoneId,
          sourceNode: cable.source,
          targetZone,
          targetNode: cable.target,
          fiberCount: cable.fiberCount || 1,
          direction: getDirection(sourceNode.position, targetNode.position),
        });
      }
    }
  }

  return links;
}

/**
 * Get cardinal direction from one point to another
 */
function getDirection(
  from: [number, number],
  to: [number, number],
): "north" | "south" | "east" | "west" {
  const dLng = to[0] - from[0];
  const dLat = to[1] - from[1];

  if (Math.abs(dLng) > Math.abs(dLat)) {
    return dLng > 0 ? "east" : "west";
  } else {
    return dLat > 0 ? "north" : "south";
  }
}

/**
 * Check if a coordinate is within bounds
 */
function isInBounds(coord: [number, number], bounds: ZoneBounds): boolean {
  return (
    coord[0] >= bounds.minLng &&
    coord[0] <= bounds.maxLng &&
    coord[1] >= bounds.minLat &&
    coord[1] <= bounds.maxLat
  );
}

// ============================================================================
// Building Crossing Detection
// ============================================================================

/**
 * Check if a cable path crosses any buildings
 * Returns the list of buildings that the cable crosses through
 */
function checkCableBuildingCrossings(
  path: [number, number][],
  buildings: InfrastructureBuilding[],
): InfrastructureBuilding[] {
  if (!path || path.length < 2 || !buildings || buildings.length === 0) {
    return [];
  }

  const crossedBuildings: InfrastructureBuilding[] = [];

  // Check each segment of the cable path
  for (let i = 0; i < path.length - 1; i++) {
    const segmentStart = path[i];
    const segmentEnd = path[i + 1];

    for (const building of buildings) {
      if (crossedBuildings.includes(building)) continue;

      // Check if segment intersects building polygon
      if (segmentCrossesBuilding(segmentStart, segmentEnd, building.coordinates)) {
        crossedBuildings.push(building);
      }
    }
  }

  return crossedBuildings;
}

/**
 * Check if a line segment crosses a building polygon
 */
function segmentCrossesBuilding(
  start: [number, number],
  end: [number, number],
  buildingCoords: [number, number][][],
): boolean {
  // Simple ray-casting check for segment-polygon intersection
  // Check if segment intersects any edge of the building
  const outerRing = buildingCoords[0];
  if (!outerRing || outerRing.length < 3) return false;

  // Check if either endpoint is inside the building
  if (pointInPolygon(start[0], start[1], outerRing) || pointInPolygon(end[0], end[1], outerRing)) {
    return true;
  }

  // Check if segment intersects any edge of the polygon
  for (let i = 0; i < outerRing.length - 1; i++) {
    const edgeStart = outerRing[i];
    const edgeEnd = outerRing[i + 1];
    if (lineSegmentsIntersect(start, end, edgeStart, edgeEnd)) {
      return true;
    }
  }

  return false;
}

/**
 * Check if two line segments intersect
 */
function lineSegmentsIntersect(
  p1: [number, number],
  p2: [number, number],
  p3: [number, number],
  p4: [number, number],
): boolean {
  const d1 = direction(p3, p4, p1);
  const d2 = direction(p3, p4, p2);
  const d3 = direction(p1, p2, p3);
  const d4 = direction(p1, p2, p4);

  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
    return true;
  }

  // Check for collinear cases
  if (d1 === 0 && onSegment(p3, p4, p1)) return true;
  if (d2 === 0 && onSegment(p3, p4, p2)) return true;
  if (d3 === 0 && onSegment(p1, p2, p3)) return true;
  if (d4 === 0 && onSegment(p1, p2, p4)) return true;

  return false;
}

/**
 * Calculate cross product direction for intersection test
 */
function direction(p1: [number, number], p2: [number, number], p3: [number, number]): number {
  return (p3[0] - p1[0]) * (p2[1] - p1[1]) - (p2[0] - p1[0]) * (p3[1] - p1[1]);
}

/**
 * Check if point p3 lies on segment p1-p2 (assuming collinear)
 */
function onSegment(p1: [number, number], p2: [number, number], p3: [number, number]): boolean {
  return (
    Math.min(p1[0], p2[0]) <= p3[0] &&
    p3[0] <= Math.max(p1[0], p2[0]) &&
    Math.min(p1[1], p2[1]) <= p3[1] &&
    p3[1] <= Math.max(p1[1], p2[1])
  );
}

// ============================================================================
// Validation
// ============================================================================

/**
 * Validate a zone and return issues
 */
function validateZone(
  nodes: NetworkNode[],
  cables: NetworkCable[],
  _zoneBounds: ZoneBounds,
  buildings: InfrastructureBuilding[] = [],
): ZoneIssue[] {
  const issues: ZoneIssue[] = [];
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  // Check for cables crossing buildings
  // Note: Drop cables are allowed to cross buildings (they connect closures to homes inside buildings)
  // Only feeder and distribution cables should be flagged for building crossings
  if (buildings.length > 0 && cables.length > 0) {
    for (const cable of cables) {
      if (!cable.path || cable.path.length < 2) continue;

      // Skip drop cables - they're expected to route through buildings to reach homes
      if (cable.cableType === "drop") continue;

      const crossedBuildings = checkCableBuildingCrossings(cable.path, buildings);
      if (crossedBuildings.length > 0) {
        const buildingIds = crossedBuildings
          .map((b) => b.id)
          .slice(0, 3)
          .join(", ");
        const moreText =
          crossedBuildings.length > 3 ? ` (+${crossedBuildings.length - 3} more)` : "";
        issues.push({
          id: `cable-building-${cable.id}`,
          severity: "error",
          type: "cable_crosses_building",
          description: `Cable ${cable.id} crosses through building(s): ${buildingIds}${moreText}`,
          nodeId: cable.source,
          suggestion: "Reroute cable along nearby street to avoid building",
        });
      }
    }
  }

  // Check optical budget for each house
  const houses = nodes.filter((n) => n.type === "house");
  for (const house of houses) {
    const path = findPathToCO(house.id, nodeById, cables);
    if (path) {
      const loss = calculatePathOpticalLoss(path, nodeById, cables);
      if (loss > OPTICAL_CONSTANTS.maxBudget) {
        issues.push({
          id: `optical-${house.id}`,
          severity: "error",
          type: "optical_budget_exceeded",
          description: `Path to ${house.label || house.id}: ${loss.toFixed(1)}dB > ${OPTICAL_CONSTANTS.maxBudget}dB`,
          nodeId: house.id,
          suggestion: "Reduce splitter ratio or add intermediate cabinet",
        });
      }
    }
  }

  // Check for disconnected nodes
  // Only check connectivity if there ARE cables (network has been built)
  // At base stage (before equipment placement), houses are expected to be disconnected
  const connectedNodes = new Set<string>();
  for (const cable of cables) {
    connectedNodes.add(cable.source);
    connectedNodes.add(cable.target);
  }

  // Only flag disconnected nodes if there's actually a network to be connected to
  // (i.e., there are cables AND there's equipment like closures/cabinets)
  const hasNetwork = cables.length > 0;
  const hasEquipment = nodes.some(
    (n) => n.type === "closure" || n.type === "den" || n.type === "cabinet" || n.type === "co",
  );

  if (hasNetwork && hasEquipment) {
    for (const node of nodes) {
      if (!connectedNodes.has(node.id) && node.type !== "co") {
        issues.push({
          id: `disconnected-${node.id}`,
          severity: "error",
          type: "disconnected_node",
          description: `${node.type} ${node.label || node.id} is not connected`,
          nodeId: node.id,
          suggestion: "Connect to nearest upstream node",
        });
      }
    }
  }

  // Check cascade depth
  for (const house of houses) {
    const path = findPathToCO(house.id, nodeById, cables);
    if (path) {
      const splitterCount = path.filter((id) => nodeById.get(id)?.splitterRatio).length;
      if (splitterCount > 2) {
        issues.push({
          id: `cascade-${house.id}`,
          severity: "error",
          type: "cascade_exceeded",
          description: `Path to ${house.label || house.id} has ${splitterCount} splitter levels (max: 2)`,
          nodeId: house.id,
          suggestion: "Reduce cascade by adding cabinet",
        });
      }
    }
  }

  return issues;
}

/**
 * Find path from a node to CO
 */
function findPathToCO(
  startId: string,
  nodeById: Map<string, NetworkNode>,
  cables: NetworkCable[],
): string[] | null {
  // Build adjacency list
  const adjacency = new Map<string, string[]>();
  for (const cable of cables) {
    if (!adjacency.has(cable.source)) adjacency.set(cable.source, []);
    if (!adjacency.has(cable.target)) adjacency.set(cable.target, []);
    adjacency.get(cable.source)!.push(cable.target);
    adjacency.get(cable.target)!.push(cable.source);
  }

  // BFS to find CO
  const queue: { node: string; path: string[] }[] = [{ node: startId, path: [startId] }];
  const visited = new Set<string>([startId]);

  while (queue.length > 0) {
    const { node, path } = queue.shift()!;
    const nodeObj = nodeById.get(node);

    if (nodeObj?.type === "co") {
      return path;
    }

    for (const neighbor of adjacency.get(node) || []) {
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        queue.push({ node: neighbor, path: [...path, neighbor] });
      }
    }
  }

  return null;
}

/**
 * Calculate optical loss for a path
 */
function calculatePathOpticalLoss(
  path: string[],
  nodeById: Map<string, NetworkNode>,
  cables: NetworkCable[],
): number {
  let totalLoss = 0;

  // Fiber loss based on cable length
  for (let i = 0; i < path.length - 1; i++) {
    const cable = cables.find(
      (c) =>
        (c.source === path[i] && c.target === path[i + 1]) ||
        (c.target === path[i] && c.source === path[i + 1]),
    );
    if (cable?.length) {
      totalLoss += (cable.length / 1000) * OPTICAL_CONSTANTS.fiberLossPerKm;
    }
  }

  // Splitter loss
  for (const nodeId of path) {
    const node = nodeById.get(nodeId);
    if (node?.splitterRatio && OPTICAL_CONSTANTS.splitterLoss[node.splitterRatio]) {
      totalLoss += OPTICAL_CONSTANTS.splitterLoss[node.splitterRatio];
    }
  }

  // Connector and splice losses (estimate)
  totalLoss += 3 * OPTICAL_CONSTANTS.connectorLoss;
  totalLoss += 3 * OPTICAL_CONSTANTS.spliceLoss;

  return totalLoss;
}

/**
 * Calculate maximum optical loss in the zone
 */
function calculateMaxOpticalLoss(nodes: NetworkNode[], cables: NetworkCable[]): number {
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const houses = nodes.filter((n) => n.type === "house");

  let maxLoss = 0;
  for (const house of houses) {
    const path = findPathToCO(house.id, nodeById, cables);
    if (path) {
      const loss = calculatePathOpticalLoss(path, nodeById, cables);
      maxLoss = Math.max(maxLoss, loss);
    }
  }

  return maxLoss;
}

// ============================================================================
// Full Text Twin Output
// ============================================================================

/**
 * Format zone as complete text for AI agent
 * Enhanced with 4 layers: ASCII Grid, Lookup Tables, Topology, Validation
 */
export function formatZoneForAgent(
  zone: ZoneTextTwin,
  options: {
    includeGeoJSON?: boolean;
    roads?: InfrastructureRoad[];
    buildings?: InfrastructureBuilding[];
    includeBuildingContents?: boolean;
    includeCustomerOverlay?: boolean;
  } = {},
): string {
  const {
    includeGeoJSON = true,
    roads = [],
    buildings = [],
    includeBuildingContents = true,
    includeCustomerOverlay = true,
  } = options;
  const lines: string[] = [];

  // ══════════════════════════════════════════════════════════════════════════
  // HEADER WITH SCALE METADATA (LLM-optimized for spatial reasoning)
  // ══════════════════════════════════════════════════════════════════════════
  const metersPerCellX = zone.sizeMeters.width / GRID_WIDTH;
  const metersPerCellY = zone.sizeMeters.height / GRID_HEIGHT;

  lines.push(`╔══════════════════════════════════════════════════════════════════════════════╗`);
  lines.push(
    `${`║ ZONE ${zone.zoneId} (${zone.sizeMeters.width.toFixed(0)}m × ${zone.sizeMeters.height.toFixed(0)}m)`.padEnd(
      79,
    )}║`,
  );
  lines.push(`╚══════════════════════════════════════════════════════════════════════════════╝`);
  lines.push(
    `Bounds: [${zone.bounds.minLng.toFixed(5)}, ${zone.bounds.minLat.toFixed(5)}] → [${zone.bounds.maxLng.toFixed(5)}, ${zone.bounds.maxLat.toFixed(5)}]`,
  );

  // SCALE METADATA - Critical for LLM spatial reasoning
  lines.push("");
  lines.push(`SCALE METADATA:`);
  lines.push(`  Grid Size: ${GRID_WIDTH} columns × ${GRID_HEIGHT} rows`);
  lines.push(`  1 column = ${metersPerCellX.toFixed(1)}m (horizontal distance)`);
  lines.push(`  1 row = ${metersPerCellY.toFixed(1)}m (vertical distance)`);
  lines.push(`  Moving north (↑) = decreasing row letter (A→B→C... goes south)`);
  lines.push(`  Moving east (→) = increasing column number (0→1→2...)`);

  // Adjacent zones
  const adjacentList = Object.entries(zone.adjacent)
    .filter(([_, v]) => v)
    .map(
      ([dir, id]) =>
        `${id} ${dir === "north" ? "↑" : dir === "south" ? "↓" : dir === "east" ? "→" : "←"}`,
    )
    .join(" | ");
  lines.push(`Adjacent: ${adjacentList || "none"}`);
  lines.push("");

  // ══════════════════════════════════════════════════════════════════════════
  // LAYER 1: ASCII SPATIAL GRID
  // ══════════════════════════════════════════════════════════════════════════
  lines.push(`╔══════════════════════════════════════════════════════════════════════════════╗`);
  lines.push(`║ LAYER 1: SPATIAL VIEW (ASCII Grid)                                          ║`);
  lines.push(`╚══════════════════════════════════════════════════════════════════════════════╝`);
  lines.push(zone.asciiGrid);
  lines.push("");

  // Legend with [●01] and [F01] format explanations
  lines.push("LEGEND:");
  lines.push(`  Equipment Format: [SYMBOL+SEQ] where SEQ = sequence number`);
  lines.push(`  CO/OLT:    [★01] [★02]...    (Central Office)`);
  lines.push(`  Cabinets:  [◆01] [◆02]...    (T2 Cabinet)`);
  lines.push(`  FDH:       [◇01] [◇02]...    (T3 Cabinet / FDH)`);
  lines.push(`  Closures:  [●01] [●02]...    (Closure/Splitter)`);
  lines.push(`  Houses:    ①②③④⑤...⑳ = Numbered houses (see CONNECTIONS for details)`);
  lines.push(`             ${SYMBOLS.pole}=Pole`);
  lines.push("");
  lines.push(`  Cable Format: [TYPE+SEQ] where TYPE = F/T/D, SEQ = sequence number`);
  lines.push(`  Feeder:    [F01] [F02]...    (CO → Cabinets, shown at midpoint)`);
  lines.push(`  Distrib:   [T01] [T02]...    (Cabinets → Closures, T=Trunk)`);
  lines.push(
    `  Drop:      ${SYMBOLS.cable_drop}=line only       (See CONNECTIONS for house→closure mapping)`,
  );
  lines.push("");
  lines.push(
    `  Terrain:   ${SYMBOLS.building}=Building  ${SYMBOLS.cable_building}=Cable/Building  ${SYMBOLS.sidewalk}=Sidewalk`,
  );
  lines.push(
    `  Roads:     ${SYMBOLS.road_h}/${SYMBOLS.road_v}=Road  ${SYMBOLS.road_cross}=Crossing  ${SYMBOLS.road_corner_nw}${SYMBOLS.road_corner_ne}${SYMBOLS.road_corner_sw}${SYMBOLS.road_corner_se}=Corners`,
  );
  lines.push(
    `  Cables:    ${SYMBOLS.cable_drop}=Drop  ${SYMBOLS.cable_underground}=Underground  ${SYMBOLS.cable_aerial}=Aerial  ${SYMBOLS.cable_road_h}/${SYMBOLS.cable_road_v}=Cable/Road`,
  );
  lines.push(`  Other:     ${SYMBOLS.error}=Error  ${SYMBOLS.zone_link}=Zone Link`);
  lines.push("");

  // ══════════════════════════════════════════════════════════════════════════
  // ELEMENT INDEX (LLM-optimized for quick position lookup)
  // ══════════════════════════════════════════════════════════════════════════
  const closures = zone.equipment.filter((e) => e.type === "closure" || e.type === "den");
  const cabinets = zone.equipment.filter((e) => e.type === "cabinet");
  const cos = zone.equipment.filter((e) => e.type === "co");
  const houses = zone.equipment.filter((e) => e.type === "house");

  if (closures.length > 0 || cabinets.length > 0 || cos.length > 0) {
    lines.push(`╔══════════════════════════════════════════════════════════════════════════════╗`);
    lines.push(`║ ELEMENT INDEX (quick position lookup)                                        ║`);
    lines.push(`╚══════════════════════════════════════════════════════════════════════════════╝`);

    // CO/OLT with [★01] format
    if (cos.length > 0) {
      lines.push("CO/OLT (grid symbol → full ID):");
      for (const co of cos) {
        const gridAnnotation = getEquipmentGridAnnotation(co.id, "co");
        const gridPos = `[${co.gridPosition[0]},${String.fromCharCode(65 + co.gridPosition[1])}]`;
        lines.push(`  ${gridAnnotation} → ${co.id} @ ${gridPos}`);
      }
    }

    // Cabinets with [◆01] format
    if (cabinets.length > 0) {
      lines.push("CABINETS (grid symbol → full ID):");
      for (const cab of cabinets) {
        const cabType = cab.type === "cabinet-t3" ? "cabinet-t3" : "cabinet";
        const gridAnnotation = getEquipmentGridAnnotation(
          cab.id,
          cabType as "cabinet" | "cabinet-t3",
        );
        const gridPos = `[${cab.gridPosition[0]},${String.fromCharCode(65 + cab.gridPosition[1])}]`;
        lines.push(`  ${gridAnnotation} → ${cab.id} @ ${gridPos}`);
      }
    }

    // Closures with [●01] format and ID mapping
    if (closures.length > 0) {
      lines.push("CLOSURES (grid symbol → full ID mapping):");
      lines.push("  Grid Format: [●SEQ] | Full ID Format: [CITY]-[ZONE]-CL-[SEQ]");
      for (const closure of closures) {
        const gridAnnotation = getEquipmentGridAnnotation(
          closure.id,
          closure.type as "closure" | "den",
        );
        const gridPos = `[${closure.gridPosition[0]},${String.fromCharCode(65 + closure.gridPosition[1])}]`;
        const ratio = closure.properties.splitterRatio || "1:8";
        const homeCount = closure.properties.homeCount || closure.properties.connectedHomes || "?";
        lines.push(
          `  ${gridAnnotation} → ${closure.id} @ ${gridPos} (${ratio}, serves ${homeCount} homes)`,
        );
      }
    }

    // Cables with [F01]/[T01] format - only feeder and distribution (drop cables too numerous)
    const cableFeatures = zone.geojson.features.filter(
      (f) => f.geometry.type === "LineString" && f.properties.cableType,
    );
    const feederCables = cableFeatures.filter((c) => c.properties.cableType === "feeder");
    const distCables = cableFeatures.filter((c) => c.properties.cableType === "distribution");
    const dropCables = cableFeatures.filter((c) => c.properties.cableType === "drop");

    if (feederCables.length > 0 || distCables.length > 0) {
      lines.push("CABLES (grid symbol → full ID mapping):");
      lines.push("  Grid Format: [TYPE+SEQ] | F=Feeder, T=Distribution/Trunk");

      // Feeder cables
      if (feederCables.length > 0) {
        lines.push("  Feeder (CO → Cabinets):");
        for (const cable of feederCables) {
          const annotation = getCableGridAnnotation(cable.id, "feeder");
          const source = cable.properties.source || "?";
          const target = cable.properties.target || "?";
          const length =
            typeof cable.properties.length === "number"
              ? `${cable.properties.length.toFixed(0)}m`
              : "?m";
          const fibers = cable.properties.fiberCount || "?";
          lines.push(
            `    ${annotation} → ${cable.id} | ${source} → ${target} | ${length}, ${fibers}F`,
          );
        }
      }

      // Distribution cables
      if (distCables.length > 0) {
        lines.push("  Distribution (Cabinets → Closures):");
        for (const cable of distCables) {
          const annotation = getCableGridAnnotation(cable.id, "distribution");
          const source = cable.properties.source || "?";
          const target = cable.properties.target || "?";
          const length =
            typeof cable.properties.length === "number"
              ? `${cable.properties.length.toFixed(0)}m`
              : "?m";
          const fibers = cable.properties.fiberCount || "?";
          lines.push(
            `    ${annotation} → ${cable.id} | ${source} → ${target} | ${length}, ${fibers}F`,
          );
        }
      }

      lines.push(`  Drop cables: ${dropCables.length} total (see CONNECTIONS section below)`);
    }

    // ════════════════════════════════════════════════════════════════════════════
    // CONNECTIONS SECTION - Maps closures → houses → drop cables
    // This gives LLM full context to reference any house or drop cable
    // ════════════════════════════════════════════════════════════════════════════
    if (houses.length > 0 && dropCables.length > 0) {
      lines.push("");
      lines.push("CONNECTIONS (closure → house via drop cable):");
      lines.push("  Format: ① house_id | address | via drop_id | distance | status");
      lines.push("");

      // Group drop cables by source closure
      const closureToHouses = new Map<
        string,
        Array<{
          houseIndex: number;
          houseId: string;
          houseSymbol: string;
          dropCableId: string;
          distance: number;
          address: string;
          isValid: boolean;
        }>
      >();

      // Build house ID to index map
      const houseIdToIndex = new Map<string, number>();
      houses.forEach((house, idx) => {
        houseIdToIndex.set(house.id, idx + 1);
      });

      // Process each drop cable to find closure→house connections
      for (const cable of dropCables) {
        const source = cable.properties.source as string | undefined;
        const target = cable.properties.target as string | undefined;
        const length = typeof cable.properties.length === "number" ? cable.properties.length : 0;

        // Determine which is closure and which is house
        const isSourceClosure = closures.some((c) => c.id === source);
        const isTargetHouse = houses.some((h) => h.id === target);
        const isSourceHouse = houses.some((h) => h.id === source);
        const isTargetClosure = closures.some((c) => c.id === target);

        let closureId: string | undefined;
        let houseId: string | undefined;

        if (isSourceClosure && isTargetHouse) {
          closureId = source;
          houseId = target;
        } else if (isSourceHouse && isTargetClosure) {
          closureId = target;
          houseId = source;
        }

        if (closureId && houseId) {
          if (!closureToHouses.has(closureId)) {
            closureToHouses.set(closureId, []);
          }

          const houseIndex = houseIdToIndex.get(houseId) || 0;
          const houseSymbol = getNumberedHouseSymbol(houseIndex);
          const house = houses.find((h) => h.id === houseId);
          const address =
            (house?.properties?.address as string) ||
            (house?.properties?.label as string) ||
            "unknown address";

          // Validate drop cable distance (typically max 30m for FTTH)
          const isValid = length <= 50; // 50m is a generous limit

          closureToHouses.get(closureId)!.push({
            houseIndex,
            houseId,
            houseSymbol,
            dropCableId: cable.id,
            distance: length,
            address,
            isValid,
          });
        }
      }

      // Output connections grouped by closure
      for (const closure of closures) {
        const connections = closureToHouses.get(closure.id) || [];
        const gridAnnotation = getEquipmentGridAnnotation(
          closure.id,
          closure.type as "closure" | "den",
        );
        const ratio = (closure.properties.splitterRatio as string) || "1:?";

        if (connections.length > 0) {
          lines.push(
            `  ${gridAnnotation} ${closure.id} (${ratio}) serves ${connections.length} houses:`,
          );

          // Sort by house index for consistent ordering
          connections.sort((a, b) => a.houseIndex - b.houseIndex);

          for (const conn of connections) {
            const distStr = conn.distance > 0 ? `${conn.distance.toFixed(0)}m` : "?m";
            const status = conn.isValid ? "✓" : "⚠ too long";
            lines.push(
              `    ${conn.houseSymbol} ${conn.houseId} | ${conn.address} | via ${conn.dropCableId} | ${distStr} | ${status}`,
            );
          }
          lines.push("");
        } else {
          lines.push(`  ${gridAnnotation} ${closure.id} (${ratio}): no connected houses found`);
        }
      }

      // Summary
      const totalConnections = Array.from(closureToHouses.values()).reduce(
        (sum, arr) => sum + arr.length,
        0,
      );
      const invalidConnections = Array.from(closureToHouses.values())
        .flat()
        .filter((c) => !c.isValid).length;
      lines.push(`  SUMMARY: ${totalConnections} connections, ${invalidConnections} issues`);
    } else {
      lines.push(`HOUSES: ${houses.length} total`);
    }
    lines.push("");

    // ══════════════════════════════════════════════════════════════════════════
    // CLOSURE NEIGHBORHOOD ANALYSIS (LLM-optimized for spatial reasoning)
    // ══════════════════════════════════════════════════════════════════════════
    if (closures.length > 0) {
      const neighborhoods = buildClosureNeighborhoods(zone.equipment, zone.asciiGrid, zone.bounds);

      lines.push(
        `╔══════════════════════════════════════════════════════════════════════════════╗`,
      );
      lines.push(
        `║ CLOSURE NEIGHBORHOOD ANALYSIS (for spatial reasoning)                        ║`,
      );
      lines.push(
        `╚══════════════════════════════════════════════════════════════════════════════╝`,
      );

      for (const nb of neighborhoods) {
        const gridPos = `[${nb.gridPosition[0]},${String.fromCharCode(65 + nb.gridPosition[1])}]`;
        lines.push(`${nb.closureSymbol} ${nb.closureId} @ ${gridPos}:`);

        // Adjacent cells
        lines.push(
          `  Adjacent: N:${nb.adjacent.north} S:${nb.adjacent.south} E:${nb.adjacent.east} W:${nb.adjacent.west}`,
        );

        // Distances
        const roadDist =
          nb.nearestRoadDistance !== null ? `${nb.nearestRoadDistance.toFixed(0)}m` : "none";
        const bldgDist =
          nb.nearestBuildingDistance !== null
            ? `${nb.nearestBuildingDistance.toFixed(0)}m`
            : "none";
        lines.push(`  Distances: road=${roadDist}, building=${bldgDist}`);

        // Nearby closures
        if (nb.closureDistances.length > 0) {
          const nearbyStr = nb.closureDistances
            .map((c) => `${c.symbol}(${c.distance.toFixed(0)}m)`)
            .join(", ");
          lines.push(`  Nearby closures: ${nearbyStr}`);
        }

        // Clearance status
        const status: string[] = [];
        if (nb.clearance.hasRoadAccess) status.push("✓road_access");
        else status.push("✗no_road_access");
        if (nb.clearance.isOnSidewalk) status.push("✓on_sidewalk");
        if (nb.clearance.isNearBuilding) status.push("⚠near_building");
        if (nb.clearance.recommendedForMove) status.push("⚠recommend_reposition");
        lines.push(`  Status: ${status.join(" ")}`);
        lines.push("");
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // LAYER 2: LOOKUP TABLES
  // ══════════════════════════════════════════════════════════════════════════
  const cables = zone.geojson.features.filter((f) => f.geometry.type === "LineString");
  const addressLookups = buildAddressLookup(zone.equipment, cables);
  const streetLookups = buildStreetLookup(zone.equipment, roads);
  const closureTopology = buildClosureTopology(zone.equipment, cables);

  lines.push(`╔══════════════════════════════════════════════════════════════════════════════╗`);
  lines.push(`║ LAYER 2: LOOKUP TABLES                                                      ║`);
  lines.push(`╚══════════════════════════════════════════════════════════════════════════════╝`);

  // Address → Node lookup
  lines.push("ADDRESS → NODE:");
  const houseLookups = addressLookups.filter((l) => l.nodeType === "house").slice(0, 15);
  if (houseLookups.length > 0) {
    for (const lookup of houseLookups) {
      const gridPos = `grid:[${lookup.gridPosition[0]},${String.fromCharCode(65 + lookup.gridPosition[1])}]`;
      // Use closure label (CL-001) instead of raw ID (closure-0) for consistency
      const closureRef = lookup.closureLabel
        ? `→ ${lookup.closureLabel}`
        : lookup.closureId
          ? `→ ${lookup.closureId}`
          : "[disconnected]";
      lines.push(`  "${lookup.address}" → ${lookup.nodeId}  ${gridPos}  ${closureRef}`);
    }
    if (addressLookups.filter((l) => l.nodeType === "house").length > 15) {
      lines.push(
        `  ... and ${addressLookups.filter((l) => l.nodeType === "house").length - 15} more houses`,
      );
    }
  } else {
    lines.push("  (no houses in this zone)");
  }
  lines.push("");

  // Street → Nodes lookup
  lines.push("STREET → NODES:");
  if (streetLookups.length > 0) {
    for (const street of streetLookups.slice(0, 10)) {
      const typeSummary = Object.entries(street.nodeTypes)
        .map(([type, count]) => `${count} ${type}${count > 1 ? "s" : ""}`)
        .join(", ");
      lines.push(
        `  "${street.streetName}" → [${street.nodeIds.slice(0, 5).join(", ")}${street.nodeIds.length > 5 ? "..." : ""}] (${typeSummary})`,
      );
    }
  } else {
    lines.push("  (no street associations available)");
  }
  lines.push("");

  // Closure → Houses topology
  lines.push("CLOSURE → HOUSES:");
  if (closureTopology.length > 0) {
    for (const topo of closureTopology) {
      // Use consistent label format: CL-001, CL-002, etc.
      // If no label, generate from ID (closure-0 → CL-001)
      const displayLabel =
        topo.closureLabel ||
        `CL-${String(parseInt(topo.closureId.split("-")[1] || "0", 10) + 1).padStart(3, "0")}`;
      lines.push(
        `  ${displayLabel} (${topo.splitterRatio}) → ${topo.connectedHouses.length}/${topo.capacity} used, ${topo.availablePorts} available`,
      );
      for (const house of topo.connectedHouses.slice(0, 5)) {
        const addr = house.address ? ` "${house.address}"` : "";
        lines.push(`    └── ${house.houseId}${addr}`);
      }
      if (topo.connectedHouses.length > 5) {
        lines.push(`    └── ... and ${topo.connectedHouses.length - 5} more`);
      }
    }
  } else {
    lines.push("  (no closures in this zone)");
  }
  lines.push("");

  // ══════════════════════════════════════════════════════════════════════════
  // LAYER 2B: BUILDING CONTENTS (B+D Solution Part B)
  // Shows all houses inside buildings that may be hidden by ▓ symbols
  // ══════════════════════════════════════════════════════════════════════════
  if (includeBuildingContents && buildings.length > 0) {
    const buildingContents = buildBuildingContents(zone.equipment, cables, buildings, zone.bounds);

    if (buildingContents.length > 0) {
      lines.push(
        `╔══════════════════════════════════════════════════════════════════════════════╗`,
      );
      lines.push(`║ LAYER 2B: BUILDING CONTENTS (houses hidden behind ▓ symbols)                ║`);
      lines.push(
        `╚══════════════════════════════════════════════════════════════════════════════╝`,
      );
      lines.push("");

      for (const bldg of buildingContents) {
        const gridPos = `[${bldg.gridPosition[0]},${String.fromCharCode(65 + bldg.gridPosition[1])}]`;
        lines.push(
          `📍 ${bldg.buildingId} at grid:${gridPos} - ${bldg.houseCount} house${bldg.houseCount !== 1 ? "s" : ""}`,
        );

        // Show closure assignments summary
        const closureList = Object.entries(bldg.closureAssignments)
          .map(([cId, count]) => `${cId}(${count})`)
          .join(", ");
        if (closureList) {
          lines.push(`   Served by: ${closureList}`);
        }

        // List houses
        for (const house of bldg.houses) {
          const addr = house.address ? `"${house.address}"` : house.houseId;
          const closure = house.closureId
            ? ` → ${house.closureLabel || house.closureId}`
            : " [disconnected]";
          const dist = house.dropDistance ? ` (${house.dropDistance.toFixed(0)}m)` : "";
          lines.push(`   • ${addr}${closure}${dist}`);
        }
        lines.push("");
      }

      // Summary statistics
      const totalHousesInBuildings = buildingContents.reduce((sum, b) => sum + b.houseCount, 0);
      const totalHouses = zone.equipment.filter((e) => e.type === "house").length;
      const percentHidden =
        totalHouses > 0 ? ((totalHousesInBuildings / totalHouses) * 100).toFixed(0) : 0;
      lines.push(
        `BUILDING SUMMARY: ${buildingContents.length} building(s) contain ${totalHousesInBuildings} house(s) (${percentHidden}% of all houses)`,
      );
      lines.push(
        "NOTE: These houses are inside buildings and may be hidden by ▓ in the ASCII grid above.",
      );
      lines.push("");
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // LAYER 2C: CUSTOMER OVERLAY (B+D Solution Part D)
  // Separate grid showing ONLY houses, spread to avoid compression
  // ══════════════════════════════════════════════════════════════════════════
  if (includeCustomerOverlay && zone.equipment.some((e) => e.type === "house")) {
    const customerOverlay = generateCustomerOverlay(zone.equipment, cables, buildings, zone.bounds);

    if (customerOverlay.totalHouses > 0) {
      lines.push(
        `╔══════════════════════════════════════════════════════════════════════════════╗`,
      );
      lines.push(`║ LAYER 2C: CUSTOMER OVERLAY (houses only - no buildings/roads)               ║`);
      lines.push(
        `╚══════════════════════════════════════════════════════════════════════════════╝`,
      );
      lines.push(customerOverlay.grid);
      lines.push("");

      // Legend for numbered houses (when multiple houses share a cell)
      const numberedHouses = customerOverlay.legend.filter((l) => /^[0-9A-Z]$/.test(l.symbol));
      if (numberedHouses.length > 0) {
        lines.push("OVERLAY LEGEND (numbered houses = multiple houses in same location):");
        for (const entry of numberedHouses.slice(0, 20)) {
          const addr = entry.address ? `"${entry.address}"` : entry.houseId;
          // Convert closureId (closure-0) to label format (CL-001) for consistency
          const closureLabel = entry.closureId
            ? `CL-${String(parseInt(entry.closureId.split("-")[1] || "0", 10) + 1).padStart(3, "0")}`
            : null;
          const closure = closureLabel ? ` → ${closureLabel}` : "";
          lines.push(`  ${entry.symbol}: ${addr}${closure}`);
        }
        if (numberedHouses.length > 20) {
          lines.push(`  ... and ${numberedHouses.length - 20} more`);
        }
        lines.push("");
      }

      // Visibility statistics
      lines.push(
        `VISIBILITY: ${customerOverlay.housesVisible}/${customerOverlay.totalHouses} houses shown`,
      );
      if (customerOverlay.housesInBuildings > 0) {
        lines.push(
          `NOTE: ${customerOverlay.housesInBuildings} houses are inside buildings (now visible in this overlay)`,
        );
      }
      lines.push("");
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // LAYER 3: TOPOLOGY & HIERARCHY
  // ══════════════════════════════════════════════════════════════════════════
  lines.push(`╔══════════════════════════════════════════════════════════════════════════════╗`);
  lines.push(`║ LAYER 3: TOPOLOGY                                                           ║`);
  lines.push(`╚══════════════════════════════════════════════════════════════════════════════╝`);

  // Hierarchy tree
  lines.push("HIERARCHY:");
  const hierarchyTree = generateHierarchyTree(zone.equipment, cables);
  lines.push(hierarchyTree);
  lines.push("");

  // Cables by tier
  const cablesByTier = buildCablesByTier(cables);
  lines.push("CABLES BY TIER:");
  lines.push(
    `  Feeder:       ${cablesByTier.feeder.length} cable(s), ${cablesByTier.totals.feederLength.toFixed(0)}m total, ${cablesByTier.totals.feederFibers}F`,
  );
  lines.push(
    `  Distribution: ${cablesByTier.distribution.length} cable(s), ${cablesByTier.totals.distributionLength.toFixed(0)}m total, ${cablesByTier.totals.distributionFibers}F`,
  );
  lines.push(
    `  Drop:         ${cablesByTier.drop.length} cable(s), ${cablesByTier.totals.dropLength.toFixed(0)}m total`,
  );
  lines.push("");

  // Build and format Cable Inventory for LLM cable identification
  // Extract cables from GeoJSON features
  const cableFeaturesForInventory = zone.geojson.features.filter(
    (f) => f.geometry.type === "LineString" && f.properties.cableType,
  );

  if (cableFeaturesForInventory.length > 0) {
    const cableInventory = buildCableInventory(
      cableFeaturesForInventory,
      zone.equipment,
      zone.bounds,
      buildings,
      roads,
    );

    if (cableInventory.length > 0) {
      const inventorySection = formatCableInventory(cableInventory, true);
      lines.push(inventorySection);
      lines.push("");
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // LAYER 4: VALIDATION STATUS
  // ══════════════════════════════════════════════════════════════════════════
  lines.push(`╔══════════════════════════════════════════════════════════════════════════════╗`);
  lines.push(`║ LAYER 4: VALIDATION                                                         ║`);
  lines.push(`╚══════════════════════════════════════════════════════════════════════════════╝`);

  if (zone.issues.length > 0) {
    lines.push(`ISSUES (${zone.issues.length}):`);
    zone.issues.forEach((issue, index) => {
      const issueId = generateIssueId(issue, zone.zoneId, index);
      const icon = issue.severity === "error" ? "❌" : issue.severity === "warning" ? "⚠️" : "ℹ️";
      lines.push(`  [${issueId}] ${icon} ${issue.severity.toUpperCase()} ${issue.type}`);
      lines.push(`    ${issue.description}`);
      if (issue.nodeId) {
        lines.push(`    Affected: ${issue.nodeId}`);
      }

      // Add fix suggestion
      const fix = suggestFixTool(issue);
      if (fix) {
        lines.push(`    Fix: { tool: "${fix.tool}", params: ${JSON.stringify(fix.params)} }`);
        lines.push(`         ${fix.description}`);
      } else if (issue.suggestion) {
        lines.push(`    Suggestion: ${issue.suggestion}`);
      }
      lines.push("");
    });
  } else {
    lines.push("✅ NO ISSUES - Zone validation passed");
    lines.push("");
  }

  // ══════════════════════════════════════════════════════════════════════════
  // EQUIPMENT LIST
  // ══════════════════════════════════════════════════════════════════════════
  lines.push("EQUIPMENT LIST:");
  for (const eq of zone.equipment) {
    const gridCol = eq.gridPosition[0];
    const gridRow = String.fromCharCode(65 + eq.gridPosition[1]);
    const props = Object.entries(eq.properties)
      .filter(([_, v]) => v !== undefined)
      .map(([k, v]) => `${k}:${v}`)
      .join(" ");
    lines.push(
      `  ${eq.symbol} ${eq.id.padEnd(20)} grid:[${gridCol},${gridRow}] coords:[${eq.coordinates[0].toFixed(5)},${eq.coordinates[1].toFixed(5)}] ${props}`,
    );
  }
  lines.push("");

  // ══════════════════════════════════════════════════════════════════════════
  // CROSS-ZONE LINKS
  // ══════════════════════════════════════════════════════════════════════════
  if (zone.crossZoneLinks.length > 0) {
    lines.push("CROSS-ZONE LINKS:");
    for (const link of zone.crossZoneLinks) {
      const arrow =
        link.direction === "east"
          ? "→"
          : link.direction === "west"
            ? "←"
            : link.direction === "north"
              ? "↑"
              : "↓";
      lines.push(
        `  ${link.sourceNode} ${arrow} ${link.targetZone}:${link.targetNode} (${link.fiberCount}F)`,
      );
    }
    lines.push("");
  }

  // ══════════════════════════════════════════════════════════════════════════
  // STATISTICS
  // ══════════════════════════════════════════════════════════════════════════
  lines.push("STATS:");
  lines.push(
    `  Nodes: ${zone.stats.nodeCount} | Cables: ${zone.stats.cableCount} | Houses: ${zone.stats.houseCount}`,
  );
  lines.push(
    `  Cable length: ${zone.stats.totalCableLength.toFixed(0)}m | Max optical loss: ${zone.stats.maxOpticalLoss.toFixed(1)}dB (limit: 28dB)`,
  );
  lines.push("");

  // ══════════════════════════════════════════════════════════════════════════
  // GEOJSON (editable source)
  // ══════════════════════════════════════════════════════════════════════════
  if (includeGeoJSON) {
    lines.push("═══════════════════════════════════════════════════════════════════════════════");
    lines.push("GEOJSON (edit this to modify network):");
    lines.push(JSON.stringify(zone.geojson, null, 2));
  }

  return lines.join("\n");
}

// ============================================================================
// Service Area Assembler (Combine All Zones)
// ============================================================================

/**
 * Generate complete DataStore for an entire service area
 */
export function generateDataStore(
  name: string,
  bounds: ZoneBounds,
  nodes: NetworkNode[],
  cables: NetworkCable[],
  infrastructure: {
    roads?: InfrastructureRoad[];
    buildings?: InfrastructureBuilding[];
    poles?: InfrastructurePole[];
  },
  zoneSize: { width: number; height: number } = DEFAULT_ZONE_SIZE,
  debug: boolean = false,
  routingGraph?: RoutingGraph,
  surveyEnrichments?: Map<string, SurveyEnrichment>,
): ServiceAreaTextTwin {
  // 1. Divide into zones
  const { zoneGrid, zoneBounds } = divideIntoZones(bounds, zoneSize);

  // 2. Assign nodes and cables to zones
  const nodesByZone = new Map<string, NetworkNode[]>();
  const cablesByZone = new Map<string, NetworkCable[]>();

  // Initialize zone maps
  for (const zoneId of zoneBounds.keys()) {
    nodesByZone.set(zoneId, []);
    cablesByZone.set(zoneId, []);
  }

  // Assign nodes to zones based on position
  for (const node of nodes) {
    const zoneId = getZoneForCoordinate(node.position, bounds, zoneGrid);
    if (zoneId && nodesByZone.has(zoneId)) {
      nodesByZone.get(zoneId)!.push(node);
    }
  }

  // Assign cables to zones (based on source node position)
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  for (const cable of cables) {
    const sourceNode = nodeById.get(cable.source);
    if (sourceNode) {
      const zoneId = getZoneForCoordinate(sourceNode.position, bounds, zoneGrid);
      if (zoneId && cablesByZone.has(zoneId)) {
        cablesByZone.get(zoneId)!.push(cable);
      }
    }
  }

  // 3. Generate Text Twin for each zone
  const zones = new Map<string, ZoneTextTwin>();
  const allCrossZoneLinks: CrossZoneLink[] = [];

  for (const [zoneId, zoneBound] of zoneBounds) {
    const zoneNodes = nodesByZone.get(zoneId) || [];
    const zoneCables = cablesByZone.get(zoneId) || [];

    // Filter infrastructure to zone bounds
    // Note: road.coordinates must exist and have at least one coord in zone
    const zoneRoads = infrastructure.roads?.filter((road) =>
      road.coordinates?.some((coord) => isInBounds(coord, zoneBound)),
    );
    const zoneBuildings = infrastructure.buildings?.filter(
      (b) => b.centroid && isInBounds(b.centroid, zoneBound),
    );

    const zoneTwin = generateDataStoreZone(
      zoneId,
      zoneBound,
      zoneNodes,
      zoneCables,
      { roads: zoneRoads, buildings: zoneBuildings },
      zoneGrid,
      debug,
    );

    zones.set(zoneId, zoneTwin);
    allCrossZoneLinks.push(...zoneTwin.crossZoneLinks);
  }

  // 4. Aggregate global statistics
  const globalStats = aggregateZoneStats(zones);

  // 5. Collect global issues
  const globalIssues = collectGlobalIssues(zones, allCrossZoneLinks);

  // 6. Generate INDEX.json for fast lookups
  // Build the required data structures
  const houses: NetworkNodeInput[] = [];
  const closures: NetworkNodeInput[] = [];
  const cabinets: NetworkNodeInput[] = [];
  const zoneForNode = new Map<string, string>();

  for (const node of nodes) {
    const nodeInput: NetworkNodeInput = {
      id: node.id,
      type: node.type,
      position: node.position,
      label: node.label,
      address: node.address || node.label, // Use address from node (address matching), fallback to label
      splitterRatio: node.splitterRatio,
      fiberCount: node.totalFibers,
    };

    // Determine zone for this node
    const zoneId = getZoneForCoordinate(node.position, bounds, zoneGrid);
    if (zoneId) {
      zoneForNode.set(node.id, zoneId);
    }

    // Categorize by type
    if (node.type === "house") {
      houses.push(nodeInput);
    } else if (node.type === "closure" || node.type === "den") {
      closures.push(nodeInput);
    } else if (node.type === "cabinet") {
      cabinets.push(nodeInput);
    }
  }

  // Convert cables to NetworkCableInput format
  const cableInputs: NetworkCableInput[] = cables.map((c) => ({
    id: c.id,
    source: c.source,
    target: c.target,
    cableType: c.cableType,
    fiberCount: c.fiberCount,
    length: c.length,
  }));

  // Generate the index
  const indexInput: GenerateIndexInput = {
    houses,
    cables: cableInputs,
    closures,
    cabinets,
    nodeById,
    zoneForNode,
  };
  const index = generateIndex(indexInput);

  // 7. Generate PROJECT.md agent memory
  const projectMd = generateProjectMd(
    name,
    `Service area with ${globalStats.totalHouses} addresses`,
    globalStats.totalHouses,
  );

  // 8. Generate per-closure fiber data and splice diagrams
  const closureFibersMap = new Map<string, ClosureFibersData>();
  const closureSpliceMap = new Map<string, string>();

  for (const closureNode of closures) {
    // Find incoming cable for this closure
    const incomingCable = cables.find((c) => c.target === closureNode.id);

    // Find connected homes (houses where this closure is the source)
    const connectedHomes = houses.filter((h) => {
      const dropCable = cables.find((c) => c.target === h.id && c.source === closureNode.id);
      return !!dropCable;
    });

    // Find downstream closures (closures where this closure is the source)
    const downstreamClosures = closures.filter((dc) => {
      return (
        dc.id !== closureNode.id &&
        cables.some((c) => c.source === closureNode.id && c.target === dc.id)
      );
    });

    // Generate fibers.json data
    const fibersData = generateClosureFibersJson(
      closureNode,
      incomingCable
        ? {
            id: incomingCable.id,
            source: incomingCable.source,
            target: incomingCable.target,
            cableType: incomingCable.cableType,
            fiberCount: incomingCable.fiberCount,
            length: incomingCable.length,
          }
        : null,
      connectedHomes,
      downstreamClosures,
      cableInputs,
      nodeById as Map<string, NetworkNodeInput>,
    );

    closureFibersMap.set(closureNode.id, fibersData);

    // Generate splice.txt ASCII diagram
    const spliceTxt = generateClosureSpliceTxt({
      closureId: closureNode.id,
      location: closureNode.label || closureNode.id,
      splitterRatio: closureNode.splitterRatio || "1:8",
      fibersData,
      showColors: true,
      showPorts: true,
    });

    closureSpliceMap.set(closureNode.id, spliceTxt);
  }

  // 8b. Generate per-closure DataStore files (hardware, optical budget, verification, photos, markdown)
  const closureHardwareMap = new Map<string, ClosureHardwareData>();
  const closureOpticalBudgetMap = new Map<string, ClosureOpticalBudgetData>();
  const closureVerificationMap = new Map<string, ClosureVerificationData>();
  const closurePhotosMap = new Map<string, ClosurePhotosData>();
  const closureMarkdownMap = new Map<string, string>();

  for (const [closureId, fibersData] of closureFibersMap) {
    closureHardwareMap.set(closureId, generateClosureHardware(fibersData, closureId));
    closureOpticalBudgetMap.set(closureId, generateClosureOpticalBudget(fibersData, closureId));
    closureVerificationMap.set(closureId, generateClosureVerification(closureId));
    closurePhotosMap.set(closureId, generateClosurePhotos(closureId));
    closureMarkdownMap.set(closureId, generateClosureMd(fibersData, closureId));
  }

  const closureIndex: ClosureIndexData = generateClosureIndex(
    closureFibersMap,
    closureOpticalBudgetMap,
  );

  // 9. Export routing graph to JSON (if provided)
  const routingGraphJson = routingGraph ? exportRoutingGraphToJSON(routingGraph) : undefined;

  // 10. Generate addresses.json with survey enrichment data
  const addressesData = generateAddressesData({
    houses: houses.map((h) => ({
      ...h,
      type: "house" as const,
    })),
    closures: closures.map((c) => ({
      ...c,
      type: c.type === "den" ? ("closure" as const) : (c.type as "closure"),
    })),
    cables: cableInputs,
    zoneForNode,
    surveyEnrichments,
    // opticalLossMap would be passed in if pre-calculated
  });

  return {
    name,
    bounds,
    zoneGrid: {
      rows: zoneGrid.rows,
      cols: zoneGrid.cols,
      zoneSize,
    },
    zones,
    allCrossZoneLinks,
    infrastructure: {
      roads: infrastructure.roads || [],
      buildings: infrastructure.buildings || [],
      poles: infrastructure.poles || [],
    },
    stats: globalStats,
    globalIssues,
    // NEW: Add generated DataStore data
    index,
    projectMd,
    closureFibersMap,
    closureSpliceMap,
    closureHardwareMap,
    closureOpticalBudgetMap,
    closureVerificationMap,
    closurePhotosMap,
    closureMarkdownMap,
    closureIndex,
    routingGraphJson,
    addressesData,
  };
}

/**
 * Aggregate statistics from all zones
 */
function aggregateZoneStats(zones: Map<string, ZoneTextTwin>): ServiceAreaTextTwin["stats"] {
  let totalNodes = 0;
  let totalCables = 0;
  let totalHouses = 0;
  let totalCableLength = 0;
  let maxOpticalLoss = 0;
  let zonesWithEquipment = 0;

  for (const zone of zones.values()) {
    totalNodes += zone.stats.nodeCount;
    totalCables += zone.stats.cableCount;
    totalHouses += zone.stats.houseCount;
    totalCableLength += zone.stats.totalCableLength;
    maxOpticalLoss = Math.max(maxOpticalLoss, zone.stats.maxOpticalLoss);
    if (zone.stats.nodeCount > 0) {
      zonesWithEquipment++;
    }
  }

  const coveragePercent = zones.size > 0 ? (zonesWithEquipment / zones.size) * 100 : 0;

  return {
    totalZones: zones.size,
    totalNodes,
    totalCables,
    totalHouses,
    totalCableLength,
    maxOpticalLoss,
    coveragePercent,
  };
}

/**
 * Collect global validation issues across zones
 */
function collectGlobalIssues(
  zones: Map<string, ZoneTextTwin>,
  crossZoneLinks: CrossZoneLink[],
): ZoneIssue[] {
  const issues: ZoneIssue[] = [];

  // Check for missing cross-zone connections
  const zonePairs = new Set<string>();
  for (const link of crossZoneLinks) {
    const pair = [link.sourceZone, link.targetZone].sort().join("-");
    zonePairs.add(pair);
  }

  // Check adjacent zones have connections
  for (const [zoneId, zone] of zones) {
    const adjacent = zone.adjacent;
    for (const [direction, adjZoneId] of Object.entries(adjacent)) {
      if (!adjZoneId) continue;
      const pair = [zoneId, adjZoneId].sort().join("-");
      const hasConnection = zonePairs.has(pair);

      // Check if both zones have equipment
      const adjZone = zones.get(adjZoneId);
      const zoneHasEquipment = zone.stats.nodeCount > 0;
      const adjHasEquipment = adjZone && adjZone.stats.nodeCount > 0;

      if (zoneHasEquipment && adjHasEquipment && !hasConnection) {
        issues.push({
          id: `missing-link-${pair}`,
          severity: "warning",
          type: "missing_cross_zone_link",
          description: `No fiber connection between zones ${zoneId} and ${adjZoneId} (${direction})`,
          suggestion: "Consider adding distribution cable between zones",
        });
      }
    }
  }

  // Check for zones with errors
  for (const [zoneId, zone] of zones) {
    const errorCount = zone.issues.filter((i) => i.severity === "error").length;
    if (errorCount > 0) {
      issues.push({
        id: `zone-errors-${zoneId}`,
        severity: "error",
        type: "zone_has_errors",
        description: `Zone ${zoneId} has ${errorCount} validation error${errorCount !== 1 ? "s" : ""}`,
        suggestion: `Review zone ${zoneId} issues`,
      });
    }
  }

  // Check for excessive optical loss paths
  const zonesWithHighLoss = Array.from(zones.entries()).filter(
    ([_, z]) => z.stats.maxOpticalLoss > 25,
  );
  if (zonesWithHighLoss.length > 0) {
    issues.push({
      id: "high-optical-loss-zones",
      severity: "warning",
      type: "high_optical_loss",
      description: `${zonesWithHighLoss.length} zone${zonesWithHighLoss.length !== 1 ? "s" : ""} with optical loss > 25dB (approaching 28dB limit)`,
      suggestion: "Consider adding intermediate cabinets or reducing splitter ratios",
    });
  }

  return issues;
}

/**
 * Format entire service area as text for AI agent
 */
export function formatServiceAreaForAgent(
  serviceArea: ServiceAreaTextTwin,
  options: {
    includeAllZones?: boolean;
    focusZone?: string;
    maxZonesToShow?: number;
  } = {},
): string {
  const { includeAllZones = false, focusZone, maxZonesToShow = 4 } = options;
  const lines: string[] = [];

  // Header
  lines.push(`╔════════════════════════════════════════════════════════════════════╗`);
  lines.push(`║  SERVICE AREA: ${serviceArea.name.padEnd(48)} ║`);
  lines.push(`╚════════════════════════════════════════════════════════════════════╝`);
  lines.push("");

  // Grid overview
  lines.push(`ZONE GRID: ${serviceArea.zoneGrid.rows} rows × ${serviceArea.zoneGrid.cols} cols`);
  lines.push(
    `Zone size: ${serviceArea.zoneGrid.zoneSize.width}m × ${serviceArea.zoneGrid.zoneSize.height}m`,
  );
  lines.push("");

  // Generate zone map
  lines.push("ZONE MAP:");
  lines.push(generateZoneOverviewMap(serviceArea));
  lines.push("");

  // Global statistics
  lines.push("GLOBAL STATISTICS:");
  lines.push(`  Total zones: ${serviceArea.stats.totalZones}`);
  lines.push(`  Total nodes: ${serviceArea.stats.totalNodes}`);
  lines.push(`  Total cables: ${serviceArea.stats.totalCables}`);
  lines.push(`  Total houses: ${serviceArea.stats.totalHouses}`);
  lines.push(`  Cable length: ${serviceArea.stats.totalCableLength.toFixed(0)}m`);
  lines.push(`  Max optical loss: ${serviceArea.stats.maxOpticalLoss.toFixed(1)}dB`);
  lines.push(`  Coverage: ${serviceArea.stats.coveragePercent.toFixed(0)}%`);
  lines.push("");

  // Global issues
  if (serviceArea.globalIssues.length > 0) {
    lines.push("GLOBAL ISSUES:");
    for (const issue of serviceArea.globalIssues) {
      const icon = issue.severity === "error" ? "❌" : issue.severity === "warning" ? "⚠️" : "ℹ️";
      lines.push(`  ${icon} ${issue.description}`);
      if (issue.suggestion) {
        lines.push(`     → ${issue.suggestion}`);
      }
    }
    lines.push("");
  }

  // Cross-zone links summary
  if (serviceArea.allCrossZoneLinks.length > 0) {
    lines.push("CROSS-ZONE CONNECTIONS:");
    const linksByDirection = groupLinksByDirection(serviceArea.allCrossZoneLinks);
    for (const [direction, links] of Object.entries(linksByDirection)) {
      lines.push(`  ${direction}: ${links.length} connection${links.length !== 1 ? "s" : ""}`);
    }
    lines.push("");
  }

  // Zone details
  if (focusZone) {
    // Show single focused zone
    const zone = serviceArea.zones.get(focusZone);
    if (zone) {
      lines.push("═".repeat(72));
      lines.push(`FOCUSED ZONE: ${focusZone}`);
      lines.push("═".repeat(72));
      lines.push(
        formatZoneForAgent(zone, {
          roads: serviceArea.infrastructure.roads,
          buildings: serviceArea.infrastructure.buildings,
          includeBuildingContents: true,
          includeCustomerOverlay: true,
        }),
      );
    }
  } else if (includeAllZones) {
    // Show all zones
    for (const [_zoneId, zone] of serviceArea.zones) {
      lines.push("═".repeat(72));
      lines.push(
        formatZoneForAgent(zone, {
          roads: serviceArea.infrastructure.roads,
          buildings: serviceArea.infrastructure.buildings,
          includeBuildingContents: true,
          includeCustomerOverlay: true,
        }),
      );
    }
  } else {
    // Show zones with most content
    const sortedZones = Array.from(serviceArea.zones.entries())
      .filter(([_, z]) => z.stats.nodeCount > 0)
      .sort((a, b) => b[1].stats.nodeCount - a[1].stats.nodeCount)
      .slice(0, maxZonesToShow);

    if (sortedZones.length > 0) {
      lines.push(`TOP ${sortedZones.length} ZONES BY EQUIPMENT:`);
      for (const [_zoneId, zone] of sortedZones) {
        lines.push("═".repeat(72));
        lines.push(
          formatZoneForAgent(zone, {
            roads: serviceArea.infrastructure.roads,
            buildings: serviceArea.infrastructure.buildings,
            includeBuildingContents: true,
            includeCustomerOverlay: true,
          }),
        );
      }
    }

    // List other zones briefly
    const otherZones = Array.from(serviceArea.zones.entries())
      .filter(([_, z]) => z.stats.nodeCount > 0)
      .filter(([id, _]) => !sortedZones.find(([sid]) => sid === id));

    if (otherZones.length > 0) {
      lines.push("");
      lines.push(`OTHER ZONES (${otherZones.length}):`);
      for (const [zoneId, zone] of otherZones) {
        lines.push(
          `  ${zoneId}: ${zone.stats.nodeCount} nodes, ${zone.stats.houseCount} houses, ${zone.issues.length} issues`,
        );
      }
    }
  }

  return lines.join("\n");
}

/**
 * Generate a visual overview map of zones
 */
function generateZoneOverviewMap(serviceArea: ServiceAreaTextTwin): string {
  const { rows, cols } = serviceArea.zoneGrid;
  const lines: string[] = [];

  // Header
  const colHeaders = Array.from({ length: cols }, (_, i) => String(i + 1).padStart(4)).join("");
  lines.push(`    ${colHeaders}`);
  lines.push(`   ┌${"────".repeat(cols)}┐`);

  // Rows
  for (let row = 0; row < rows; row++) {
    const rowLetter = String.fromCharCode(65 + row);
    let rowStr = ` ${rowLetter} │`;

    for (let col = 0; col < cols; col++) {
      const zoneId = `${rowLetter}${col + 1}`;
      const zone = serviceArea.zones.get(zoneId);

      let symbol: string;
      if (!zone) {
        symbol = " ·  ";
      } else if (zone.stats.nodeCount === 0) {
        symbol = " ·  ";
      } else if (zone.issues.some((i) => i.severity === "error")) {
        symbol = " ✗  ";
      } else if (zone.stats.nodeCount > 10) {
        symbol = " ■  ";
      } else if (zone.stats.nodeCount > 5) {
        symbol = " ◆  ";
      } else {
        symbol = " ●  ";
      }

      rowStr += symbol;
    }

    rowStr += "│";
    lines.push(rowStr);
  }

  lines.push(`   └${"────".repeat(cols)}┘`);

  // Legend
  lines.push("");
  lines.push("   Legend: ■ >10 nodes  ◆ 5-10 nodes  ● <5 nodes  · empty  ✗ has errors");

  return lines.join("\n");
}

/**
 * Group cross-zone links by direction
 */
function groupLinksByDirection(links: CrossZoneLink[]): Record<string, CrossZoneLink[]> {
  const grouped: Record<string, CrossZoneLink[]> = {
    north: [],
    south: [],
    east: [],
    west: [],
  };

  for (const link of links) {
    if (grouped[link.direction]) {
      grouped[link.direction].push(link);
    }
  }

  return grouped;
}

/**
 * Get a specific zone from DataStore
 */
export function getDataStoreZone(
  serviceArea: DataStore,
  zoneId: string,
): DataStoreZone | null {
  return serviceArea.zones.get(zoneId) || null;
}

/**
 * Update a zone's GeoJSON and regenerate the zone
 */
export function updateZoneFromGeoJSON(
  serviceArea: ServiceAreaTextTwin,
  zoneId: string,
  updatedGeoJSON: ZoneGeoJSON,
): ServiceAreaTextTwin {
  const zone = serviceArea.zones.get(zoneId);
  if (!zone) {
    return serviceArea;
  }

  // Parse the updated GeoJSON
  const { nodes, cables } = parseZoneGeoJSON(updatedGeoJSON);

  // Regenerate the zone
  const updatedZone = generateDataStoreZone(
    zoneId,
    zone.bounds,
    nodes,
    cables,
    {}, // Infrastructure would need to be preserved
    serviceArea.zoneGrid,
  );

  // Create new zones map
  const newZones = new Map(serviceArea.zones);
  newZones.set(zoneId, updatedZone);

  // Recalculate global stats and issues
  const allCrossZoneLinks: CrossZoneLink[] = [];
  for (const z of newZones.values()) {
    allCrossZoneLinks.push(...z.crossZoneLinks);
  }

  const globalStats = aggregateZoneStats(newZones);
  const globalIssues = collectGlobalIssues(newZones, allCrossZoneLinks);

  return {
    ...serviceArea,
    zones: newZones,
    allCrossZoneLinks,
    stats: globalStats,
    globalIssues,
  };
}

// ============================================================================
// GeoJSON Parser (Text Twin → NetworkState)
// ============================================================================

/**
 * Parse GeoJSON back to network nodes and cables
 */
export function parseZoneGeoJSON(geojson: ZoneGeoJSON): {
  nodes: NetworkNode[];
  cables: NetworkCable[];
} {
  const nodes: NetworkNode[] = [];
  const cables: NetworkCable[] = [];

  for (const feature of geojson.features) {
    if (feature.geometry.type === "Point") {
      // Node
      nodes.push({
        id: feature.id,
        type: feature.properties.nodeType!,
        position: feature.geometry.coordinates as [number, number],
        label: feature.properties.label as string | undefined,
        splitterRatio: feature.properties.splitterRatio as string | undefined,
        totalFibers: feature.properties.fiberCount as number | undefined,
        ports: feature.properties.ports as number | undefined,
      });
    } else if (feature.geometry.type === "LineString") {
      // Cable
      cables.push({
        id: feature.id,
        source: feature.properties.source as string,
        target: feature.properties.target as string,
        cableType: feature.properties.cableType as "feeder" | "distribution" | "drop",
        fiberCount: feature.properties.fiberCount as number | undefined,
        length: feature.properties.length as number | undefined,
        path: feature.geometry.coordinates as [number, number][],
      });
    }
  }

  return { nodes, cables };
}

// ============================================================================
// Helper Types (for compatibility with existing code)
// ============================================================================

export interface NetworkNode {
  id: string;
  type: "co" | "cabinet" | "closure" | "den" | "house" | "pole";
  position: [number, number];
  label?: string;
  splitterRatio?: string;
  totalFibers?: number;
  ports?: number;
  /** Actual street address (from address matching) */
  address?: string;
  /** Number of floors (from address matching survey data) */
  floors?: number;
  /** Units per floor (from address matching survey data) */
  unitsPerFloor?: number;
  /** Calculated fiber demand: floors * unitsPerFloor */
  estimatedUnits?: number;
}

export interface NetworkCable {
  id: string;
  source: string;
  target: string;
  cableType?: "feeder" | "distribution" | "drop";
  fiberCount?: number;
  length?: number;
  path?: [number, number][];
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Calculate distance between two coordinates in meters (Haversine formula)
 */
function haversineDistance(coord1: [number, number], coord2: [number, number]): number {
  const R = 6371000; // Earth radius in meters
  const lat1 = (coord1[1] * Math.PI) / 180;
  const lat2 = (coord2[1] * Math.PI) / 180;
  const dLat = ((coord2[1] - coord1[1]) * Math.PI) / 180;
  const dLng = ((coord2[0] - coord1[0]) * Math.PI) / 180;

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
}

// ============================================================================
// Layer 2: Lookup Tables
// ============================================================================

/**
 * Address lookup entry - maps address string to node info
 */
export interface AddressLookup {
  address: string;
  nodeId: string;
  nodeType: "house" | "closure" | "cabinet" | "co";
  gridPosition: [number, number];
  closureId?: string;
  closureLabel?: string; // Human-readable label like "CL-001" instead of "closure-0"
  coordinates: [number, number];
}

/**
 * Street lookup entry - maps street name to nodes on that street
 */
export interface StreetLookup {
  streetName: string;
  nodeIds: string[];
  nodeTypes: Record<string, number>; // count by type
}

/**
 * Closure topology entry - shows houses connected to a closure
 */
export interface ClosureTopology {
  closureId: string;
  closureLabel?: string;
  splitterRatio: string;
  capacity: number;
  connectedHouses: Array<{
    houseId: string;
    address?: string;
    fiberNumber?: number;
  }>;
  availablePorts: number;
  opticalLoss: number;
}

/**
 * Building contents entry - maps building to its houses (B+D Solution Part B)
 * This solves the compression problem where multiple houses in the same building
 * are hidden behind the building symbol (▓) in the ASCII grid.
 */
export interface BuildingContents {
  buildingId: string;
  gridPosition: [number, number];
  coordinates: [number, number];
  houseCount: number;
  houses: Array<{
    houseId: string;
    address?: string;
    closureId?: string;
    closureLabel?: string;
    dropDistance?: number;
    fiberColor?: string;
  }>;
  closureAssignments: Record<string, number>; // closureId -> house count
}

/**
 * Customer overlay - a separate grid showing only houses (B+D Solution Part D)
 * Houses are spread within building footprints to avoid compression.
 * This grid uses numbers 1-9 or letters A-Z to show multiple houses per cell.
 */
export interface CustomerOverlay {
  grid: string;
  legend: Array<{
    symbol: string;
    houseId: string;
    address?: string;
    closureId?: string;
  }>;
  totalHouses: number;
  housesInBuildings: number;
  housesVisible: number;
}

// ============================================================================
// Cable Inventory - Full cable tracking with grid paths
// ============================================================================

/**
 * Status of a cable - used for LLM to understand what needs fixing
 */
export type CableStatus = "OK" | "CROSSES_BUILDING" | "OFF_ROAD" | "TOO_LONG" | "DISCONNECTED";

/**
 * Grid path segment - describes a portion of the cable path in grid terms
 */
export interface GridPathSegment {
  from: { col: number; row: string };
  to: { col: number; row: string };
  direction: "NORTH" | "SOUTH" | "EAST" | "WEST" | "DIAGONAL";
  cells: number;
  onRoad: boolean;
  crossesBuilding: boolean;
}

/**
 * Cable inventory entry - full details for each cable
 * This enables the LLM to identify and fix specific cables
 */
export interface CableInventoryEntry {
  /** Unique cable identifier */
  id: string;

  /** Cable tier */
  tier: "feeder" | "distribution" | "drop";

  /** Source node info */
  source: {
    id: string;
    type: "co" | "cabinet" | "closure";
    label?: string;
    gridPosition: { col: number; row: string };
  };

  /** Target node info */
  target: {
    id: string;
    type: "cabinet" | "closure" | "house";
    label?: string;
    address?: string;
    gridPosition: { col: number; row: string };
  };

  /** Cable length in meters */
  length: number;

  /** Fiber count */
  fiberCount: number;

  /** Path in grid coordinates */
  gridPath: GridPathSegment[];

  /** Cable status - OK or issue type */
  status: CableStatus;

  /** Issue details if status is not OK */
  issueDetails?: {
    description: string;
    location: { col: number; row: string };
    suggestion: string;
  };
}

/**
 * Build cable inventory from zone data
 */
export function buildCableInventory(
  cables: ZoneFeature[],
  equipment: ZoneEquipment[],
  zoneBounds: ZoneBounds,
  buildings: InfrastructureBuilding[],
  roads: InfrastructureRoad[],
): CableInventoryEntry[] {
  const inventory: CableInventoryEntry[] = [];

  // Build equipment lookup
  const equipmentMap = new Map(equipment.map((e) => [e.id, e]));

  for (const cable of cables) {
    if (cable.geometry.type !== "LineString") continue;

    const sourceId = cable.properties.source as string;
    const targetId = cable.properties.target as string;
    if (!sourceId || !targetId) continue;

    const sourceEquip = equipmentMap.get(sourceId);
    const targetEquip = equipmentMap.get(targetId);
    if (!sourceEquip || !targetEquip) continue;

    const cableType = (cable.properties.cableType as CableInventoryEntry["tier"]) || "drop";
    const length = (cable.properties.length as number) || 0;
    const fiberCount = (cable.properties.fiberCount as number) || 1;

    // Convert path to grid coordinates
    const pathCoords = cable.geometry.coordinates as [number, number][];
    const gridPath = buildGridPath(pathCoords, zoneBounds, buildings, roads);

    // Determine cable status
    const { status, issueDetails } = analyzeCableStatus(gridPath, length, cableType);

    const entry: CableInventoryEntry = {
      id: cable.id,
      tier: cableType,
      source: {
        id: sourceId,
        type: sourceEquip.type as "co" | "cabinet" | "closure",
        label: sourceEquip.properties.label as string | undefined,
        gridPosition: {
          col: sourceEquip.gridPosition[0],
          row: String.fromCharCode(65 + sourceEquip.gridPosition[1]),
        },
      },
      target: {
        id: targetId,
        type: targetEquip.type as "cabinet" | "closure" | "house",
        label: targetEquip.properties.label as string | undefined,
        address: targetEquip.properties.address as string | undefined,
        gridPosition: {
          col: targetEquip.gridPosition[0],
          row: String.fromCharCode(65 + targetEquip.gridPosition[1]),
        },
      },
      length,
      fiberCount,
      gridPath,
      status,
      issueDetails,
    };

    inventory.push(entry);
  }

  return inventory;
}

/**
 * Convert geo path to grid path with segment analysis
 */
function buildGridPath(
  pathCoords: [number, number][],
  zoneBounds: ZoneBounds,
  buildings: InfrastructureBuilding[],
  roads: InfrastructureRoad[],
): GridPathSegment[] {
  const segments: GridPathSegment[] = [];
  if (pathCoords.length < 2) return segments;

  for (let i = 0; i < pathCoords.length - 1; i++) {
    const from = pathCoords[i];
    const to = pathCoords[i + 1];

    // Convert to grid positions
    const fromGrid = coordToGrid(from, zoneBounds);
    const toGrid = coordToGrid(to, zoneBounds);

    // Determine direction
    const dx = toGrid.col - fromGrid.col;
    const dy = toGrid.rowNum - fromGrid.rowNum;
    let direction: GridPathSegment["direction"];
    if (Math.abs(dx) > Math.abs(dy) * 2) {
      direction = dx > 0 ? "EAST" : "WEST";
    } else if (Math.abs(dy) > Math.abs(dx) * 2) {
      direction = dy > 0 ? "SOUTH" : "NORTH";
    } else {
      direction = "DIAGONAL";
    }

    // Check if on road
    const midpoint: [number, number] = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2];
    const onRoad = isOnRoad(midpoint, roads);

    // Check if crosses building
    const crossesBuilding = checkBuildingCrossing(from, to, buildings);

    segments.push({
      from: { col: fromGrid.col, row: fromGrid.row },
      to: { col: toGrid.col, row: toGrid.row },
      direction,
      cells: Math.max(Math.abs(dx), Math.abs(dy)),
      onRoad,
      crossesBuilding,
    });
  }

  return segments;
}

/**
 * Convert coordinate to grid position
 */
function coordToGrid(
  coord: [number, number],
  bounds: ZoneBounds,
): { col: number; row: string; rowNum: number } {
  const lngRange = bounds.maxLng - bounds.minLng;
  const latRange = bounds.maxLat - bounds.minLat;

  const col = Math.floor(((coord[0] - bounds.minLng) / lngRange) * GRID_WIDTH);
  const rowNum = Math.floor(((bounds.maxLat - coord[1]) / latRange) * GRID_HEIGHT);
  const row = String.fromCharCode(65 + Math.min(rowNum, 25)); // A-Z, then wrap

  return { col: Math.max(0, Math.min(col, GRID_WIDTH - 1)), row, rowNum };
}

/**
 * Check if a point is on a road
 */
function isOnRoad(point: [number, number], roads: InfrastructureRoad[]): boolean {
  const tolerance = 0.0001; // ~10m tolerance

  for (const road of roads) {
    // Skip roads without valid coordinates
    if (!road.coordinates || road.coordinates.length < 2) continue;

    for (let i = 0; i < road.coordinates.length - 1; i++) {
      const dist = pointToSegmentDistance(point, road.coordinates[i], road.coordinates[i + 1]);
      if (dist < tolerance) return true;
    }
  }

  return false;
}

/**
 * Calculate distance from point to line segment
 */
function pointToSegmentDistance(
  point: [number, number],
  segStart: [number, number],
  segEnd: [number, number],
): number {
  const dx = segEnd[0] - segStart[0];
  const dy = segEnd[1] - segStart[1];
  const t = Math.max(
    0,
    Math.min(
      1,
      ((point[0] - segStart[0]) * dx + (point[1] - segStart[1]) * dy) / (dx * dx + dy * dy),
    ),
  );
  const projX = segStart[0] + t * dx;
  const projY = segStart[1] + t * dy;
  return Math.sqrt((point[0] - projX) ** 2 + (point[1] - projY) ** 2);
}

/**
 * Check if a line segment crosses any building
 */
function checkBuildingCrossing(
  from: [number, number],
  to: [number, number],
  buildings: InfrastructureBuilding[],
): boolean {
  // Check multiple points along the segment
  const steps = 10;
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const point: [number, number] = [
      from[0] + (to[0] - from[0]) * t,
      from[1] + (to[1] - from[1]) * t,
    ];

    for (const building of buildings) {
      if (isPointInPolygon(point, building.coordinates[0])) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Check if point is inside polygon (ray casting)
 */
function isPointInPolygon(point: [number, number], polygon: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i][0],
      yi = polygon[i][1];
    const xj = polygon[j][0],
      yj = polygon[j][1];

    if (
      yi > point[1] !== yj > point[1] &&
      point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi
    ) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Analyze cable status and generate issue details
 */
function analyzeCableStatus(
  gridPath: GridPathSegment[],
  length: number,
  tier: CableInventoryEntry["tier"],
): { status: CableStatus; issueDetails?: CableInventoryEntry["issueDetails"] } {
  // Check for building crossings
  const crossingSegment = gridPath.find((seg) => seg.crossesBuilding);
  if (crossingSegment) {
    return {
      status: "CROSSES_BUILDING",
      issueDetails: {
        description: `Cable crosses building between [${crossingSegment.from.col},${crossingSegment.from.row}] and [${crossingSegment.to.col},${crossingSegment.to.row}]`,
        location: crossingSegment.from,
        suggestion: `Reroute cable via road. Direction was ${crossingSegment.direction}.`,
      },
    };
  }

  // Check for off-road segments (not critical for drops)
  if (tier !== "drop") {
    const offRoadSegment = gridPath.find((seg) => !seg.onRoad && seg.cells > 2);
    if (offRoadSegment) {
      return {
        status: "OFF_ROAD",
        issueDetails: {
          description: `Cable segment not on road: ${offRoadSegment.cells} cells ${offRoadSegment.direction}`,
          location: offRoadSegment.from,
          suggestion: `Route cable along nearest road.`,
        },
      };
    }
  }

  // Check for excessive length
  const maxLength = tier === "drop" ? 100 : tier === "distribution" ? 500 : 2000;
  if (length > maxLength) {
    return {
      status: "TOO_LONG",
      issueDetails: {
        description: `Cable length ${length.toFixed(0)}m exceeds ${maxLength}m limit for ${tier}`,
        location: gridPath[0]?.from || { col: 0, row: "A" },
        suggestion: `Consider adding intermediate equipment or shorter route.`,
      },
    };
  }

  return { status: "OK" };
}

/**
 * Format cable inventory for Text Twin output
 */
export function formatCableInventory(
  inventory: CableInventoryEntry[],
  maxEntries: number = 50,
): string {
  const lines: string[] = [];

  // Group by status for summary
  const byStatus = new Map<CableStatus, CableInventoryEntry[]>();
  for (const cable of inventory) {
    if (!byStatus.has(cable.status)) {
      byStatus.set(cable.status, []);
    }
    byStatus.get(cable.status)!.push(cable);
  }

  // Summary
  lines.push(`CABLE INVENTORY (${inventory.length} cables):`);
  lines.push(`  ✅ OK: ${byStatus.get("OK")?.length || 0}`);
  const issues = inventory.filter((c) => c.status !== "OK");
  if (issues.length > 0) {
    lines.push(`  ⚠️  Issues: ${issues.length}`);
    for (const [status, cables] of byStatus) {
      if (status !== "OK") {
        lines.push(`      ${status}: ${cables.length}`);
      }
    }
  }
  lines.push("");

  // Show cables with issues first
  const issueCables = inventory.filter((c) => c.status !== "OK");
  if (issueCables.length > 0) {
    lines.push("CABLES WITH ISSUES:");
    for (const cable of issueCables.slice(0, 20)) {
      lines.push(formatCableEntry(cable, true));
    }
    lines.push("");
  }

  // Show sample of OK cables
  const okCables = inventory.filter((c) => c.status === "OK");
  if (okCables.length > 0) {
    lines.push(
      `OK CABLES (showing ${Math.min(okCables.length, maxEntries - issueCables.length)} of ${okCables.length}):`,
    );
    for (const cable of okCables.slice(0, maxEntries - issueCables.length)) {
      lines.push(formatCableEntry(cable, false));
    }
  }

  return lines.join("\n");
}

/**
 * Format a single cable entry
 */
function formatCableEntry(cable: CableInventoryEntry, showDetails: boolean): string {
  const lines: string[] = [];

  // Basic info
  const targetLabel = cable.target.address
    ? `"${cable.target.address}"`
    : cable.target.label || cable.target.id;

  const sourceLabel = cable.source.label || cable.source.id;

  const statusIcon = cable.status === "OK" ? "✓" : "⚠️";
  lines.push(`  ${statusIcon} ${cable.id} [${cable.tier.toUpperCase()}]`);
  lines.push(`     ${sourceLabel} → ${targetLabel}`);
  lines.push(`     Length: ${cable.length.toFixed(0)}m | Fibers: ${cable.fiberCount}`);

  // Grid path summary
  if (cable.gridPath.length > 0) {
    const pathSummary = cable.gridPath.map((seg) => `${seg.direction} ${seg.cells}`).join(" → ");
    lines.push(
      `     Path: [${cable.source.gridPosition.col},${cable.source.gridPosition.row}] ${pathSummary} [${cable.target.gridPosition.col},${cable.target.gridPosition.row}]`,
    );
  }

  // Issue details
  if (showDetails && cable.issueDetails) {
    lines.push(`     ❌ STATUS: ${cable.status}`);
    lines.push(`        ${cable.issueDetails.description}`);
    lines.push(
      `        At grid: [${cable.issueDetails.location.col},${cable.issueDetails.location.row}]`,
    );
    lines.push(`        FIX: ${cable.issueDetails.suggestion}`);
  }

  lines.push("");
  return lines.join("\n");
}

/**
 * Build address lookup table from zone equipment
 */
export function buildAddressLookup(
  equipment: ZoneEquipment[],
  cables: ZoneFeature[],
): AddressLookup[] {
  const lookups: AddressLookup[] = [];

  // Build cable adjacency for finding closure connections
  const cablesByTarget = new Map<string, ZoneFeature>();
  for (const cable of cables) {
    if (cable.properties.target) {
      cablesByTarget.set(cable.properties.target, cable);
    }
  }

  // Build closure label lookup
  const closureLabels = new Map<string, string>();
  for (const eq of equipment) {
    if (eq.type === "closure" || eq.type === "den") {
      // Use the label property if available, otherwise generate from ID
      // Format: CL-001, CL-002, etc. (1-based, zero-padded)
      const label =
        (eq.properties.label as string) ||
        `CL-${String(parseInt(eq.id.split("-")[1] || "0", 10) + 1).padStart(3, "0")}`;
      closureLabels.set(eq.id, label);
    }
  }

  for (const eq of equipment) {
    // Extract address from label or properties
    const address = (eq.properties.label as string) || (eq.properties.address as string) || eq.id;

    // Find connected closure for houses
    let closureId: string | undefined;
    let closureLabel: string | undefined;
    if (eq.type === "house") {
      const cable = cablesByTarget.get(eq.id);
      if (cable?.properties.source) {
        closureId = cable.properties.source;
        closureLabel = closureLabels.get(closureId);
      }
    }

    lookups.push({
      address,
      nodeId: eq.id,
      nodeType: eq.type as "house" | "closure" | "cabinet" | "co",
      gridPosition: eq.gridPosition,
      closureId,
      closureLabel,
      coordinates: eq.coordinates,
    });
  }

  return lookups;
}

/**
 * Build street lookup table from equipment and roads
 */
export function buildStreetLookup(
  equipment: ZoneEquipment[],
  roads: InfrastructureRoad[],
): StreetLookup[] {
  const streetMap = new Map<string, { nodeIds: string[]; nodeTypes: Record<string, number> }>();

  // For each equipment, find nearest road and associate
  for (const eq of equipment) {
    let nearestStreet = "Unknown Street";
    let minDistance = Infinity;

    for (const road of roads) {
      // Skip roads without name or valid coordinates
      if (!road.name || !road.coordinates || road.coordinates.length === 0) continue;

      // Find distance to nearest point on road
      for (const coord of road.coordinates) {
        const dist = haversineDistance(eq.coordinates, coord);
        if (dist < minDistance) {
          minDistance = dist;
          nearestStreet = road.name;
        }
      }
    }

    // Only associate if within 50m of a road
    if (minDistance < 50) {
      if (!streetMap.has(nearestStreet)) {
        streetMap.set(nearestStreet, { nodeIds: [], nodeTypes: {} });
      }
      const entry = streetMap.get(nearestStreet)!;
      entry.nodeIds.push(eq.id);
      entry.nodeTypes[eq.type] = (entry.nodeTypes[eq.type] || 0) + 1;
    }
  }

  return Array.from(streetMap.entries()).map(([streetName, data]) => ({
    streetName,
    nodeIds: data.nodeIds,
    nodeTypes: data.nodeTypes,
  }));
}

/**
 * Build closure topology - shows what houses are connected to each closure
 */
export function buildClosureTopology(
  equipment: ZoneEquipment[],
  cables: ZoneFeature[],
): ClosureTopology[] {
  const topologies: ClosureTopology[] = [];

  // Group drop cables by source (closure)
  const housesByClosureId = new Map<
    string,
    Array<{ houseId: string; address?: string; fiberNumber?: number }>
  >();

  for (const cable of cables) {
    if (
      cable.properties.cableType === "drop" &&
      cable.properties.source &&
      cable.properties.target
    ) {
      const closureId = cable.properties.source;
      if (!housesByClosureId.has(closureId)) {
        housesByClosureId.set(closureId, []);
      }

      // Find house address
      const house = equipment.find((e) => e.id === cable.properties.target);
      const address = house?.properties.label as string | undefined;

      housesByClosureId.get(closureId)!.push({
        houseId: cable.properties.target,
        address,
        fiberNumber: cable.properties.fiberCount,
      });
    }
  }

  // Build topology for each closure/DEN
  const closures = equipment.filter((e) => e.type === "closure" || e.type === "den");
  for (const closure of closures) {
    const ratio = (closure.properties.splitterRatio as string) || "1:8";
    const capacity = parseSplitterCapacity(ratio);
    const connectedHouses = housesByClosureId.get(closure.id) || [];

    topologies.push({
      closureId: closure.id,
      closureLabel: closure.properties.label as string | undefined,
      splitterRatio: ratio,
      capacity,
      connectedHouses,
      availablePorts: capacity - connectedHouses.length,
      opticalLoss: getSplitterLoss(ratio),
    });
  }

  return topologies;
}

/**
 * Parse splitter ratio to capacity number
 */
function parseSplitterCapacity(ratio: string): number {
  const match = ratio.match(/1:(\d+)/);
  return match ? parseInt(match[1], 10) : 8;
}

/**
 * Get splitter loss in dB
 */
function getSplitterLoss(ratio: string): number {
  return OPTICAL_CONSTANTS.splitterLoss[ratio] || 10.8;
}

// ============================================================================
// Neighborhood Analysis (LLM-optimized for spatial reasoning)
// ============================================================================

export interface ClosureNeighborhood {
  closureId: string;
  closureSymbol: string;
  gridPosition: [number, number];
  /** What's adjacent in each direction (N/S/E/W) */
  adjacent: {
    north: string;
    south: string;
    east: string;
    west: string;
  };
  /** Distance to nearest road in meters */
  nearestRoadDistance: number | null;
  /** Distance to nearest building in meters */
  nearestBuildingDistance: number | null;
  /** Distances to other closures */
  closureDistances: Array<{ closureId: string; symbol: string; distance: number }>;
  /** Clearance summary */
  clearance: {
    hasRoadAccess: boolean;
    isOnSidewalk: boolean;
    isNearBuilding: boolean;
    recommendedForMove: boolean;
  };
}

/**
 * Build neighborhood analysis for all closures
 * This helps LLMs understand the spatial context around each closure
 */
export function buildClosureNeighborhoods(
  equipment: ZoneEquipment[],
  asciiGrid: string,
  zoneBounds: ZoneBounds,
): ClosureNeighborhood[] {
  const neighborhoods: ClosureNeighborhood[] = [];
  const closures = equipment.filter((e) => e.type === "closure" || e.type === "den");

  // Parse ASCII grid into 2D array for neighborhood analysis
  const gridLines = asciiGrid.split("\n");
  const grid: string[][] = [];

  // Skip header lines (column numbers, border) and extract just the grid content
  for (const line of gridLines) {
    // Match lines that look like grid rows: " A │...│"
    const match = line.match(/^\s+[A-Z]\s+│(.+)│$/);
    if (match) {
      grid.push([...match[1]]);
    }
  }

  // Calculate meters per cell
  const metersPerCellX = zoneBounds
    ? haversineDistance(
        [zoneBounds.minLng, zoneBounds.minLat],
        [zoneBounds.maxLng, zoneBounds.minLat],
      ) / GRID_WIDTH
    : 2;
  const metersPerCellY = zoneBounds
    ? haversineDistance(
        [zoneBounds.minLng, zoneBounds.minLat],
        [zoneBounds.minLng, zoneBounds.maxLat],
      ) / GRID_HEIGHT
    : 4;

  for (const closure of closures) {
    const [col, row] = closure.gridPosition;
    // Use [●01] format for closure symbol
    const closureSymbol = getEquipmentGridAnnotation(closure.id, closure.type as "closure" | "den");

    // Get adjacent cells (with bounds checking)
    const getCell = (r: number, c: number): string => {
      if (r < 0 || r >= grid.length || c < 0 || c >= (grid[r]?.length || 0)) {
        return "edge";
      }
      return grid[r][c] || " ";
    };

    const describeCell = (cell: string): string => {
      if (cell === SYMBOLS.building) return "building";
      if (cell === SYMBOLS.road_h || cell === SYMBOLS.road_v) return "road";
      if (cell === SYMBOLS.road_cross) return "intersection";
      if (cell === SYMBOLS.sidewalk) return "sidewalk";
      if (cell === " ") return "empty";
      if (cell === "edge") return "zone_edge";
      // Check if it's a numbered closure symbol
      if (NUMBERED_CLOSURE_SYMBOLS.includes(cell as (typeof NUMBERED_CLOSURE_SYMBOLS)[number])) {
        const idx = NUMBERED_CLOSURE_SYMBOLS.indexOf(
          cell as (typeof NUMBERED_CLOSURE_SYMBOLS)[number],
        );
        return `closure_${idx}`;
      }
      if (cell === SYMBOLS.cabinet) return "cabinet";
      if (cell === SYMBOLS.co) return "co";
      if (cell === SYMBOLS.house || cell === SYMBOLS.house_connected) return "house";
      return "other";
    };

    const adjacent = {
      north: describeCell(getCell(row - 1, col)),
      south: describeCell(getCell(row + 1, col)),
      east: describeCell(getCell(row, col + 1)),
      west: describeCell(getCell(row, col - 1)),
    };

    // Find distances to roads and buildings by scanning outward
    let nearestRoadDistance: number | null = null;
    let nearestBuildingDistance: number | null = null;

    for (let radius = 1; radius <= 10; radius++) {
      for (let dr = -radius; dr <= radius; dr++) {
        for (let dc = -radius; dc <= radius; dc++) {
          if (Math.abs(dr) !== radius && Math.abs(dc) !== radius) continue; // Only check perimeter
          const cell = getCell(row + dr, col + dc);
          const distMeters = Math.sqrt((dr * metersPerCellY) ** 2 + (dc * metersPerCellX) ** 2);

          if (
            nearestRoadDistance === null &&
            (cell === SYMBOLS.road_h || cell === SYMBOLS.road_v || cell === SYMBOLS.road_cross)
          ) {
            nearestRoadDistance = distMeters;
          }
          if (nearestBuildingDistance === null && cell === SYMBOLS.building) {
            nearestBuildingDistance = distMeters;
          }
        }
      }
      if (nearestRoadDistance !== null && nearestBuildingDistance !== null) break;
    }

    // Calculate distances to other closures
    const closureDistances = closures
      .filter((c) => c.id !== closure.id)
      .map((other) => {
        const [oc, or] = other.gridPosition;
        const dx = (oc - col) * metersPerCellX;
        const dy = (or - row) * metersPerCellY;
        const distance = Math.sqrt(dx * dx + dy * dy);
        // Use [●01] format for other closure symbol
        const otherSymbol = getEquipmentGridAnnotation(other.id, other.type as "closure" | "den");
        return { closureId: other.id, symbol: otherSymbol, distance };
      })
      .sort((a, b) => a.distance - b.distance);

    // Determine clearance status
    const hasRoadAccess = nearestRoadDistance !== null && nearestRoadDistance <= 15;
    const isOnSidewalk =
      Object.values(adjacent).includes("sidewalk") || Object.values(adjacent).includes("road");
    const isNearBuilding = nearestBuildingDistance !== null && nearestBuildingDistance <= 5;
    const recommendedForMove = !isOnSidewalk || isNearBuilding;

    neighborhoods.push({
      closureId: closure.id,
      closureSymbol,
      gridPosition: [col, row],
      adjacent,
      nearestRoadDistance,
      nearestBuildingDistance,
      closureDistances: closureDistances.slice(0, 3), // Top 3 nearest
      clearance: {
        hasRoadAccess,
        isOnSidewalk,
        isNearBuilding,
        recommendedForMove,
      },
    });
  }

  return neighborhoods;
}

// ============================================================================
// B+D Solution: Building Contents & Customer Overlay
// ============================================================================

/**
 * Build building contents - maps each building to its houses (B+D Solution Part B)
 * This solves the compression issue where houses inside dense buildings are hidden
 * behind the building symbol (▓) in the ASCII grid.
 */
export function buildBuildingContents(
  equipment: ZoneEquipment[],
  cables: ZoneFeature[],
  buildings: InfrastructureBuilding[],
  zoneBounds: ZoneBounds,
): BuildingContents[] {
  const contents: BuildingContents[] = [];
  const houses = equipment.filter((e) => e.type === "house");

  // Build cable lookup for finding closure connections
  const cablesByTarget = new Map<string, ZoneFeature>();
  for (const cable of cables) {
    if (cable.properties.target) {
      cablesByTarget.set(cable.properties.target, cable);
    }
  }

  // Get closure labels for display
  const closureLabels = new Map<string, string>();
  for (const eq of equipment) {
    if ((eq.type === "closure" || eq.type === "den") && eq.properties.label) {
      closureLabels.set(eq.id, eq.properties.label as string);
    }
  }

  // Calculate grid cell dimensions
  const cellWidth = (zoneBounds.maxLng - zoneBounds.minLng) / GRID_WIDTH;
  const cellHeight = (zoneBounds.maxLat - zoneBounds.minLat) / GRID_HEIGHT;

  // For each building, find houses within or near it
  for (let buildingIdx = 0; buildingIdx < buildings.length; buildingIdx++) {
    const building = buildings[buildingIdx];
    const buildingHouses: BuildingContents["houses"] = [];
    const closureAssignments: Record<string, number> = {};

    // Find houses within this building's footprint
    for (const house of houses) {
      const isInBuilding = isHouseInBuilding(house.coordinates, building);
      if (isInBuilding) {
        // Find connected closure via drop cable
        const cable = cablesByTarget.get(house.id);
        const closureId = cable?.properties.source;
        const closureLabel = closureId ? closureLabels.get(closureId) : undefined;
        const dropDistance = cable?.properties.length as number | undefined;

        buildingHouses.push({
          houseId: house.id,
          address: house.properties.label as string | undefined,
          closureId,
          closureLabel,
          dropDistance,
        });

        // Track closure assignments
        if (closureId) {
          closureAssignments[closureId] = (closureAssignments[closureId] || 0) + 1;
        }
      }
    }

    // Only include buildings with houses and valid centroid
    if (buildingHouses.length > 0 && building.centroid) {
      // Calculate grid position for building
      const gridX = Math.floor((building.centroid[0] - zoneBounds.minLng) / cellWidth);
      const gridY =
        GRID_HEIGHT - 1 - Math.floor((building.centroid[1] - zoneBounds.minLat) / cellHeight);

      contents.push({
        buildingId: `bldg-${buildingIdx + 1}`,
        gridPosition: [
          Math.max(0, Math.min(GRID_WIDTH - 1, gridX)),
          Math.max(0, Math.min(GRID_HEIGHT - 1, gridY)),
        ],
        coordinates: building.centroid,
        houseCount: buildingHouses.length,
        houses: buildingHouses,
        closureAssignments,
      });
    }
  }

  return contents;
}

/**
 * Check if a house is inside a building's footprint
 */
function isHouseInBuilding(
  houseCoord: [number, number],
  building: InfrastructureBuilding,
): boolean {
  // If building has polygon coordinates, use point-in-polygon
  if (building.coordinates && building.coordinates.length > 0) {
    for (const ring of building.coordinates) {
      if (ring.length >= 3) {
        if (pointInPolygonGeo(houseCoord, ring)) {
          return true;
        }
      }
    }
    return false;
  }

  // Otherwise, check if house is within ~15m of building centroid
  if (!building.centroid) {
    return false; // Cannot determine without coordinates or centroid
  }
  const distance = haversineDistance(houseCoord, building.centroid);
  return distance < 15;
}

/**
 * Point in polygon test for geographic coordinates
 */
function pointInPolygonGeo(point: [number, number], polygon: [number, number][]): boolean {
  const [x, y] = point;
  let inside = false;
  const n = polygon.length;

  for (let i = 0, j = n - 1; i < n; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];

    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }

  return inside;
}

/**
 * Generate customer overlay grid (B+D Solution Part D)
 * Creates a separate ASCII grid showing ONLY houses, spread within building footprints
 * to make every house visible without building symbols obscuring them.
 */
export function generateCustomerOverlay(
  equipment: ZoneEquipment[],
  cables: ZoneFeature[],
  buildings: InfrastructureBuilding[],
  zoneBounds: ZoneBounds,
): CustomerOverlay {
  // Initialize grid with empty spaces
  const grid: string[][] = Array(GRID_HEIGHT)
    .fill(null)
    .map(() => Array(GRID_WIDTH).fill(" "));

  // Track houses and their symbols
  const legend: CustomerOverlay["legend"] = [];
  let housesInBuildings = 0;
  let housesVisible = 0;

  // Get all houses
  const houses = equipment.filter((e) => e.type === "house");

  // Build cable lookup
  const cablesByTarget = new Map<string, ZoneFeature>();
  for (const cable of cables) {
    if (cable.properties.target) {
      cablesByTarget.set(cable.properties.target, cable);
    }
  }

  // Calculate grid cell dimensions
  const cellWidth = (zoneBounds.maxLng - zoneBounds.minLng) / GRID_WIDTH;
  const cellHeight = (zoneBounds.maxLat - zoneBounds.minLat) / GRID_HEIGHT;

  // Group houses by grid cell
  const housesByCell = new Map<
    string,
    Array<{
      house: ZoneEquipment;
      closureId?: string;
    }>
  >();

  for (const house of houses) {
    const gridX = Math.floor((house.coordinates[0] - zoneBounds.minLng) / cellWidth);
    const gridY =
      GRID_HEIGHT - 1 - Math.floor((house.coordinates[1] - zoneBounds.minLat) / cellHeight);
    const clampedX = Math.max(0, Math.min(GRID_WIDTH - 1, gridX));
    const clampedY = Math.max(0, Math.min(GRID_HEIGHT - 1, gridY));
    const cellKey = `${clampedX},${clampedY}`;

    const cable = cablesByTarget.get(house.id);
    const closureId = cable?.properties.source;

    if (!housesByCell.has(cellKey)) {
      housesByCell.set(cellKey, []);
    }
    housesByCell.get(cellKey)!.push({ house, closureId });

    // Check if this house is in a building
    for (const building of buildings) {
      if (isHouseInBuilding(house.coordinates, building)) {
        housesInBuildings++;
        break;
      }
    }
  }

  // Place houses on grid, spreading when multiple houses share a cell
  for (const [cellKey, cellHouses] of housesByCell) {
    const [baseX, baseY] = cellKey.split(",").map(Number);

    if (cellHouses.length === 1) {
      // Single house - use standard symbol
      const { house, closureId } = cellHouses[0];
      const symbol = closureId ? "◎" : "○";
      grid[baseY][baseX] = symbol;
      housesVisible++;
      legend.push({
        symbol,
        houseId: house.id,
        address: house.properties.label as string | undefined,
        closureId,
      });
    } else {
      // Multiple houses - spread them and use numbered/lettered symbols
      const spreadPositions = getSpreadPositions(baseX, baseY, cellHouses.length);

      for (let i = 0; i < cellHouses.length; i++) {
        const { house, closureId } = cellHouses[i];
        const [x, y] = spreadPositions[i] || [baseX, baseY];

        // Use numbers 1-9, then letters A-Z for dense areas
        const symbol = i < 9 ? String(i + 1) : String.fromCharCode(65 + i - 9);

        if (y >= 0 && y < GRID_HEIGHT && x >= 0 && x < GRID_WIDTH) {
          grid[y][x] = symbol;
          housesVisible++;
        }

        legend.push({
          symbol,
          houseId: house.id,
          address: house.properties.label as string | undefined,
          closureId,
        });
      }
    }
  }

  // Generate ASCII string with border
  const lines: string[] = [];

  // Top border
  lines.push(`   ┌${"─".repeat(GRID_WIDTH)}┐`);

  // Grid rows
  for (let y = 0; y < GRID_HEIGHT; y++) {
    const rowLabel = String.fromCharCode(65 + (y % 26));
    lines.push(` ${rowLabel} │${grid[y].join("")}│`);
  }

  // Bottom border
  lines.push(`   └${"─".repeat(GRID_WIDTH)}┘`);

  return {
    grid: lines.join("\n"),
    legend,
    totalHouses: houses.length,
    housesInBuildings,
    housesVisible,
  };
}

/**
 * Get spread positions for multiple houses in the same cell
 * Spreads houses into adjacent cells to avoid overlap
 */
function getSpreadPositions(
  centerX: number,
  centerY: number,
  count: number,
): Array<[number, number]> {
  const positions: Array<[number, number]> = [];

  // Spiral outward from center
  const offsets: Array<[number, number]> = [
    [0, 0], // Center
    [1, 0], // Right
    [0, 1], // Down
    [-1, 0], // Left
    [0, -1], // Up
    [1, 1], // Down-right
    [-1, 1], // Down-left
    [-1, -1], // Up-left
    [1, -1], // Up-right
    [2, 0], // Far right
    [0, 2], // Far down
    [-2, 0], // Far left
    [0, -2], // Far up
  ];

  for (let i = 0; i < count && i < offsets.length; i++) {
    const [dx, dy] = offsets[i];
    positions.push([centerX + dx, centerY + dy]);
  }

  // If we need more positions, just stack at center
  while (positions.length < count) {
    positions.push([centerX, centerY]);
  }

  return positions;
}

// ============================================================================
// Layer 3: Topology & Hierarchy
// ============================================================================

/**
 * Cables grouped by tier
 */
export interface CablesByTier {
  feeder: Array<{ id: string; length: number; fiberCount: number }>;
  distribution: Array<{ id: string; length: number; fiberCount: number }>;
  drop: Array<{ id: string; length: number; fiberCount: number }>;
  totals: {
    feederLength: number;
    feederFibers: number;
    distributionLength: number;
    distributionFibers: number;
    dropLength: number;
    dropCount: number;
  };
}

/**
 * Build cables inventory by tier
 */
export function buildCablesByTier(cables: ZoneFeature[]): CablesByTier {
  const result: CablesByTier = {
    feeder: [],
    distribution: [],
    drop: [],
    totals: {
      feederLength: 0,
      feederFibers: 0,
      distributionLength: 0,
      distributionFibers: 0,
      dropLength: 0,
      dropCount: 0,
    },
  };

  for (const cable of cables) {
    if (cable.geometry.type !== "LineString") continue;

    const cableType = cable.properties.cableType;
    const length = (cable.properties.length as number) || 0;
    const fiberCount = (cable.properties.fiberCount as number) || 1;

    const entry = { id: cable.id, length, fiberCount };

    switch (cableType) {
      case "feeder":
        result.feeder.push(entry);
        result.totals.feederLength += length;
        result.totals.feederFibers = Math.max(result.totals.feederFibers, fiberCount);
        break;
      case "distribution":
        result.distribution.push(entry);
        result.totals.distributionLength += length;
        result.totals.distributionFibers = Math.max(result.totals.distributionFibers, fiberCount);
        break;
      case "drop":
        result.drop.push(entry);
        result.totals.dropLength += length;
        result.totals.dropCount++;
        break;
    }
  }

  return result;
}

/**
 * Generate hierarchy tree string showing network topology
 */
export function generateHierarchyTree(equipment: ZoneEquipment[], cables: ZoneFeature[]): string {
  const lines: string[] = [];

  // Build adjacency from cables
  const children = new Map<string, string[]>();
  for (const cable of cables) {
    const source = cable.properties.source;
    const target = cable.properties.target;
    if (source && target) {
      if (!children.has(source)) {
        children.set(source, []);
      }
      children.get(source)!.push(target);
    }
  }

  // Find root (CO)
  const equipmentMap = new Map(equipment.map((e) => [e.id, e]));
  const co = equipment.find((e) => e.type === "co");

  if (!co) {
    return "No CO found - network hierarchy not available";
  }

  // Recursive tree builder
  const buildTree = (nodeId: string, prefix: string, isLast: boolean): void => {
    const node = equipmentMap.get(nodeId);
    if (!node) return;

    const connector = isLast ? "└── " : "├── ";
    const symbol = SYMBOLS[node.type] || "?";

    let label = `${symbol} ${node.type.toUpperCase()}`;
    if (node.properties.label) {
      label += ` "${node.properties.label}"`;
    }
    if (node.properties.splitterRatio) {
      label += ` (${node.properties.splitterRatio})`;
    }
    label += ` [${node.id}]`;

    lines.push(prefix + connector + label);

    const nodeChildren = children.get(nodeId) || [];
    const childPrefix = prefix + (isLast ? "    " : "│   ");

    nodeChildren.forEach((childId, index) => {
      buildTree(childId, childPrefix, index === nodeChildren.length - 1);
    });
  };

  // Start from CO
  lines.push(`${SYMBOLS.co} CO [${co.id}]`);
  const coChildren = children.get(co.id) || [];
  coChildren.forEach((childId, index) => {
    buildTree(childId, "", index === coChildren.length - 1);
  });

  return lines.join("\n");
}

// ============================================================================
// Layer 4: Enhanced Validation with Issue IDs and Fix Suggestions
// ============================================================================

/**
 * Suggested fix for an issue
 */
export interface SuggestedFix {
  tool: string;
  params: Record<string, unknown>;
  description: string;
}

/**
 * Generate a unique issue ID
 */
export function generateIssueId(issue: ZoneIssue, zoneId: string, index: number): string {
  const typeCode = issue.type.toUpperCase().replace(/_/g, "-").slice(0, 10);
  return `${zoneId}-${typeCode}-${String(index + 1).padStart(3, "0")}`;
}

/**
 * Suggest a fix tool for an issue
 */
export function suggestFixTool(issue: ZoneIssue): SuggestedFix | undefined {
  switch (issue.type) {
    case "optical_budget_exceeded":
      return {
        tool: "change_splitter_ratio",
        params: {
          nodeId: issue.nodeId,
          newRatio: "1:4", // Reduce to lower ratio
        },
        description: "Reduce splitter ratio to decrease optical loss",
      };

    case "disconnected_node":
      return {
        tool: "reassign_house",
        params: {
          houseId: issue.nodeId,
          toClosureId: "nearest_available", // Placeholder - agent should find nearest
        },
        description: "Connect to nearest closure with available capacity",
      };

    case "cascade_exceeded":
      return {
        tool: "add_node",
        params: {
          nodeType: "cabinet",
          nearNodeId: issue.nodeId,
        },
        description: "Add intermediate cabinet to reduce cascade depth",
      };

    default:
      return undefined;
  }
}

// =============================================================================
// CLOSURE ASSIGNMENT VISUALIZATION
// =============================================================================

/**
 * Interface for closure assignment data (compatible with MIP results)
 */
export interface ClosureAssignmentData {
  closureId: string;
  position: [number, number];
  nodeType: string;
  splitterRatio: string;
  assignedHouses: Array<{
    houseId: string;
    address?: string;
    distance: number;
  }>;
}

/**
 * Generate ASCII visualization of closure assignments.
 *
 * This shows which houses are assigned to which closures, useful for:
 * - Verifying MIP optimization results
 * - Debugging house-closure assignments
 * - Presenting network design to stakeholders
 *
 * @param zoneId Zone identifier (e.g., "A1")
 * @param assignments Closure assignments to visualize
 * @param generatedBy Method used to generate assignments (e.g., "Capacitated Facility Location MIP")
 * @returns ASCII visualization string
 */
export function generateClosureAssignmentVisualization(
  zoneId: string,
  assignments: ClosureAssignmentData[],
  generatedBy: string = "Heuristic Proximity Grouping",
): string {
  const lines: string[] = [];

  // Header
  lines.push(`[CLOSURE ASSIGNMENTS - Zone ${zoneId}]`);
  lines.push(`Generated by: ${generatedBy}`);
  lines.push("━".repeat(50));
  lines.push("");

  // Summary stats
  const totalClosures = assignments.length;
  const totalHouses = assignments.reduce((sum, a) => sum + a.assignedHouses.length, 0);
  const totalDropLength = assignments.reduce(
    (sum, a) => sum + a.assignedHouses.reduce((s, h) => s + h.distance, 0),
    0,
  );

  lines.push(`Summary: ${totalClosures} closures serving ${totalHouses} houses`);
  lines.push(`Total drop cable: ${totalDropLength.toFixed(0)}m`);
  lines.push("");

  // Node type symbols
  const nodeTypeSymbols: Record<string, string> = {
    conduit_access: "📦", // Underground access point
    pole: "📍", // Aerial pole
    handhole: "🔲", // Handhole
    intersection: "⚡", // Street intersection
    street: "🛤️", // Street-side
  };

  // Each closure
  for (const assignment of assignments) {
    const symbol = nodeTypeSymbols[assignment.nodeType] || "●";
    const houseCount = assignment.assignedHouses.length;

    // Closure header line
    lines.push(
      `${symbol} ${assignment.closureId} [${assignment.splitterRatio}] @ ${assignment.nodeType}`,
    );

    // House assignments (show first 6, summarize rest)
    const housesToShow = assignment.assignedHouses.slice(0, 6);
    const remaining = assignment.assignedHouses.length - 6;

    const houseStrings = housesToShow.map((h) => {
      const label = h.address || h.houseId;
      const shortLabel = label.length > 15 ? `${label.substring(0, 12)}...` : label;
      return `${shortLabel} (${h.distance.toFixed(0)}m)`;
    });

    lines.push(
      `   Houses (${houseCount}): ${houseStrings.join(", ")}${remaining > 0 ? `, +${remaining} more` : ""}`,
    );
    lines.push("");
  }

  // Footer
  lines.push("━".repeat(50));
  lines.push(`Legend: 📦=conduit_access, 📍=pole, 🔲=handhole, ⚡=intersection, 🛤️=street`);

  return lines.join("\n");
}

/**
 * Convert MIP closure placements to assignment data for visualization.
 *
 * @param placements MIP placement results
 * @param houses Houses with positions
 * @returns Array of closure assignment data
 */
export function convertMIPPlacementsToAssignmentData(
  placements: Array<{
    id: string;
    position: [number, number];
    nodeType: string;
    assignedHouses: string[];
    splitterRatio: string;
    totalDropLength: number;
  }>,
  houses: Array<{
    id: string;
    position: [number, number];
    address?: string;
  }>,
): ClosureAssignmentData[] {
  // Create house lookup
  const houseById = new Map(houses.map((h) => [h.id, h]));

  return placements.map((placement) => {
    const assignedHouses = placement.assignedHouses.map((houseId) => {
      const house = houseById.get(houseId);
      if (!house) {
        return { houseId, distance: 0 };
      }

      // Calculate distance from closure to house
      const distance = calculateHaversineDistanceSimple(placement.position, house.position);

      return {
        houseId,
        address: house.address,
        distance,
      };
    });

    return {
      closureId: placement.id,
      position: placement.position,
      nodeType: placement.nodeType,
      splitterRatio: placement.splitterRatio,
      assignedHouses,
    };
  });
}

/**
 * Simple haversine distance calculation for closure visualization.
 */
function calculateHaversineDistanceSimple(p1: [number, number], p2: [number, number]): number {
  const R = 6371000; // Earth radius in meters
  const lat1 = (p1[1] * Math.PI) / 180;
  const lat2 = (p2[1] * Math.PI) / 180;
  const dLat = ((p2[1] - p1[1]) * Math.PI) / 180;
  const dLon = ((p2[0] - p1[0]) * Math.PI) / 180;

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
}

// ============================================================================
// Backward Compatible Function Aliases
// ============================================================================

/**
 * @deprecated Use generateDataStoreZone instead
 */
export const generateZoneTextTwin = generateDataStoreZone;

/**
 * @deprecated Use generateDataStore instead
 */
export const generateServiceAreaTextTwin = generateDataStore;

/**
 * @deprecated Use formatZoneForAgent instead
 */
export const formatZoneForClaude = formatZoneForAgent;

/**
 * @deprecated Use formatServiceAreaForAgent instead
 */
export const formatServiceAreaForClaude = formatServiceAreaForAgent;

/**
 * @deprecated Use getDataStoreZone instead
 */
export const getZoneTextTwin = getDataStoreZone;
