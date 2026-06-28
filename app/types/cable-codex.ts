/**
 * Cable DataStore Type Definitions
 *
 * Per-cable file architecture for the DataStore (PostgreSQL).
 * Each cable gets 4 files:
 *   fibers.json   — Per-fiber status and color assignment
 *   routing.json  — Deployment method, path coordinates, conduits
 *   CABLE.md      — Per-cable memory/changelog
 *
 * Plus a shared _index.json summarizing all cables for bulk queries.
 */

// =============================================================================
// fibers.json — Per-fiber status and color assignment
// =============================================================================

/** A splice point along a fiber's path. */
export interface FiberSplicePoint {
  /** Location identifier (closure or cabinet ID) */
  locationId: string;
  /** Splice type at this point */
  spliceType: "fusion" | "mechanical" | "connector";
  /** Splice loss in dB */
  lossdB: number;
}

/** Status of a single fiber within a cable. */
export type FiberStatus = "active" | "spare" | "dark" | "reserved" | "failed";

/** A single fiber within a cable. */
export interface CableFiberEntry {
  /** Fiber number within the cable (1-based) */
  fiberNumber: number;
  /** TIA-598 color for this fiber */
  color: string;
  /** What this fiber is assigned to (e.g. closure ID, address) */
  assignment: string | null;
  /** Splice points along this fiber's path */
  splicePoints: FiberSplicePoint[];
  /** Current fiber status */
  status: FiberStatus;
}

/** Fiber data for a single cable. */
export interface CableFibersData {
  /** Cable identifier */
  cableId: string;
  /** Cable type */
  cableType: "feeder" | "distribution" | "drop";
  /** Total fiber count in the cable */
  totalFibers: number;
  /** Per-fiber details */
  fibers: CableFiberEntry[];
  /** ISO 8601 timestamp */
  updatedAt: string;
}

// =============================================================================
// routing.json — Deployment method, path, conduits
// =============================================================================

/** Deployment method for a cable. */
export type CableDeploymentMethod = "underground" | "aerial" | "direct-buried" | "indoor";

/** Routing data for a single cable. */
export interface CableRoutingData {
  /** Cable identifier */
  cableId: string;
  /** How the cable is deployed */
  deploymentMethod: CableDeploymentMethod;
  /** Cable path as coordinate array [[lng, lat], ...] */
  path: Array<[number, number]>;
  /** IDs of conduits this cable passes through */
  conduitIds: string[];
  /** Length of each segment between path coordinates (meters) */
  segmentLengths: number[];
  /** Total cable length in meters */
  totalLengthM: number;
  /** ISO 8601 timestamp */
  updatedAt: string;
}

// =============================================================================
// _index.json — Summary of all cables for bulk queries
// =============================================================================

/** Per-cable summary entry in the index. */
export interface CableIndexEntry {
  /** Cable identifier */
  id: string;
  /** Cable type (feeder, distribution, drop) */
  type: "feeder" | "distribution" | "drop";
  /** Source node ID */
  source: string;
  /** Target node ID */
  target: string;
  /** Total fiber count */
  fiberCount: number;
  /** Total length in meters */
  lengthM: number;
  /** Number of active fibers */
  activeFibers: number;
  /** Number of spare fibers */
  spareFibers: number;
  /** Deployment method */
  deploymentMethod: CableDeploymentMethod;
  /** Cable lifecycle status */
  status: "planned" | "ordered" | "installed" | "active" | "failed" | "decommissioned";
}

/** The _index.json file at details/cables/_index.json. */
export interface CableIndexData {
  /** All cable summaries */
  cables: CableIndexEntry[];
  /** ISO 8601 timestamp of last generation */
  updatedAt: string;
}
