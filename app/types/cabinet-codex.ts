/**
 * Cabinet DataStore Type Definitions
 *
 * Per-cabinet file architecture for the DataStore (PostgreSQL).
 * Each cabinet gets 5 files:
 *   ports.json              — Port utilization and assignments
 *   hardware.json           — Enclosure, patch panels, power
 *   connected-closures.json — Downstream closure fiber demand
 *   CABINET.md              — Per-cabinet memory/changelog
 *
 * Plus a shared _index.json summarizing all cabinets for bulk queries.
 */

// =============================================================================
// ports.json — Port utilization and assignments
// =============================================================================

/** A single port assignment on a cabinet's distribution panel. */
export interface CabinetPortAssignment {
  /** Port number on the panel (1-based) */
  port: number;
  /** ID of the downstream closure connected to this port */
  connectedClosureId: string | null;
  /** Number of fibers allocated to this port */
  fiberCount: number;
  /** Cable ID carrying fibers from this port */
  cableId: string | null;
  /** Port assignment status */
  status: "allocated" | "reserved" | "spare";
}

/** Port utilization data for a single cabinet. */
export interface CabinetPortsData {
  /** Cabinet identifier */
  cabinetId: string;
  /** Total available ports */
  totalPorts: number;
  /** Currently used ports */
  usedPorts: number;
  /** Available (unallocated) ports */
  availablePorts: number;
  /** Per-port assignment details */
  portAssignments: CabinetPortAssignment[];
  /** ISO 8601 timestamp */
  updatedAt: string;
}

// =============================================================================
// hardware.json — Cabinet hardware manifest
// =============================================================================

/** Splitter tray installed in a cabinet. */
export interface CabinetSplitterTray {
  /** Unique tray identifier */
  id: string;
  /** Splitter ratio (e.g. "1:8") */
  ratio: string;
  /** Number of output ports on this splitter */
  portCount: number;
}

/** Patch panel installed in the cabinet. */
export interface CabinetPatchPanel {
  /** Unique panel identifier */
  id: string;
  /** Total connector ports */
  portCount: number;
  /** Connector type reference (e.g. "sc-apc") */
  type: string;
}

/** Power supply information. */
export interface CabinetPowerSupply {
  /** Power type */
  type: "passive" | "active-ac" | "active-dc";
  /** Voltage (if active) */
  voltage: number | null;
  /** Whether backup power is available */
  backup: boolean;
}

/** Hardware manifest for a single cabinet. */
export interface CabinetHardwareData {
  /** Cabinet identifier */
  cabinetId: string;
  /** Cabinet model name */
  model: string;
  /** Enclosure type description */
  enclosureType: string;
  /** Cabinet tier */
  tier: "T2" | "T3";
  /** Splitter trays installed */
  splitterTrays: CabinetSplitterTray[];
  /** Patch panels installed */
  patchPanels: CabinetPatchPanel[];
  /** Power supply information */
  powerSupply: CabinetPowerSupply;
  /** Serial number (populated during field installation) */
  serialNumber: string | null;
  /** Equipment lifecycle status */
  status: "planned" | "ordered" | "delivered" | "installed" | "active" | "failed" | "replaced";
  /** ISO 8601 timestamp */
  updatedAt: string;
}

// =============================================================================
// connected-closures.json — Downstream closures and fiber demand
// =============================================================================

/** A single downstream closure connected to this cabinet. */
export interface CabinetConnectedClosure {
  /** Closure identifier */
  closureId: string;
  /** Number of fibers demanded by this closure */
  fiberDemand: number;
  /** Distance from cabinet to closure in meters */
  distanceM: number;
  /** Cable ID connecting cabinet to this closure */
  cableId: string | null;
  /** Splitter ratio at the closure */
  splitterRatio: string;
  /** Number of homes served by this closure */
  homesServed: number;
}

/** Connected closures data for a single cabinet. */
export interface CabinetConnectedClosuresData {
  /** Cabinet identifier */
  cabinetId: string;
  /** Downstream closures */
  closures: CabinetConnectedClosure[];
  /** Total fiber demand from all downstream closures */
  totalFiberDemand: number;
  /** ISO 8601 timestamp */
  updatedAt: string;
}

// =============================================================================
// _index.json — Summary of all cabinets for bulk queries
// =============================================================================

/** Per-cabinet summary entry in the index. */
export interface CabinetIndexEntry {
  /** Cabinet identifier */
  id: string;
  /** Zone identifier */
  zone: string;
  /** Cabinet tier (T2 or T3) */
  tier: "T2" | "T3";
  /** Total available ports */
  totalPorts: number;
  /** Currently used ports */
  usedPorts: number;
  /** Number of downstream closures connected */
  connectedClosureCount: number;
  /** Total fiber demand from downstream */
  totalFiberDemand: number;
  /** Coordinates [lng, lat] */
  coordinates: [number, number] | null;
  /** Equipment lifecycle status */
  status: "planned" | "ordered" | "delivered" | "installed" | "active" | "failed" | "replaced";
}

/** The _index.json file at details/cabinets/_index.json. */
export interface CabinetIndexData {
  /** All cabinet summaries */
  cabinets: CabinetIndexEntry[];
  /** ISO 8601 timestamp of last generation */
  updatedAt: string;
}
