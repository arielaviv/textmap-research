/**
 * Closure DataStore Type Definitions
 *
 * Per-closure file architecture for the DataStore (PostgreSQL).
 * Each closure gets 6 files:
 *   fibers.json          — Fiber allocation (already exists)
 *   hardware.json         — Connectors + equipment
 *   optical-budget.json   — Loss budget per path
 *   verification.json     — Photo verification checkpoints
 *   photos.json           — Photo metadata + blob URLs
 *   CLOSURE.md            — Per-closure memory/changelog
 *
 * Plus a shared _index.json summarizing all closures for bulk queries.
 */

import type { ConnectorType } from "./splice-connectors";
import type { EnclosureDefinition, SpliceTrayDefinition } from "./splice-equipment";

// =============================================================================
// hardware.json — Enclosure, connectors, splitters, splice protectors
// =============================================================================

/** A single connector installed in the closure's adapter panel. */
export interface ClosureConnectorEntry {
  /** Port number on the adapter panel (1-based) */
  port: number;
  /** Reference to ConnectorType.id (e.g. "sc-apc") */
  connectorTypeId: string;
  /** Connector details snapshot for offline use */
  connector: ConnectorType;
  /** Which address/home this port serves (null if unpatched) */
  addressId: string | null;
  /** Fiber color assigned to this port (TIA-598) */
  fiberColor: string;
}

/** Hardware manifest for a single closure. */
export interface ClosureHardwareData {
  /** Closure identifier */
  closureId: string;
  /** Selected enclosure model */
  enclosure: EnclosureDefinition;
  /** Splice trays installed */
  trays: SpliceTrayDefinition[];
  /** PLC splitter module */
  splitter: {
    ratio: string;
    model: string;
    insertionLoss: number;
  };
  /** Connectors on the adapter panel */
  connectors: ClosureConnectorEntry[];
  /** Heat-shrink splice protectors used */
  spliceProtectors: {
    count: number;
    type: "heat-shrink" | "mechanical";
  };
  /** Serial number (populated during field installation) */
  serialNumber: string | null;
  /** Equipment lifecycle status */
  status: "planned" | "ordered" | "delivered" | "installed" | "active" | "failed" | "replaced";
  /** ISO 8601 timestamp */
  updatedAt: string;
}

// =============================================================================
// optical-budget.json — Per-port optical loss breakdown
// =============================================================================

/** Loss contribution by component type. */
export interface OpticalLossBreakdown {
  /** Fiber attenuation (distance × 0.35 dB/km) */
  fiberLoss: number;
  /** Connector insertion loss (count × 0.5 dB each) */
  connectorLoss: number;
  /** Fusion splice loss (count × 0.1 dB each) */
  spliceLoss: number;
  /** PLC splitter insertion loss */
  splitterLoss: number;
  /** Contingency margin (default 3.0 dB) */
  contingency: number;
}

/** Optical path from this closure to a single address/home. */
export interface OpticalPathEntry {
  /** Splitter output port (1-based) */
  port: number;
  /** Address served by this port */
  addressId: string | null;
  /** Distance from OLT to this address in km */
  distanceKm: number;
  /** Cumulative loss from OLT to this port (dB) */
  cumulativeLoss: number;
  /** Budget remaining = 28 dB − cumulativeLoss */
  budgetRemaining: number;
  /** Detailed loss breakdown */
  breakdown: OpticalLossBreakdown;
  /** Whether this path is within the 28 dB budget */
  compliant: boolean;
}

/** Optical budget analysis for a single closure. */
export interface ClosureOpticalBudgetData {
  /** Closure identifier */
  closureId: string;
  /** Max optical budget (default 28 dB for GPON Class B+) */
  maxBudget: number;
  /** Design-time splice loss (dB) */
  designSpliceLoss: number;
  /** Measured splice loss after installation (null until tested) */
  measuredSpliceLoss: number | null;
  /** Design-time splitter loss (dB) */
  designSplitterLoss: number;
  /** Measured splitter loss (null until tested) */
  measuredSplitterLoss: number | null;
  /** Per-port optical path entries */
  paths: OpticalPathEntry[];
  /** ISO 8601 timestamp */
  updatedAt: string;
}

// =============================================================================
// verification.json — Installation checkpoints and defects
// =============================================================================

/** A single checkpoint within a verification session. */
export interface VerificationCheckpoint {
  /** What was expected (e.g. "Fiber 3 Blue spliced to Port 3") */
  expected: string;
  /** What was actually found */
  found: string;
  /** Whether this checkpoint passed */
  pass: boolean;
}

/** A defect logged during verification. */
export interface VerificationDefect {
  /** Defect description */
  description: string;
  /** Severity level */
  severity: "critical" | "major" | "minor";
  /** Photo ID reference (from photos.json) */
  photoId: string | null;
}

/** A single verification session (one visit / one inspector). */
export interface VerificationEntry {
  /** Unique verification session ID */
  id: string;
  /** Who performed the verification */
  inspector: string | null;
  /** Verification type */
  type: "pre-installation" | "post-splice" | "otdr" | "final-acceptance";
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Checkpoints evaluated */
  checkpoints: VerificationCheckpoint[];
  /** Defects found */
  defects: VerificationDefect[];
  /** Overall result */
  result: "pass" | "fail" | "conditional";
}

/** Verification data for a single closure. */
export interface ClosureVerificationData {
  /** Closure identifier */
  closureId: string;
  /** All verification sessions, newest first */
  verifications: VerificationEntry[];
  /** ISO 8601 timestamp */
  updatedAt: string;
}

// =============================================================================
// photos.json — Photo metadata with blob storage URLs
// =============================================================================

/** Photo type classification. */
export type ClosurePhotoType =
  | "incident"
  | "verification"
  | "otdr-trace"
  | "as-built"
  | "before"
  | "after"
  | "defect";

/** GPS coordinates where the photo was taken. */
export interface PhotoGPS {
  latitude: number;
  longitude: number;
  accuracy: number;
}

/** A single photo entry. */
export interface ClosurePhotoEntry {
  /** Unique photo ID */
  id: string;
  /** Photo classification */
  type: ClosurePhotoType;
  /** Blob storage URL (S3, Azure, etc.) */
  url: string;
  /** Thumbnail URL for list views */
  thumbnailUrl: string | null;
  /** GPS where the photo was taken */
  gps: PhotoGPS | null;
  /** Free-text context (e.g. "Splice tray 1 after fusion") */
  context: string;
  /** Who took the photo */
  takenBy: string | null;
  /** ISO 8601 timestamp */
  takenAt: string;
}

/** Photo collection for a single closure. */
export interface ClosurePhotosData {
  /** Closure identifier */
  closureId: string;
  /** All photos, newest first */
  photos: ClosurePhotoEntry[];
  /** ISO 8601 timestamp */
  updatedAt: string;
}

// =============================================================================
// _index.json — Summary of all closures for bulk queries
// =============================================================================

/** Per-closure summary entry in the index. */
export interface ClosureIndexEntry {
  /** Closure identifier */
  id: string;
  /** Human-readable location description */
  location: string;
  /** Splitter ratio (e.g. "1:8") */
  splitterRatio: string;
  /** Number of homes served by this closure */
  homesServed: number;
  /** Maximum optical loss among all paths through this closure (dB) */
  maxLoss: number;
  /** Port utilization: allocated / total */
  portUtilization: {
    allocated: number;
    total: number;
  };
  /** Equipment lifecycle status */
  status:
    | "planned"
    | "ordered"
    | "delivered"
    | "installed"
    | "tested"
    | "active"
    | "failed"
    | "replaced";
  /** Coordinates [lng, lat] */
  coordinates: [number, number] | null;
}

/** The _index.json file at details/closures/_index.json. */
export interface ClosureIndexData {
  /** All closure summaries */
  closures: ClosureIndexEntry[];
  /** ISO 8601 timestamp of last generation */
  updatedAt: string;
}

// =============================================================================
// Optical Loss Constants (used by generators)
// =============================================================================

/** Optical loss constants for budget calculations. */
export const OPTICAL_LOSS = {
  /** Fiber attenuation in dB per km (ITU-T G.652D @ 1310nm) */
  fiberPerKm: 0.35,
  /** Connector insertion loss per mated pair (dB) */
  connectorPair: 0.5,
  /** Fusion splice loss per splice point (dB) */
  fusionSplice: 0.1,
  /** Contingency/safety margin (dB) */
  contingency: 3.0,
  /** Max optical budget for GPON Class B+ (dB) */
  maxBudget: 28,
} as const;

/** Splitter insertion loss lookup by ratio (dB). */
export const SPLITTER_LOSS_DB: Record<string, number> = {
  "1:2": 3.6,
  "1:4": 7.2,
  "1:8": 10.8,
  "1:16": 14.1,
  "1:32": 17.5,
  "1:64": 21.0,
};
