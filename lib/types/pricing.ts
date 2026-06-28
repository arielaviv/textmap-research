/**
 * Pricing Types for BOM/BoQ System
 * Organization-level pricing configuration with audit trail
 */

// Categories for pricing items
export type PricingCategory = "fiber_cable" | "equipment" | "labor" | "civil";

// Subcategories for cable tiers
export type CableSubcategory = "feeder" | "distribution" | "drop";

// Source of pricing update for audit trail
export type PricingSource = "manual" | "ai_chat" | "document_upload";

// Domain types for multi-network support
export type PricingDomain = "ftth" | "5g" | "electric" | "gas" | "water";

// Individual pricing item data
export interface PricingItemData {
  id: string;
  itemCode: string;
  category: PricingCategory;
  subcategory: CableSubcategory | null;
  description: string;
  unit: string;
  unitCost: number;
  vendor: string | null;
  leadTimeDays: number | null;
  notes: string | null;
  source?: PricingSource;
  updatedAt?: Date;
}

// Complete pricing configuration
export interface PricingConfig {
  id: string;
  name: string;
  domain: PricingDomain;
  currency: string;
  isActive: boolean;
  items: PricingItemData[];
  createdAt: Date;
  updatedAt: Date;
}

// Result of pricing update operations
export interface PricingUpdateResult {
  success: boolean;
  updated: number;
  created: number;
  errors?: string[];
}

// Preview for document import
export interface PricingImportPreview {
  matched: PricingImportMatch[];
  unmatched: PricingImportUnmatched[];
  conflicts: PricingImportConflict[];
}

export interface PricingImportMatch {
  ourItemCode: string;
  ourItemId: string;
  documentPrice: number;
  ourPrice: number;
  confidence: number; // 0-1
  description: string;
}

export interface PricingImportUnmatched {
  description: string;
  price: number;
  unit?: string;
  suggestedCode: string;
  reason: string;
}

export interface PricingImportConflict {
  itemCode: string;
  itemId: string;
  oldValue: number;
  newValue: number;
  percentChange: number;
}

// Audit log entry
export interface PricingAuditEntry {
  id: string;
  action: "create" | "update" | "delete" | "import" | "ai_update";
  changeSource: PricingSource;
  sourceFile?: string;
  previousValue?: { unitCost: number };
  newValue?: { unitCost: number };
  userName: string;
  createdAt: Date;
  itemCode?: string;
}

// BOM item for display
export interface BOMItem {
  code: string;
  description: string;
  category: PricingCategory;
  qty: number;
  unit: string;
  unitCost: number;
  totalCost: number;
}

// BoQ item for display (labor/tasks)
export interface BOQItem {
  code: string;
  description: string;
  category: "civil" | "cable_work" | "splicing" | "installation" | "testing";
  qty: number;
  unit: string;
  rate: number;
  totalCost: number;
}

// ============================================================================
// BOM/BoQ Calculation Data Types (for DataStore.geo persistence)
// ============================================================================

/** Existing infrastructure counts for per-item deduction */
export interface ExistingInfrastructure {
  poles: number;
  handholes: number;
  manholes: number;
  pedestals: number;
  conduitMeters: number;
  aerialMeters: number;
}

/** Persisted BOM calculation result for DataStore.geo */
export interface BOMCalculationData {
  items: BOMItem[];
  summary: {
    totalMaterialsCost: number;
    totalItems: number;
    byCategory: Record<PricingCategory, { itemCount: number; totalCost: number }>;
  };
  existingInfrastructure: ExistingInfrastructure;
  calculatedAt: string;
  sourceVersion: string;
}

/** Persisted BoQ calculation result for DataStore.geo */
export interface BOQCalculationData {
  items: BOQItem[];
  summary: {
    totalLaborCost: number;
    totalItems: number;
    byCategory: Record<BOQItem["category"], { itemCount: number; totalCost: number }>;
    deploymentScenario: "greenfield" | "brownfield" | "hybrid";
  };
  existingInfrastructure: ExistingInfrastructure;
  calculatedAt: string;
  sourceVersion: string;
}

// ============================================================================
// Graphs Calculation Data Types (for DataStore.geo persistence)
// ============================================================================

/** A single entry in a chart dataset */
export interface ChartDataEntry {
  name: string;
  value?: number;
  count?: number;
  cost?: number;
  fill: string;
}

/** Persisted graphs/chart calculation result for DataStore.geo */
export interface GraphsCalculationData {
  cableDistribution: ChartDataEntry[];
  equipmentInventory: ChartDataEntry[];
  costSplit: ChartDataEntry[];
  costByCategory: ChartDataEntry[];
  totalHomes: number;
  calculatedAt: string;
  sourceVersion: string;
}

// ============================================================================
// Riser Diagram Data Types (for DataStore.geo persistence)
// ============================================================================

/** Persisted riser diagram data for all buildings in the project */
export interface RiserDiagramCalculationData {
  buildings: RiserBuildingEntry[];
  calculatedAt: string;
  sourceVersion: string;
}

/** Serialized building riser entry (matches BuildingRiserNodeData shape) */
export interface RiserBuildingEntry {
  buildingId: string;
  buildingName: string;
  address?: string;
  bdf: {
    id: string;
    fiberCount: number;
    sourceClosureId: string;
  };
  floors: Array<{
    floorNumber: number;
    fdpId: string;
    apartments: Array<{
      unit: string;
      fiberNumber: number;
      tubeColor: string;
      fiberColor: string;
      status: "active" | "reserved" | "spare" | "inactive";
    }>;
  }>;
  riserCableType?: string;
}

// Default pricing for fallback
export const DEFAULT_PRICES: Record<string, number> = {
  // Cables (per meter)
  "CABLE-FEEDER-48F": 7.8,
  "CABLE-FEEDER-96F": 12.5,
  "CABLE-DIST-12F": 2.5,
  "CABLE-DIST-24F": 3.8,
  "CABLE-DROP-2F": 0.8,
  "CABLE-DROP-1F": 0.6,

  // Equipment (per piece)
  "OLT-PORT": 500,
  "ONT-UNIT": 65,
  "SPLITTER-1:4": 18,
  "SPLITTER-1:8": 25,
  "SPLITTER-1:16": 35,
  "SPLITTER-1:32": 45,
  CLOSURE: 125,
  "CABINET-T2": 450,
  "CABINET-T3": 850,

  // Connectors (per piece)
  "CONNECTOR-SC-APC": 3.5,
  "CONNECTOR-LC-APC": 4.0,
  "PIGTAIL-SC-APC": 8.0,

  // Civil Infrastructure (per piece)
  "HANDHOLE-SMALL": 650,
  "HANDHOLE-LARGE": 1200,
  MANHOLE: 4500,
  PEDESTAL: 350,
  "POLE-ATTACHMENT": 150,
  "POLE-NEW": 1800,

  // Ducts (per meter)
  "DUCT-100MM": 18,
  "DUCT-50MM": 12,
  "DUCT-32MM": 8,

  // Labor (per unit)
  "LABOR-SPLICE": 12,
  "LABOR-TRENCH-M": 45,
  "LABOR-CONDUIT-M": 25,
  "LABOR-PULL-M": 8,
  "LABOR-TERMINATE": 15,
  "LABOR-CLOSURE-INSTALL": 85,
  "LABOR-CABINET-INSTALL": 250,
  "LABOR-ONT-INSTALL": 75,
  "LABOR-OTDR-TEST": 45,

  // Civil Infrastructure Labor (per unit)
  "LABOR-HANDHOLE-INSTALL": 450,
  "LABOR-MANHOLE-INSTALL": 2400,
  "LABOR-PEDESTAL-INSTALL": 180,
  "LABOR-POLE-INSTALL": 650,
  "LABOR-POLE-ATTACH": 85,

  // Additional Civil Infrastructure (per meter/piece)
  "HDPE-DUCT-40MM": 8.5,
  "MICRODUCT-10MM": 2.8,
  "HANDHOLE-MEDIUM": 850,
  "WARNING-TAPE": 0.15,
  "MARKER-POST": 35,

  // Aerial Infrastructure (per piece/meter)
  "POLE-WOOD-10M": 450,
  "STRAND-WIRE": 3.5,
  "AERIAL-CLAMP": 12,

  // Additional Labor Tasks (per unit)
  "LABOR-HDD-M": 85,
  "LABOR-STRAND-INSTALL": 8,
  "LABOR-CABLE-BLOW": 4,
  "LABOR-DUCT-INSTALL-M": 25,
  "LABOR-AERIAL-M": 15,

  // Testing (per test)
  "OTDR-TEST-SEGMENT": 45,
  "POWER-METER-TEST": 25,
};

// Item descriptions for display
export const ITEM_DESCRIPTIONS: Record<string, string> = {
  "CABLE-FEEDER-48F": "Feeder Cable 48F SMF",
  "CABLE-FEEDER-96F": "Feeder Cable 96F SMF",
  "CABLE-DIST-12F": "Distribution Cable 12F SMF",
  "CABLE-DIST-24F": "Distribution Cable 24F SMF",
  "CABLE-DROP-2F": "Drop Cable 2F",
  "CABLE-DROP-1F": "Drop Cable 1F",
  "OLT-PORT": "OLT Port",
  "ONT-UNIT": "ONT Unit (GPON)",
  "SPLITTER-1:4": "Splitter 1:4",
  "SPLITTER-1:8": "Splitter 1:8",
  "SPLITTER-1:16": "Splitter 1:16",
  "SPLITTER-1:32": "Splitter 1:32",
  CLOSURE: "Fiber Closure",
  "CABINET-T2": "T2 Cabinet (288 port)",
  "CABINET-T3": "T3 Cabinet (576 port)",
  "CONNECTOR-SC-APC": "SC/APC Connector",
  "CONNECTOR-LC-APC": "LC/APC Connector",
  "PIGTAIL-SC-APC": "SC/APC Pigtail 1.5m",
  // Civil Infrastructure
  "HANDHOLE-SMALL": "Small Handhole (17x30)",
  "HANDHOLE-LARGE": "Large Handhole (24x36)",
  MANHOLE: "Manhole (48x48)",
  PEDESTAL: "Above-Ground Pedestal",
  "POLE-ATTACHMENT": "Pole Attachment Hardware",
  "POLE-NEW": "New Utility Pole (35ft)",
  "DUCT-100MM": "HDPE Duct 100mm",
  "DUCT-50MM": "HDPE Duct 50mm",
  "DUCT-32MM": "HDPE Microduct 32mm",
  PULLBOX: "Cable Pull Box",
  // Labor
  "LABOR-SPLICE": "Fusion Splice",
  "LABOR-TRENCH-M": "Trenching",
  "LABOR-CONDUIT-M": "Conduit Installation",
  "LABOR-PULL-M": "Cable Pulling",
  "LABOR-TERMINATE": "Cable Termination",
  "LABOR-CLOSURE-INSTALL": "Closure Installation",
  "LABOR-CABINET-INSTALL": "Cabinet Installation",
  "LABOR-ONT-INSTALL": "ONT Installation",
  "LABOR-OTDR-TEST": "OTDR Testing",
  // Civil Infrastructure Labor
  "LABOR-HANDHOLE-INSTALL": "Handhole Installation",
  "LABOR-MANHOLE-INSTALL": "Manhole Installation",
  "LABOR-PEDESTAL-INSTALL": "Pedestal Installation",
  "LABOR-POLE-INSTALL": "Pole Installation",
  "LABOR-POLE-ATTACH": "Pole Attachment",
  "LABOR-PULLBOX-INSTALL": "Pull Box Installation",

  // Additional Civil Infrastructure
  "HDPE-DUCT-40MM": "HDPE Duct 40mm",
  "MICRODUCT-10MM": "Microduct 10mm",
  "HANDHOLE-MEDIUM": "Medium Handhole (24x30)",
  "WARNING-TAPE": "Underground Warning Tape",
  "MARKER-POST": "Cable Route Marker Post",

  // Aerial Infrastructure
  "POLE-WOOD-10M": "Wood Utility Pole 10m",
  "STRAND-WIRE": "Aerial Support Strand Wire",
  "AERIAL-CLAMP": "Aerial Cable Clamp",

  // Additional Labor Tasks
  "LABOR-HDD-M": "Horizontal Directional Drilling",
  "LABOR-STRAND-INSTALL": "Strand Wire Installation",
  "LABOR-CABLE-BLOW": "Cable Blowing in Microduct",
  "LABOR-DUCT-INSTALL-M": "Duct Installation",
  "LABOR-AERIAL-M": "Aerial Cable Installation",

  // Testing
  "OTDR-TEST-SEGMENT": "OTDR Testing (per segment)",
  "POWER-METER-TEST": "Optical Power Meter Test",
};

// Item units
export const ITEM_UNITS: Record<string, string> = {
  "CABLE-FEEDER-48F": "m",
  "CABLE-FEEDER-96F": "m",
  "CABLE-DIST-12F": "m",
  "CABLE-DIST-24F": "m",
  "CABLE-DROP-2F": "m",
  "CABLE-DROP-1F": "m",
  "OLT-PORT": "pcs",
  "ONT-UNIT": "pcs",
  "SPLITTER-1:4": "pcs",
  "SPLITTER-1:8": "pcs",
  "SPLITTER-1:16": "pcs",
  "SPLITTER-1:32": "pcs",
  CLOSURE: "pcs",
  "CABINET-T2": "pcs",
  "CABINET-T3": "pcs",
  "CONNECTOR-SC-APC": "pcs",
  "CONNECTOR-LC-APC": "pcs",
  "PIGTAIL-SC-APC": "pcs",
  // Civil Infrastructure
  "HANDHOLE-SMALL": "pcs",
  "HANDHOLE-LARGE": "pcs",
  MANHOLE: "pcs",
  PEDESTAL: "pcs",
  "POLE-ATTACHMENT": "pcs",
  "POLE-NEW": "pcs",
  "DUCT-100MM": "m",
  "DUCT-50MM": "m",
  "DUCT-32MM": "m",
  PULLBOX: "pcs",
  // Labor
  "LABOR-SPLICE": "splices",
  "LABOR-TRENCH-M": "m",
  "LABOR-CONDUIT-M": "m",
  "LABOR-PULL-M": "m",
  "LABOR-TERMINATE": "ends",
  "LABOR-CLOSURE-INSTALL": "pcs",
  "LABOR-CABINET-INSTALL": "pcs",
  "LABOR-ONT-INSTALL": "pcs",
  "LABOR-OTDR-TEST": "segments",
  // Civil Infrastructure Labor
  "LABOR-HANDHOLE-INSTALL": "pcs",
  "LABOR-MANHOLE-INSTALL": "pcs",
  "LABOR-PEDESTAL-INSTALL": "pcs",
  "LABOR-POLE-INSTALL": "pcs",
  "LABOR-POLE-ATTACH": "pcs",
  "LABOR-PULLBOX-INSTALL": "pcs",

  // Additional Civil Infrastructure
  "HDPE-DUCT-40MM": "m",
  "MICRODUCT-10MM": "m",
  "HANDHOLE-MEDIUM": "pcs",
  "WARNING-TAPE": "m",
  "MARKER-POST": "pcs",

  // Aerial Infrastructure
  "POLE-WOOD-10M": "pcs",
  "STRAND-WIRE": "m",
  "AERIAL-CLAMP": "pcs",

  // Additional Labor Tasks
  "LABOR-HDD-M": "m",
  "LABOR-STRAND-INSTALL": "m",
  "LABOR-CABLE-BLOW": "m",
  "LABOR-DUCT-INSTALL-M": "m",
  "LABOR-AERIAL-M": "m",

  // Testing
  "OTDR-TEST-SEGMENT": "tests",
  "POWER-METER-TEST": "tests",
};

// Item categories
export const ITEM_CATEGORIES: Record<string, PricingCategory> = {
  "CABLE-FEEDER-48F": "fiber_cable",
  "CABLE-FEEDER-96F": "fiber_cable",
  "CABLE-DIST-12F": "fiber_cable",
  "CABLE-DIST-24F": "fiber_cable",
  "CABLE-DROP-2F": "fiber_cable",
  "CABLE-DROP-1F": "fiber_cable",
  "OLT-PORT": "equipment",
  "ONT-UNIT": "equipment",
  "SPLITTER-1:4": "equipment",
  "SPLITTER-1:8": "equipment",
  "SPLITTER-1:16": "equipment",
  "SPLITTER-1:32": "equipment",
  CLOSURE: "equipment",
  "CABINET-T2": "equipment",
  "CABINET-T3": "equipment",
  "CONNECTOR-SC-APC": "equipment",
  "CONNECTOR-LC-APC": "equipment",
  "PIGTAIL-SC-APC": "equipment",
  // Civil Infrastructure Materials
  "HANDHOLE-SMALL": "civil",
  "HANDHOLE-LARGE": "civil",
  MANHOLE: "civil",
  PEDESTAL: "civil",
  "POLE-ATTACHMENT": "civil",
  "POLE-NEW": "civil",
  "DUCT-100MM": "civil",
  "DUCT-50MM": "civil",
  "DUCT-32MM": "civil",
  PULLBOX: "civil",
  // Labor
  "LABOR-SPLICE": "labor",
  "LABOR-TRENCH-M": "civil",
  "LABOR-CONDUIT-M": "civil",
  "LABOR-PULL-M": "labor",
  "LABOR-TERMINATE": "labor",
  "LABOR-CLOSURE-INSTALL": "labor",
  "LABOR-CABINET-INSTALL": "labor",
  "LABOR-ONT-INSTALL": "labor",
  "LABOR-OTDR-TEST": "labor",
  // Civil Infrastructure Labor
  "LABOR-HANDHOLE-INSTALL": "civil",
  "LABOR-MANHOLE-INSTALL": "civil",
  "LABOR-PEDESTAL-INSTALL": "civil",
  "LABOR-POLE-INSTALL": "civil",
  "LABOR-POLE-ATTACH": "civil",
  "LABOR-PULLBOX-INSTALL": "civil",

  // Additional Civil Infrastructure
  "HDPE-DUCT-40MM": "civil",
  "MICRODUCT-10MM": "civil",
  "HANDHOLE-MEDIUM": "civil",
  "WARNING-TAPE": "civil",
  "MARKER-POST": "civil",

  // Aerial Infrastructure
  "POLE-WOOD-10M": "civil",
  "STRAND-WIRE": "civil",
  "AERIAL-CLAMP": "civil",

  // Additional Labor Tasks
  "LABOR-HDD-M": "civil",
  "LABOR-STRAND-INSTALL": "civil",
  "LABOR-CABLE-BLOW": "labor",
  "LABOR-DUCT-INSTALL-M": "civil",
  "LABOR-AERIAL-M": "civil",

  // Testing
  "OTDR-TEST-SEGMENT": "labor",
  "POWER-METER-TEST": "labor",
};
