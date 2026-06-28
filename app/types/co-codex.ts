/**
 * Central Office (CO) DataStore Type Definitions
 *
 * Per-CO file architecture for the DataStore (PostgreSQL).
 * Each central office gets 5 files:
 *   olt-ports.json        — OLT PON port assignments
 *   fiber-accounting.json — Fiber utilization and reserve tracking
 *   hardware.json         — OLT model, rack, power, cooling
 *   CO.md                 — Per-CO memory/changelog
 *
 * Plus a shared _index.json summarizing all COs for bulk queries.
 */

// =============================================================================
// olt-ports.json — OLT PON port assignments
// =============================================================================

/** A single PON port assignment on the OLT. */
export interface COPortAssignment {
  /** PON port number (1-based) */
  ponPort: number;
  /** ID of the downstream cabinet connected to this port */
  cabinetId: string | null;
  /** Human-readable cabinet label */
  cabinetLabel: string | null;
  /** Number of fibers allocated to this cabinet */
  fiberCount: number;
  /** Wavelength (e.g. "1310nm", "1490nm") */
  wavelength: string | null;
  /** Port assignment status */
  status: "allocated" | "reserved" | "spare";
}

/** OLT port utilization data for a single CO. */
export interface COOltPortsData {
  /** Central office identifier */
  coId: string;
  /** Total PON ports on the OLT */
  totalPonPorts: number;
  /** Per-port assignment details */
  portAssignments: COPortAssignment[];
  /** ISO 8601 timestamp */
  updatedAt: string;
}

// =============================================================================
// fiber-accounting.json — Fiber utilization tracking
// =============================================================================

/** Per-cabinet fiber breakdown from this CO. */
export interface COFiberPerCabinet {
  /** Cabinet identifier */
  cabinetId: string;
  /** Number of fibers allocated to this cabinet */
  fiberCount: number;
  /** Cable ID carrying fibers to this cabinet */
  cableId: string | null;
  /** Distance from CO to cabinet in meters */
  distanceM: number;
}

/** Fiber accounting data for a single CO. */
export interface COFiberAccountingData {
  /** Central office identifier */
  coId: string;
  /** Total fibers leaving the CO */
  totalFibersOut: number;
  /** Reserve fibers (typically 10-15% buffer) */
  reserveFibers: number;
  /** Utilization percentage (totalFibersOut / capacity × 100) */
  utilizationPercent: number;
  /** Per-cabinet fiber breakdown */
  perCabinet: COFiberPerCabinet[];
  /** ISO 8601 timestamp */
  updatedAt: string;
}

// =============================================================================
// hardware.json — CO hardware manifest
// =============================================================================

/** Power supply information for the CO. */
export interface COPowerInfo {
  /** Primary power consumption in watts */
  primaryWatts: number;
  /** UPS battery capacity in hours */
  upsCapacityHours: number;
  /** UPS status */
  upsStatus: "active" | "degraded" | "failed" | "none";
}

/** Cooling system information. */
export interface COCoolingInfo {
  /** Cooling type */
  type: "passive" | "fan" | "ac";
  /** Cooling status */
  status: "operational" | "degraded" | "failed";
}

/** Hardware manifest for a single CO. */
export interface COHardwareData {
  /** Central office identifier */
  coId: string;
  /** OLT model name */
  oltModel: string;
  /** Rack position identifier */
  rackPosition: string | null;
  /** Total card/module slots on the OLT */
  totalSlots: number;
  /** Currently used slots */
  usedSlots: number;
  /** Power supply information */
  power: COPowerInfo;
  /** Cooling system information */
  cooling: COCoolingInfo;
  /** Serial number (populated during installation) */
  serialNumber: string | null;
  /** Equipment lifecycle status */
  status: "planned" | "ordered" | "delivered" | "installed" | "active" | "failed" | "replaced";
  /** ISO 8601 timestamp */
  updatedAt: string;
}

// =============================================================================
// _index.json — Summary of all COs for bulk queries
// =============================================================================

/** Per-CO summary entry in the index. */
export interface COIndexEntry {
  /** Central office identifier */
  id: string;
  /** Human-readable name */
  name: string;
  /** Total PON ports on the OLT */
  totalPonPorts: number;
  /** Currently used PON ports */
  usedPonPorts: number;
  /** Total fibers leaving the CO */
  totalFibersOut: number;
  /** Number of downstream cabinets connected */
  cabinetCount: number;
  /** Coordinates [lng, lat] */
  coordinates: [number, number] | null;
  /** Equipment lifecycle status */
  status: "planned" | "ordered" | "delivered" | "installed" | "active" | "failed" | "replaced";
}

/** The _index.json file at details/central_offices/_index.json. */
export interface COIndexData {
  /** All CO summaries */
  centralOffices: COIndexEntry[];
  /** ISO 8601 timestamp of last generation */
  updatedAt: string;
}
