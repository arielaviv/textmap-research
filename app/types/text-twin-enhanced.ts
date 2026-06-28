/**
 * Enhanced Text Twin Type Definitions
 *
 * Types for world-class LLM spatial reasoning in FTTH network design.
 * The ASCII diagram serves as a "communication layer that bridges human spatial language with machine precision."
 */

// ============================================================================
// Equipment Annotations
// ============================================================================

/**
 * Equipment annotation for inline grid display
 * Format: [SYMBOL+SEQ:ratio:homeCount] e.g., "[●01:1:8:12h]"
 */
export interface EquipmentAnnotation {
  nodeId: string;
  symbol: string;
  sequenceNumber: number;
  annotationFormat: string; // e.g., "[●01:1:8:12h]"
  splitterRatio?: string; // e.g., "1:8", "1:16", "1:32"
  homeCount?: number;
  opticalLoss?: number; // dB at this node
  position: [number, number]; // [lng, lat]
  gridPosition: [number, number]; // [col, row]
}

/**
 * Equipment types with their symbols and characteristics
 */
export type EquipmentType = "co" | "cabinet" | "cabinet-t3" | "closure" | "den" | "house" | "pole";

// ============================================================================
// Cable Annotations
// ============================================================================

/**
 * Cable annotation for inline grid display
 * Format: [TYPE:FIBER:SOURCE→TARGET] e.g., "[F:48F:OLT-01→CAB-03]"
 */
export interface CableAnnotation {
  cableId: string;
  tier: CableTier;
  annotationFormat: string; // e.g., "[F:48F:OLT-01→CAB-03]"
  tierPrefix: "F" | "D" | "d"; // Feeder, Distribution, drop
  fiberCount: number;
  sourceId: string;
  targetId: string;
  sourceName?: string; // Human-readable source name
  targetName?: string; // Human-readable target name
  length: number; // meters
  opticalLoss: number; // dB
  pathType: CablePathType;
}

/**
 * Cable tiers in FTTH hierarchy
 */
export type CableTier = "feeder" | "distribution" | "drop";

/**
 * Cable path type (underground vs aerial)
 */
export type CablePathType = "underground" | "aerial" | "conduit" | "aerial_span";

// ============================================================================
// Phased Grid Configuration
// ============================================================================

/**
 * Configuration for phased grid generation
 * Each phase shows a different layer of the network
 */
export interface PhaseGridConfig {
  phase: PhaseNumber;
  phaseName: string;
  description: string;

  // What to include in this phase
  includeInfrastructure: boolean; // Roads, buildings, conduits, aerial spans
  includeConduits: boolean; // Underground conduit paths
  includeAerialSpans: boolean; // Aerial span paths
  includeEquipment: EquipmentType[];
  includeCables: CableTier[];
  includeOpticalBudget: boolean;
  includeValidation: boolean;
}

/**
 * Phase numbers for the 6-phase system
 */
export type PhaseNumber = 1 | 2 | 3 | 4 | 5 | 6;

/**
 * Phase definitions
 */
export const PHASE_DEFINITIONS: Record<PhaseNumber, PhaseGridConfig> = {
  1: {
    phase: 1,
    phaseName: "Infrastructure Grid",
    description: "Roads, buildings, conduits, aerial spans",
    includeInfrastructure: true,
    includeConduits: true,
    includeAerialSpans: true,
    includeEquipment: [],
    includeCables: [],
    includeOpticalBudget: false,
    includeValidation: true,
  },
  2: {
    phase: 2,
    phaseName: "Equipment Grid",
    description: "CO, cabinets, closures (no cables yet)",
    includeInfrastructure: true,
    includeConduits: false,
    includeAerialSpans: false,
    includeEquipment: ["co", "cabinet", "cabinet-t3", "closure", "den"],
    includeCables: [],
    includeOpticalBudget: false,
    includeValidation: true,
  },
  3: {
    phase: 3,
    phaseName: "Feeder Cable Grid",
    description: "OLT → Cabinet connections",
    includeInfrastructure: true,
    includeConduits: false,
    includeAerialSpans: false,
    includeEquipment: ["co", "cabinet", "cabinet-t3"],
    includeCables: ["feeder"],
    includeOpticalBudget: true,
    includeValidation: true,
  },
  4: {
    phase: 4,
    phaseName: "Distribution Cable Grid",
    description: "Cabinet → Closure connections",
    includeInfrastructure: true,
    includeConduits: false,
    includeAerialSpans: false,
    includeEquipment: ["co", "cabinet", "cabinet-t3", "closure", "den"],
    includeCables: ["feeder", "distribution"],
    includeOpticalBudget: true,
    includeValidation: true,
  },
  5: {
    phase: 5,
    phaseName: "Drop Cable Grid",
    description: "Closure → Home connections",
    includeInfrastructure: true,
    includeConduits: false,
    includeAerialSpans: false,
    includeEquipment: ["co", "cabinet", "cabinet-t3", "closure", "den", "house"],
    includeCables: ["feeder", "distribution", "drop"],
    includeOpticalBudget: true,
    includeValidation: true,
  },
  6: {
    phase: 6,
    phaseName: "Complete Network Grid",
    description: "Full network + validation summary",
    includeInfrastructure: true,
    includeConduits: true,
    includeAerialSpans: true,
    includeEquipment: ["co", "cabinet", "cabinet-t3", "closure", "den", "house", "pole"],
    includeCables: ["feeder", "distribution", "drop"],
    includeOpticalBudget: true,
    includeValidation: true,
  },
};

// ============================================================================
// Phase Grid Output
// ============================================================================

/**
 * Output from phased grid generation
 */
export interface PhaseGrid {
  phase: PhaseNumber;
  phaseName: string;
  zoneId: string;
  zoneBounds: ZoneBoundsInfo;

  // The ASCII grid itself
  asciiGrid: string;

  // Legend section
  legend: string;

  // Registry sections (lookup tables)
  equipmentRegistry: EquipmentAnnotation[];
  cableRegistry: CableAnnotation[];

  // Validation section
  validation: ValidationResult;

  // Generation metadata
  generatedAt: Date;
  gridDimensions: {
    width: number;
    height: number;
    cellResolutionMeters: number;
  };
}

/**
 * Zone bounds information
 */
export interface ZoneBoundsInfo {
  minLng: number;
  maxLng: number;
  minLat: number;
  maxLat: number;
  widthMeters: number;
  heightMeters: number;
}

// ============================================================================
// Optical Budget Types
// ============================================================================

/**
 * Optical budget breakdown for a path
 */
export interface OpticalBudgetBreakdown {
  nodeId: string;
  pathToNode: string[]; // Array of node IDs from CO to this node
  totalLoss: number; // dB

  // Loss breakdown
  fiberLoss: number; // dB (distance × 0.35dB/km)
  splitterLoss: number; // dB (sum of splitter losses)
  connectorLoss: number; // dB (typically 0.5dB each)
  spliceLoss: number; // dB (typically 0.1dB each)
  contingency: number; // dB (safety margin, typically 3dB)

  // Status
  status: OpticalStatus;
  margin: number; // dB remaining (28 - totalLoss)
  isCompliant: boolean;
}

/**
 * Optical status indicators
 */
export type OpticalStatus = "ok" | "warning" | "critical";

/**
 * Optical budget constants (GPON Class B+)
 */
export const OPTICAL_BUDGET_CONSTANTS = {
  maxBudget: 28, // dB - GPON Class B+ limit
  fiberLossPerKm: 0.35, // dB/km @ 1310nm
  connectorLoss: 0.5, // dB per connector
  spliceLoss: 0.1, // dB per splice
  contingency: 3.0, // dB safety margin
  warningThreshold: 25, // dB - warn when above this
  criticalThreshold: 27, // dB - critical when above this

  // Splitter losses (typical)
  splitterLoss: {
    "1:4": 7.3,
    "1:8": 10.7,
    "1:16": 14.1,
    "1:32": 17.5,
  } as Record<string, number>,
};

// ============================================================================
// Validation Types
// ============================================================================

/**
 * Validation result for a phase grid
 */
export interface ValidationResult {
  passed: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  summary: ValidationSummary;
}

/**
 * Individual validation issue
 */
export interface ValidationIssue {
  id: string;
  severity: "error" | "warning" | "info";
  type: ValidationIssueType;
  description: string;
  nodeId?: string;
  cableId?: string;
  location?: [number, number];
  suggestion?: string;
}

/**
 * Types of validation issues
 */
export type ValidationIssueType =
  | "optical_budget_exceeded"
  | "cascade_exceeded"
  | "disconnected_node"
  | "cable_crosses_building"
  | "equipment_in_building"
  | "equipment_off_street"
  | "cable_too_long"
  | "splitter_overloaded"
  | "missing_equipment"
  | "orphan_home";

/**
 * Validation summary statistics
 */
export interface ValidationSummary {
  totalNodes: number;
  totalCables: number;
  connectedHomes: number;
  orphanedHomes: number;
  maxOpticalLoss: number;
  maxCascadeDepth: number;
  buildingCrossings: number;
  equipmentOnStreet: number;
  equipmentTotal: number;
}

// ============================================================================
// Enhanced Symbols
// ============================================================================

/**
 * Enhanced symbol registry for ASCII representation
 */
export const ENHANCED_SYMBOLS = {
  // Equipment (existing + enhanced)
  co: "★",
  cabinet: "◆",
  cabinet_t3: "◇", // T3/FDH cabinet
  closure: "●",
  den: "●",
  house: "○",
  pole: "│",

  // Infrastructure (existing)
  building: "▓",
  sidewalk: "░",
  road_h: "═",
  road_v: "║",
  road_cross: "╬",

  // Cable types with visual distinction (NEW)
  cable_feeder_h: "═", // Feeder horizontal (double line)
  cable_feeder_v: "║", // Feeder vertical
  cable_distribution_h: "─", // Distribution horizontal (single)
  cable_distribution_v: "│", // Distribution vertical
  cable_drop_h: "·", // Drop horizontal (dotted)
  cable_drop_v: ":", // Drop vertical

  // Infrastructure paths (NEW)
  conduit_h: "┄", // Underground conduit (dashed)
  conduit_v: "┆",
  aerial_span_h: "~", // Aerial span
  aerial_span_v: "∿",

  // Optical status (NEW)
  optical_ok: "✓",
  optical_warning: "⚠",
  optical_critical: "✗",

  // Connection indicators
  connection_node: "●",
  connection_junction: "┼",
} as const;

/**
 * Get cable symbol based on type and direction
 */
export function getCableSymbol(cableType: CableTier, direction: "horizontal" | "vertical"): string {
  const symbols = {
    feeder: {
      horizontal: ENHANCED_SYMBOLS.cable_feeder_h,
      vertical: ENHANCED_SYMBOLS.cable_feeder_v,
    },
    distribution: {
      horizontal: ENHANCED_SYMBOLS.cable_distribution_h,
      vertical: ENHANCED_SYMBOLS.cable_distribution_v,
    },
    drop: { horizontal: ENHANCED_SYMBOLS.cable_drop_h, vertical: ENHANCED_SYMBOLS.cable_drop_v },
  };
  return symbols[cableType][direction];
}

/**
 * Get infrastructure symbol based on type and direction
 */
export function getInfrastructureSymbol(
  infraType: "conduit" | "aerial_span",
  direction: "horizontal" | "vertical",
): string {
  const symbols = {
    conduit: { horizontal: ENHANCED_SYMBOLS.conduit_h, vertical: ENHANCED_SYMBOLS.conduit_v },
    aerial_span: {
      horizontal: ENHANCED_SYMBOLS.aerial_span_h,
      vertical: ENHANCED_SYMBOLS.aerial_span_v,
    },
  };
  return symbols[infraType][direction];
}

/**
 * Get optical status symbol
 */
export function getOpticalStatusSymbol(status: OpticalStatus): string {
  const symbols = {
    ok: ENHANCED_SYMBOLS.optical_ok,
    warning: ENHANCED_SYMBOLS.optical_warning,
    critical: ENHANCED_SYMBOLS.optical_critical,
  };
  return symbols[status];
}

// ============================================================================
// Topology Types
// ============================================================================

/**
 * Topology chain from CO to Home
 */
export interface TopologyChain {
  homeId: string;
  homeAddress?: string;
  path: TopologyNode[];
  totalOpticalLoss: number;
  cascadeDepth: number;
  isValid: boolean;
  issues: string[];
}

/**
 * Node in topology chain
 */
export interface TopologyNode {
  nodeId: string;
  nodeType: EquipmentType;
  label?: string;
  position: [number, number];
  gridPosition?: [number, number];
  splitterRatio?: string;
  opticalLossAtNode: number; // Cumulative loss up to this node
  cableToNext?: {
    cableId: string;
    length: number;
    tier: CableTier;
    pathType: CablePathType;
  };
}

// ============================================================================
// Agent Tool Input/Output Types
// ============================================================================

/**
 * Input for query_phase_grid tool
 */
export interface QueryPhaseGridInput {
  zoneId: string;
  phase: PhaseNumber;
  includeValidation?: boolean;
}

/**
 * Input for query_optical_budget tool
 */
export interface QueryOpticalBudgetInput {
  homeId?: string; // Specific home, or all if omitted
  nodeId?: string; // Any node in the path
}

/**
 * Input for query_topology_chain tool
 */
export interface QueryTopologyChainInput {
  homeId: string;
  includeOpticalBudget?: boolean;
}

/**
 * Output for query_phase_grid tool
 */
export interface QueryPhaseGridOutput {
  success: boolean;
  phaseGrid?: PhaseGrid;
  error?: string;
}

/**
 * Output for query_optical_budget tool
 */
export interface QueryOpticalBudgetOutput {
  success: boolean;
  budgets?: OpticalBudgetBreakdown[];
  summary?: {
    totalHomes: number;
    compliantHomes: number;
    maxLoss: number;
    avgLoss: number;
    criticalCount: number;
    warningCount: number;
  };
  error?: string;
}

/**
 * Output for query_topology_chain tool
 */
export interface QueryTopologyChainOutput {
  success: boolean;
  chain?: TopologyChain;
  error?: string;
}
