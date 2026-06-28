/**
 * DataStore Type Definitions
 *
 * DataStore is a virtual file system that AI agents read to understand FTTH network designs,
 * similar to how Claude Code explores codebases. It replaces the TextTwin system with a
 * hierarchical, indexed structure optimized for AI reasoning.
 *
 * Virtual File Structure:
 * geocodebase/
 * ├── PROJECT.md              # Agent memory for project constraints & known issues
 * ├── INDEX.json              # Fast agent lookup by address/street/element
 * ├── cross-zone.json         # Elements spanning multiple zones
 * ├── SCHEMA.md               # Describes structure for agents
 * ├── routing-graph.json      # Available paths for rerouting scenarios
 * ├── optical-paths.json      # Pre-calculated loss per address
 * ├── dependencies.json       # Upstream/downstream relationships
 * ├── capacity.json           # Used vs available (splitter ports, fibers)
 * ├── issues.json             # Warnings & errors
 * ├── changelog.json          # Audit trail
 * ├── stats.json              # Summary metrics
 * ├── addresses.json          # All addresses with coordinates
 * └── zones/{zone-id}/...     # Per-zone data
 */

import type {
  BOMCalculationData,
  BOQCalculationData,
  GraphsCalculationData,
  RiserDiagramCalculationData,
} from "@/lib/types/pricing";
import type { OpticalPathsData } from "../services/geocodebase-optical-paths";
import type { RoutingGraphJSON } from "../services/routing-graph";

// ============================================================================
// Core DataStore Types (renamed from TextTwin)
// ============================================================================

export interface ZoneBounds {
  minLng: number;
  maxLng: number;
  minLat: number;
  maxLat: number;
}

export interface ZoneId {
  row: string; // A, B, C, ...
  col: number; // 1, 2, 3, ...
}

export interface AdjacentZones {
  north?: string;
  south?: string;
  east?: string;
  west?: string;
}

export interface ZoneEquipment {
  id: string;
  symbol: string;
  type: "co" | "cabinet" | "closure" | "den" | "house" | "pole";
  coordinates: [number, number];
  gridPosition: [number, number]; // [col, row] in ASCII grid
  properties: Record<string, unknown>;
}

export interface CrossZoneLink {
  cableId: string;
  sourceZone: string;
  sourceNode: string;
  targetZone: string;
  targetNode: string;
  fiberCount: number;
  direction: "north" | "south" | "east" | "west";
}

export interface ZoneIssue {
  id: string;
  severity: "error" | "warning" | "info";
  type: string;
  description: string;
  nodeId?: string;
  suggestion?: string;
}

/**
 * DataStoreZone - A single zone in the DataStore (formerly ZoneTextTwin)
 */
export interface DataStoreZone {
  /** Zone identifier (e.g., "A1", "B2") */
  zoneId: string;

  /** Zone bounds in coordinates */
  bounds: ZoneBounds;

  /** Size in meters */
  sizeMeters: { width: number; height: number };

  /** Adjacent zones */
  adjacent: AdjacentZones;

  /** ASCII spatial grid (100x50 characters) with street names */
  asciiGrid: string;

  /** Equipment list with coordinates */
  equipment: ZoneEquipment[];

  /** GeoJSON source data (editable) */
  geojson: ZoneGeoJSON;

  /** Cross-zone connections */
  crossZoneLinks: CrossZoneLink[];

  /** Validation issues in this zone */
  issues: ZoneIssue[];

  /** Zone statistics */
  stats: {
    nodeCount: number;
    cableCount: number;
    houseCount: number;
    totalCableLength: number;
    maxOpticalLoss: number;
  };

  /** Per-closure fiber data paths (NEW) */
  closureFiberPaths?: Map<string, string>; // closureId -> path to fibers.json
}

export interface ZoneGeoJSON {
  type: "FeatureCollection";
  zone: string;
  bounds: [[number, number], [number, number]];
  features: ZoneFeature[];
}

export interface ZoneFeature {
  type: "Feature";
  id: string;
  geometry: {
    type: "Point" | "LineString";
    coordinates: [number, number] | [number, number][];
  };
  properties: {
    nodeType?: "co" | "cabinet" | "closure" | "den" | "house" | "pole";
    cableType?: "feeder" | "distribution" | "drop";
    splitterRatio?: string;
    fiberCount?: number;
    source?: string;
    target?: string;
    label?: string;
    [key: string]: unknown;
  };
}

// ============================================================================
// Splice Diagram Metadata (for DataStore-driven splice tab)
// ============================================================================

/** Port assignment on an OLT PON port */
export interface SpliceDiagramOltPort {
  portIndex: number;
  connectedNodeId: string;
  connectedNodeLabel: string;
  fiberCount: number;
}

/** OLT node metadata for splice diagram rendering */
export interface SpliceDiagramOltNode {
  id: string;
  label: string;
  ponPortCount: number;
  portAssignments: SpliceDiagramOltPort[];
}

/** An edge in the network topology for splice diagram routing */
export interface SpliceDiagramTopologyEdge {
  source: string;
  target: string;
  tier: 1 | 2 | 3;
}

/** A house node reference for splice diagram rendering */
export interface SpliceDiagramHouseNode {
  id: string;
  label: string;
  closureId: string;
  fiberIndex: number;
  fiberColor: string;
}

/**
 * SpliceDiagramMeta - Metadata that closureFibersMap alone doesn't provide:
 * OLT info, topology graph, house assignments, and generation progress.
 */
export interface SpliceDiagramMeta {
  oltNode?: SpliceDiagramOltNode;
  topologyEdges: SpliceDiagramTopologyEdge[];
  nodeTiers: Record<string, 0 | 1 | 2 | 3>;
  houseNodes?: SpliceDiagramHouseNode[];
  /** 0-100 during generation, null when complete */
  generationProgress?: number | null;
  generationMessage?: string | null;
}

/**
 * DataStore - The complete service area (formerly ServiceAreaTextTwin)
 */
export interface DataStore {
  /** Service area name */
  name: string;

  /** Total bounds */
  bounds: ZoneBounds;

  /** Grid of zones (rows x cols) */
  zoneGrid: {
    rows: number;
    cols: number;
    zoneSize: { width: number; height: number }; // meters
  };

  /** All zones */
  zones: Map<string, DataStoreZone>;

  /** Cross-zone connections */
  allCrossZoneLinks: CrossZoneLink[];

  /** Global infrastructure (roads, buildings) */
  infrastructure: {
    roads: InfrastructureRoad[];
    buildings: InfrastructureBuilding[];
    poles: InfrastructurePole[];
  };

  /** Global statistics */
  stats: {
    totalZones: number;
    totalNodes: number;
    totalCables: number;
    totalHouses: number;
    totalCableLength: number;
    maxOpticalLoss: number;
    coveragePercent: number;
  };

  /** Global validation issues */
  globalIssues: ZoneIssue[];

  /** INDEX.json for fast lookups (NEW) */
  index?: DataStoreIndex;

  /** PROJECT.md content (NEW) */
  projectMd?: string;

  /** Cross-zone data (NEW) */
  crossZone?: CrossZoneData;

  /** Per-closure fiber allocation data (fibers.json) */
  closureFibersMap?: Map<string, ClosureFibersData>;

  /** Per-closure ASCII splice diagrams (splice.txt) */
  closureSpliceMap?: Map<string, string>;

  /** Per-closure hardware manifest (hardware.json) */
  closureHardwareMap?: Map<string, import("./closure-codex").ClosureHardwareData>;

  /** Per-closure optical budget analysis (optical-budget.json) */
  closureOpticalBudgetMap?: Map<string, import("./closure-codex").ClosureOpticalBudgetData>;

  /** Per-closure verification data (verification.json) */
  closureVerificationMap?: Map<string, import("./closure-codex").ClosureVerificationData>;

  /** Per-closure photo metadata (photos.json) */
  closurePhotosMap?: Map<string, import("./closure-codex").ClosurePhotosData>;

  /** Per-closure markdown changelog (CLOSURE.md) */
  closureMarkdownMap?: Map<string, string>;

  /** Closure index summary for bulk queries (_index.json) */
  closureIndex?: import("./closure-codex").ClosureIndexData;

  // ============ Per-Cabinet Detail Data (details/cabinets/) ============

  /** Per-cabinet port utilization (ports.json) */
  cabinetDetailsMap?: Map<string, import("./cabinet-codex").CabinetPortsData>;

  /** Per-cabinet hardware manifest (hardware.json) */
  cabinetHardwareMap?: Map<string, import("./cabinet-codex").CabinetHardwareData>;

  /** Per-cabinet connected closures (connected-closures.json) */
  cabinetConnectedClosuresMap?: Map<string, import("./cabinet-codex").CabinetConnectedClosuresData>;

  /** Per-cabinet markdown changelog (CABINET.md) */
  cabinetMarkdownMap?: Map<string, string>;

  /** Cabinet index summary for bulk queries (_index.json) */
  cabinetIndex?: import("./cabinet-codex").CabinetIndexData;

  // ============ Per-CO Detail Data (details/central_offices/) ============

  /** Per-CO OLT port assignments (olt-ports.json) */
  coOltPortsMap?: Map<string, import("./co-codex").COOltPortsData>;

  /** Per-CO fiber accounting (fiber-accounting.json) */
  coFiberAccountingMap?: Map<string, import("./co-codex").COFiberAccountingData>;

  /** Per-CO hardware manifest (hardware.json) */
  coHardwareMap?: Map<string, import("./co-codex").COHardwareData>;

  /** Per-CO markdown changelog (CO.md) */
  coMarkdownMap?: Map<string, string>;

  /** CO index summary for bulk queries (_index.json) */
  coIndex?: import("./co-codex").COIndexData;

  // ============ Per-Cable Detail Data (details/cables/) ============

  /** Per-cable fiber status (fibers.json) */
  cableFibersMap?: Map<string, import("./cable-codex").CableFibersData>;

  /** Per-cable routing data (routing.json) */
  cableRoutingMap?: Map<string, import("./cable-codex").CableRoutingData>;

  /** Per-cable markdown changelog (CABLE.md) */
  cableMarkdownMap?: Map<string, string>;

  /** Cable index summary for bulk queries (_index.json) */
  cableIndex?: import("./cable-codex").CableIndexData;

  /** Pre-computed routing graph for rerouting scenarios (routing-graph.json) */
  routingGraphJson?: RoutingGraphJSON;

  /** Pre-calculated optical paths for instant AI queries (optical-paths.json) */
  opticalPathsData?: OpticalPathsData;

  /** Splice diagram metadata (OLT, topology, house assignments, generation progress) */
  spliceDiagramMeta?: SpliceDiagramMeta;

  /** Enriched address data with survey information (addresses.json) */
  addressesData?: AddressesData;

  // ============ Navigator Category Files (Source of Truth) ============

  /** Underground paths/conduits (underground_paths.json) */
  undergroundPathsData?: UndergroundPathsData;

  /** Aerial spans (aerial_spans.json) */
  aerialSpansData?: AerialSpansData;

  /** Poles (poles.json) */
  polesData?: PolesData;

  /** Central offices/OLT (central_offices.json) */
  centralOfficesData?: CentralOfficesData;

  /** Cabinets T2/T3 (cabinets.json) */
  cabinetsData?: CabinetsData;

  /** Closures/splitters (closures.json) */
  closuresData?: ClosuresData;

  /** Homes/endpoints (homes.json) */
  homesData?: HomesData;

  /** All cables by tier (cables.json) */
  cablesData?: CablesData;

  // ============ BOM/BoQ Calculation Data (bom/ and boq/) ============

  /** Persisted BOM calculation data (bom/materials.json) */
  bomData?: BOMCalculationData;

  /** Persisted BoQ calculation data (boq/labor.json) */
  boqData?: BOQCalculationData;

  // ============ Graphs/Charts Data (graphs/) ============

  /** Persisted graphs chart data (graphs/charts.json) */
  graphsData?: GraphsCalculationData;

  // ============ Riser Diagram Data (riser/) ============

  /** Persisted riser diagram data (riser/buildings.json) */
  riserData?: RiserDiagramCalculationData;

  // ============ Per-Building Detail Data (details/buildings/) ============

  /** Per-building riser diagram data (riser.json) */
  buildingRiserMap?: Map<string, import("./building-codex").BuildingRiserDataStoreData>;

  /** Building index summary for bulk queries (_index.json) */
  buildingIndex?: import("./building-codex").BuildingIndexData;
}

// ============================================================================
// Addresses Types (addresses.json) - GeoJSON FeatureCollection Format
// ============================================================================

/**
 * AddressProperties - Properties for GeoJSON Address Feature
 * Note: In DataStore, addresses = homes (same concept). AddressesData represents
 * all buildings/homes in the service area that need fiber connectivity.
 */
export interface AddressProperties {
  /** Unique address ID (e.g., "TLV-ADDR-001" or house node ID) */
  address_id: string;

  /** Full street address */
  address: string;

  /** Normalized address for matching (lowercase, no diacritics) */
  normalized_address: string;

  /** Street name only (for queries like "all addresses on HaYarkon") */
  street_name?: string;

  /** Street number (for sorting: 35א before 36) */
  street_number?: string;

  /** Zone this address belongs to */
  zone: string;

  /** Building ID from polygon analysis */
  building_id?: string;

  /** Building type from OSM or survey */
  building_type?: "residential" | "commercial" | "hotel" | "industrial" | "mixed" | "unknown";

  /** Building footprint polygon coordinates from OSM (for map visualization) */
  footprint?: [number, number][];

  /** Closure serving this address (FK to closures.json) */
  serving_closure?: string;

  // ============ Survey Enrichment Data (from Address Matching AI) ============

  /** Number of floors in the building */
  floors?: number;

  /** Units per floor (apartments) */
  units_per_floor?: number;

  /** Calculated fiber demand (floors × units_per_floor) */
  fiber_demand?: number;

  /** Data confidence: high=OSM/survey data, low=defaults, none=unmatched */
  match_confidence?: "high" | "medium" | "low" | "none";

  /** AI reasoning for the match (Haiku's explanation) */
  match_reasoning?: string;

  /** Original survey line that was matched */
  survey_raw?: string;

  /** When survey data was imported */
  survey_imported_at?: string;

  // ============ Network Data (calculated after network generation) ============

  /** Pre-calculated optical loss to CO */
  optical_loss_db?: number;

  /** Drop cable length in meters */
  drop_cable_length?: number;

  /** Connection status */
  status?: "connected" | "orphaned" | "planned";
}

/**
 * AddressFeature - GeoJSON Feature for a single address
 */
export type AddressFeature = {
  type: "Feature";
  id: string;
  geometry:
    | { type: "Point"; coordinates: [number, number] }
    | { type: "Polygon"; coordinates: [number, number][][] };
  properties: AddressProperties;
};

/**
 * AddressSummary - Summary statistics for addresses
 */
export interface AddressSummary {
  total_addresses: number;
  with_survey_data: number;
  connected: number;
  orphaned: number;
  total_fiber_demand: number;
  avg_optical_loss_db?: number;
  max_optical_loss_db?: number;
}

/**
 * AddressesData - GeoJSON FeatureCollection for addresses.json
 * SOURCE OF TRUTH for all address information
 */
export interface AddressesData {
  type: "FeatureCollection";
  features: AddressFeature[];
  metadata?: {
    version: "1.0";
    generated_at: string;
    summary?: AddressSummary;
    by_zone?: Record<
      string,
      {
        address_count: number;
        fiber_demand: number;
        closures: string[];
      }
    >;
    by_street?: Record<
      string,
      {
        address_ids: string[];
        total_demand: number;
        zones: string[];
      }
    >;
  };
}

/**
 * LegacyAddressesData - Old format for backward compatibility
 * @deprecated Use AddressesData (GeoJSON FeatureCollection) instead
 */
export interface LegacyAddressesData {
  version: "1.0";
  generated_at: string;
  addresses: AddressEntry[];
  summary: AddressSummary;
  by_zone: Record<
    string,
    {
      address_count: number;
      fiber_demand: number;
      closures: string[];
    }
  >;
  by_street: Record<
    string,
    {
      address_ids: string[];
      total_demand: number;
      zones: string[];
    }
  >;
}

/**
 * AddressEntry - Legacy format for internal use and backward compatibility
 * Includes position directly (not in geometry like GeoJSON)
 * @deprecated For new code, use AddressFeature with AddressProperties
 */
export interface AddressEntry extends AddressProperties {
  /** Geographic coordinates [lng, lat] */
  position: [number, number];
}

// ============================================================================
// Infrastructure Types
// ============================================================================

export interface InfrastructureRoad {
  id: string;
  name?: string;
  type: "primary" | "secondary" | "residential" | "service";
  coordinates: [number, number][];
  width: number;
}

export interface InfrastructureBuilding {
  id: string;
  coordinates: [number, number][][];
  centroid: [number, number];
  type?: "residential" | "commercial" | "industrial";
  /** Street address (from OSM or geocoding) */
  address?: string;
  /** Number of floors (from OSM tags or estimation) */
  floors?: number;
}

export interface InfrastructurePole {
  id: string;
  position: [number, number];
  type: "utility" | "telecom" | "new";
}

// ============================================================================
// INDEX.json Types (NEW)
// ============================================================================

export interface AddressIndexEntry {
  zone: string;
  closure: string;
  address_id: string;
  optical_loss_db?: number;
  fiber_path?: string[];
}

export interface StreetIndexEntry {
  zones: string[];
  closures: string[];
  cabinets: string[];
  houses_count: number;
}

export interface ElementIndexEntry {
  type: "co" | "cabinet" | "closure" | "cable" | "house";
  zone: string;
  path: string; // e.g., "zones/A1/equipment/closures/CL-001"
}

/**
 * DataStoreIndex - Fast O(1) lookups for agents
 */
export interface DataStoreIndex {
  version: "1.0";

  /** Address -> zone + closure + fiber path */
  by_address: Record<string, AddressIndexEntry>;

  /** Street name -> zones, closures, cabinets, house count */
  by_street: Record<string, StreetIndexEntry>;

  /** Element ID -> type + zone + path */
  by_element: Record<string, ElementIndexEntry>;

  /** Metadata */
  generated_at: string;
  total_addresses: number;
  total_streets: number;
  total_elements: number;
}

// ============================================================================
// PROJECT.md Types (NEW)
// ============================================================================

export interface ProjectConstraints {
  maxOpticalBudget?: number; // Override default 28dB
  preferredDeployment?: "underground" | "aerial" | "mixed";
  splitterPreference?: "1:4" | "1:8" | "1:16" | "1:32";
  maxDropDistance?: number; // meters
  maxDistributionDistance?: number; // meters
  customConstraints?: Record<string, string>;
}

export interface ProjectKnownIssue {
  date: string;
  description: string;
  location?: string;
  resolution?: string;
  approvedBy?: string;
}

export interface ProjectFieldNote {
  date: string;
  author?: string;
  note: string;
  location?: string;
}

export interface ProjectHistory {
  date: string;
  event: string;
  details?: string;
}

export interface ProjectMemory {
  projectName: string;
  location: string;
  addressCount: number;
  status: "planning" | "approved" | "in-progress" | "completed";
  constraints: ProjectConstraints;
  knownIssues: ProjectKnownIssue[];
  fieldNotes: ProjectFieldNote[];
  history: ProjectHistory[];
  contacts?: Record<string, string>;
  decisions?: string[];
}

// ============================================================================
// Memory Manager Types (lifecycle management for PROJECT.md)
// ============================================================================

/** A timestamped entry in the agent's memory */
export interface MemoryEntry {
  timestamp: string;
  content: string;
  category: "decision" | "constraint" | "issue" | "field_note" | "history";
}

/** Structured context derived from PROJECT.md for LLM injection */
export interface MemoryContext {
  raw: string;
  parsed: ProjectMemory;
  decisions: string[];
  tokenEstimate: number;
}

/** Intent type determines how much PROJECT.md context is injected into the LLM prompt */
export type PromptIntentType = "simple" | "network" | "design" | "phase_review";

// ============================================================================
// cross-zone.json Types (NEW)
// ============================================================================

export interface ZoneCrossingPoint {
  position: [number, number];
  fromZone: string;
  toZone: string;
}

export interface CrossZoneCable {
  cableId: string;
  cableType: "feeder" | "distribution" | "drop";
  zones: string[];
  crossingPoints: ZoneCrossingPoint[];
  fiberCount: number;
  totalLength: number;
}

export interface CrossZoneClosure {
  closureId: string;
  primaryZone: string;
  servedZones: string[];
  housesPerZone: Record<string, number>;
}

export interface ZoneBoundarySummary {
  zone: string;
  adjacentZone: string;
  direction: "north" | "south" | "east" | "west";
  cablesAcross: number;
  fibersAcross: number;
}

/**
 * CrossZoneData - Elements spanning multiple zones
 */
export interface CrossZoneData {
  version: "1.0";

  /** Cables that cross zone boundaries */
  cables: CrossZoneCable[];

  /** Closures serving homes in multiple zones */
  closures: CrossZoneClosure[];

  /** Infrastructure spanning zones (conduits, aerial spans) */
  infrastructure: {
    conduits: CrossZoneCable[];
    aerialSpans: CrossZoneCable[];
  };

  /** Summary by zone boundary */
  boundaryStats: ZoneBoundarySummary[];

  /** Metadata */
  generated_at: string;
}

// ============================================================================
// fibers.json Types (NEW - Source of Truth for Splice Data)
// ============================================================================

export interface FiberAllocation {
  fiber: number;
  color: string; // TIA-598 color name
  usage: "splitter_input" | "pass_through" | "reserve" | "terminated";
  destination?: string; // Node ID or port number
}

export interface SplitterPortAssignment {
  port: number;
  address_id: string | null;
  drop_cable: string | null;
  status: "allocated" | "available" | "reserved";
  fiber_color?: string;
}

/**
 * ClosureFibersData - Canonical fiber allocation data for a closure
 * This is the SOURCE OF TRUTH - ReactFlow FTTHDenNode reads from this
 */
export interface ClosureFibersData {
  closure_id: string;
  location: string;
  splitter_ratio: string;

  /** Input cable information */
  input_cable: {
    id: string;
    fiber_count: number;
    from: string; // Source node ID
  };

  /** Fiber allocation table */
  fiber_allocation: FiberAllocation[];

  /** Splitter output port assignments */
  splitter_output: SplitterPortAssignment[];

  /** Pass-through fibers to downstream */
  pass_through?: {
    to_closure: string;
    fiber_indices: number[];
  }[];

  /** Equipment lifecycle status */
  status?:
    | "planned"
    | "ordered"
    | "delivered"
    | "installed"
    | "tested"
    | "active"
    | "failed"
    | "replaced";

  /** Metadata */
  updated_at: string;
}

// ============================================================================
// splice.txt Types (NEW - ASCII Splice Diagram)
// ============================================================================

export interface SpliceDiagramConfig {
  closureId: string;
  location: string;
  splitterRatio: string;
  fibersData: ClosureFibersData;
  showColors: boolean;
  showPorts: boolean;
}

// ============================================================================
// Grid with Street Names Types (NEW)
// ============================================================================

export interface StreetLabel {
  name: string;
  position: [number, number]; // Grid position [col, row]
  orientation: "horizontal" | "vertical";
  length: number; // Character length on grid
}

export interface GridWithStreets {
  grid: string;
  streetLabels: StreetLabel[];
  horizontalStreets: StreetLabel[];
  verticalStreets: StreetLabel[];
}

// ============================================================================
// Lookup Service Types (NEW)
// ============================================================================

export interface AddressQueryResult {
  found: boolean;
  address: string;
  zone?: string;
  closure?: {
    id: string;
    splitterRatio: string;
    position: [number, number];
  };
  fiberPath?: string[];
  opticalLoss?: number;
  dropCable?: {
    id: string;
    length: number;
  };
}

export interface StreetQueryResult {
  found: boolean;
  streetName: string;
  zones: string[];
  closures: Array<{
    id: string;
    zone: string;
    housesServed: number;
  }>;
  cabinets: Array<{
    id: string;
    zone: string;
  }>;
  totalHouses: number;
}

export interface ElementQueryResult {
  found: boolean;
  elementId: string;
  type: "co" | "cabinet" | "closure" | "cable" | "house";
  zone: string;
  position?: [number, number];
  details: Record<string, unknown>;
}

export interface CrossZoneQueryResult {
  found: boolean;
  elementId: string;
  spansZones: string[];
  crossingPoints?: ZoneCrossingPoint[];
}

// ============================================================================
// Event Types (Updated from TextTwin)
// ============================================================================

export interface DataStoreUpdatedEventDetail {
  geocodebase: DataStore;
  changedZones?: string[];
  updateType: "full" | "partial" | "index" | "project";
}

// ============================================================================
// Generation Input Types
// ============================================================================

export interface GenerateDataStoreInput {
  name: string;
  bounds: ZoneBounds;
  nodes: NetworkNodeInput[];
  cables: NetworkCableInput[];
  infrastructure?: {
    roads?: InfrastructureRoad[];
    buildings?: InfrastructureBuilding[];
    poles?: InfrastructurePole[];
  };
  zoneSize?: { width: number; height: number };
  projectConstraints?: ProjectConstraints;
}

export interface NetworkNodeInput {
  id: string;
  type: "co" | "cabinet" | "closure" | "house" | "pole";
  position: [number, number];
  label?: string;
  splitterRatio?: string;
  totalFibers?: number;
  ports?: number;
  address?: string;
  /** Building type from OSM (for houses) */
  buildingType?: "residential" | "commercial" | "hotel" | "industrial" | "mixed" | "unknown";
}

export interface NetworkCableInput {
  id: string;
  source: string;
  target: string;
  cableType?: "feeder" | "distribution" | "drop";
  fiberCount?: number;
  length?: number;
  path?: [number, number][];
}

export interface GenerateIndexInput {
  houses: NetworkNodeInput[];
  cables: NetworkCableInput[];
  closures: NetworkNodeInput[];
  cabinets: NetworkNodeInput[];
  nodeById: Map<string, NetworkNodeInput>;
  zoneForNode: Map<string, string>;
}

export interface GenerateCrossZoneInput {
  cables: NetworkCableInput[];
  closures: NetworkNodeInput[];
  nodeById: Map<string, NetworkNodeInput>;
  zoneBounds: Map<string, ZoneBounds>;
  zoneForNode: Map<string, string>;
}

// ============================================================================
// Constants
// ============================================================================

export const GEOCODEBASE_VERSION = "1.0";

export const DEFAULT_ZONE_SIZE = { width: 200, height: 200 };

export const GRID_WIDTH = 100;
export const GRID_HEIGHT = 50;

/** Optical loss constants */
export const OPTICAL_CONSTANTS = {
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
// Navigator Category File Types (DataStore → Navigator 1:1 mapping)
// ============================================================================

/**
 * Underground Paths Data (conduits) - Physical Tab
 * SOURCE OF TRUTH: GeoJSON FeatureCollection (LineString)
 * Each feature represents a conduit/underground path with fiber cables
 */
export interface UndergroundPathProperties {
  id: string;
  name?: string;
  diameter?: number;
  length?: number;
  material?: string;
  cables?: string[]; // IDs of cables running through this conduit
}

export type UndergroundPathFeature = {
  type: "Feature";
  id: string;
  geometry: { type: "LineString"; coordinates: Array<[number, number]> };
  properties: UndergroundPathProperties;
};

export interface UndergroundPathsData {
  type: "FeatureCollection";
  features: UndergroundPathFeature[];
}

/**
 * Aerial Spans Data - Physical Tab
 * SOURCE OF TRUTH: GeoJSON FeatureCollection (LineString)
 * Each feature represents an aerial span between poles
 */
export interface AerialSpanProperties {
  id: string;
  name?: string;
  span_length?: number;
  start_pole?: string;
  end_pole?: string;
  cables?: string[]; // IDs of cables running on this span
}

export type AerialSpanFeature = {
  type: "Feature";
  id: string;
  geometry: { type: "LineString"; coordinates: Array<[number, number]> };
  properties: AerialSpanProperties;
};

export interface AerialSpansData {
  type: "FeatureCollection";
  features: AerialSpanFeature[];
}

/**
 * Poles Data - Physical Tab
 * SOURCE OF TRUTH: GeoJSON FeatureCollection (Point)
 * Each feature represents a utility/telecom pole
 */
export interface PoleProperties {
  id: string;
  name?: string;
  type?: "utility" | "telecom" | "new";
  height?: number;
  mounted_equipment?: string[]; // IDs of closures/equipment mounted on pole
}

export type PoleFeature = {
  type: "Feature";
  id: string;
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: PoleProperties;
};

export interface PolesData {
  type: "FeatureCollection";
  features: PoleFeature[];
}

/**
 * Central Offices Data - Both tabs (CO/OLT)
 * SOURCE OF TRUTH: GeoJSON FeatureCollection (Point)
 * Each feature represents a central office/OLT location
 */
export interface CentralOfficeProperties {
  id: string;
  /** Human-readable label (e.g. "TLV-A1-CO-001"); `id` is the stable ULID. */
  label?: string;
  name?: string;
  port_count?: number;
  total_fibers?: number;
  downstream_cabinets?: string[];
}

export type CentralOfficeFeature = {
  type: "Feature";
  id: string;
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: CentralOfficeProperties;
};

export interface CentralOfficesData {
  type: "FeatureCollection";
  features: CentralOfficeFeature[];
}

/**
 * Cabinets Data - Topology Tab
 * SOURCE OF TRUTH: GeoJSON FeatureCollection (Point)
 * Each feature represents a network cabinet (T2 or T3)
 */
export interface CabinetProperties {
  id: string;
  /** Human-readable label (e.g. "TLV-A1-T2-001"); `id` is the stable ULID. */
  label?: string;
  zone: string;
  tier: "T2" | "T3";
  port_count?: number;
  cabinet_type?: string;
  upstream_node?: string;
  downstream_closures?: string[];
  existing?: boolean;
}

export type CabinetFeature = {
  type: "Feature";
  id: string;
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: CabinetProperties;
};

export interface CabinetsData {
  type: "FeatureCollection";
  features: CabinetFeature[];
}

/**
 * Closures Data - Topology Tab
 * SOURCE OF TRUTH: GeoJSON FeatureCollection (Point)
 * Each feature represents a distribution closure/splitter
 */
export interface ClosureProperties {
  id: string;
  /** Human-readable label (e.g. "TLV-A1-CL-001"); `id` is the stable ULID. */
  label?: string;
  zone: string;
  splitter_ratio?: string;
  homes_served?: number;
  upstream_node?: string;
  optical_loss?: number;
  mounted_on_pole?: string; // Pole ID if pole-mounted
  existing?: boolean;
  installation_type?: string;
}

export type ClosureFeature = {
  type: "Feature";
  id: string;
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: ClosureProperties;
};

export interface ClosuresData {
  type: "FeatureCollection";
  features: ClosureFeature[];
}

/**
 * Homes Data - Topology Tab
 * SOURCE OF TRUTH: GeoJSON FeatureCollection (Point)
 * Each feature represents a home/endpoint node (ONT)
 */
export interface HomeProperties {
  id: string;
  /** Human-readable label; `id` is the stable ULID. */
  label?: string;
  zone: string;
  address?: string;
  address_id?: string; // Links to addresses.json
  serving_closure?: string;
  optical_loss?: number;
  drop_cable_length?: number;
  status: "connected" | "orphaned" | "planned";
  existing?: boolean;
}

export type HomeFeature = {
  type: "Feature";
  id: string;
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: HomeProperties;
};

export interface HomesData {
  type: "FeatureCollection";
  features: HomeFeature[];
}

/**
 * Cables Data - Topology Tab
 * SOURCE OF TRUTH: GeoJSON FeatureCollection (LineString)
 * Each feature represents a network cable (feeder, distribution, or drop)
 */
export interface CableProperties {
  id: string;
  /** Human-readable label; `id` is the stable ULID. */
  label?: string;
  type: "feeder" | "distribution" | "drop";
  source: string;
  target: string;
  fiber_count: number;
  length: number;
  contained_in?: string; // ID of conduit or aerial_span
  existing?: boolean;
  infrastructure_type?: "underground" | "aerial" | "direct_buried";
}

export type CableFeature = {
  type: "Feature";
  id: string;
  geometry: { type: "LineString"; coordinates: Array<[number, number]> };
  properties: CableProperties;
};

export interface CablesData {
  type: "FeatureCollection";
  features: CableFeature[];
}

/** Symbols for ASCII grid */
export const GEOCODEBASE_SYMBOLS = {
  // Equipment symbols
  co: "★",
  cabinet: "◆",
  cabinet_t3: "◇",
  closure: "●",
  den: "●",
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

  // Cable type symbols
  cable_feeder_h: "═",
  cable_feeder_v: "║",
  cable_distribution_h: "─",
  cable_distribution_v: "│",
  cable_drop_h: "·",
  cable_drop_v: ":",

  // Infrastructure path symbols
  conduit_h: "┄",
  conduit_v: "┆",
  aerial_span_h: "~",
  aerial_span_v: "∿",

  // Optical status symbols
  optical_ok: "✓",
  optical_warning: "⚠",
  optical_critical: "✗",

  // Utility symbols
  empty: " ",
  error: "×",
  zone_link: "→",
} as const;
