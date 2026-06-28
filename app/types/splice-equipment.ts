/**
 * Splice Equipment Types — Splice trays, enclosures, and patch panels
 * for FTTH network splice point modeling.
 */

// ---------------------------------------------------------------------------
// Type aliases
// ---------------------------------------------------------------------------

/** Method used to join two fiber ends inside a splice tray. */
type SpliceMethod = "fusion" | "mechanical";

/** Physical form factor of a splice enclosure. */
type EnclosureType = "dome" | "inline" | "wall-mount" | "rack-mount";

/** How / where the enclosure is mounted in the field. */
type MountType = "pole" | "underground" | "wall" | "rack" | "pedestal";

/** Standard rack-unit height for patch panels. */
type PanelFormFactor = "1U" | "2U" | "4U";

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

/** A single splice tray that sits inside an enclosure. */
export interface SpliceTrayDefinition {
  /** Unique identifier */
  id: string;
  /** Human-readable name */
  name: string;
  /** Maximum fibers the tray can hold */
  capacity: number;
  /** Optional fiber range descriptor, e.g. "1-12" */
  fiberRange?: string;
  /** Tray position number within the enclosure (1-based) */
  trayNumber: number;
  /** Splice joining method used in this tray */
  spliceType: SpliceMethod;
}

/** A splice enclosure (closure) that houses one or more splice trays. */
export interface EnclosureDefinition {
  /** Unique identifier, e.g. "dome-48f" */
  id: string;
  /** Human-readable name */
  name: string;
  /** Physical shape / style */
  type: EnclosureType;
  /** Maximum splice trays the enclosure can accept */
  maxTrays: number;
  /** Maximum total fiber capacity */
  maxFibers: number;
  /** Number of cable entry / exit ports */
  cablePorts: number;
  /** Ingress protection rating, e.g. "IP68" */
  ipRating: string;
  /** Primary mounting method */
  mountType: MountType;
}

/** A connectorized patch panel installed in a cabinet or rack. */
export interface PatchPanelDefinition {
  /** Unique identifier */
  id: string;
  /** Human-readable name */
  name: string;
  /** Total connector ports on the front face */
  ports: number;
  /** Reference to a ConnectorType.id from splice-connectors */
  connectorType: string;
  /** Rack-unit height */
  formFactor: PanelFormFactor;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Standard enclosure types used in FTTH deployments. */
export const ENCLOSURE_TYPES: Record<string, EnclosureDefinition> = {
  "dome-48f": {
    id: "dome-48f",
    name: "Dome Closure 48F",
    type: "dome",
    maxTrays: 4,
    maxFibers: 48,
    cablePorts: 4,
    ipRating: "IP68",
    mountType: "pole",
    // Also suitable for underground — pole is the primary mount.
  },
  "dome-96f": {
    id: "dome-96f",
    name: "Dome Closure 96F",
    type: "dome",
    maxTrays: 8,
    maxFibers: 96,
    cablePorts: 6,
    ipRating: "IP68",
    mountType: "pole",
  },
  "inline-24f": {
    id: "inline-24f",
    name: "Inline Closure 24F",
    type: "inline",
    maxTrays: 2,
    maxFibers: 24,
    cablePorts: 2,
    ipRating: "IP67",
    mountType: "underground",
  },
  "inline-48f": {
    id: "inline-48f",
    name: "Inline Closure 48F",
    type: "inline",
    maxTrays: 4,
    maxFibers: 48,
    cablePorts: 3,
    ipRating: "IP67",
    mountType: "underground",
  },
  "wall-12f": {
    id: "wall-12f",
    name: "Wall Box 12F",
    type: "wall-mount",
    maxTrays: 1,
    maxFibers: 12,
    cablePorts: 2,
    ipRating: "IP55",
    mountType: "wall",
  },
  "rack-144f": {
    id: "rack-144f",
    name: "Rack Splice Unit 144F",
    type: "rack-mount",
    maxTrays: 12,
    maxFibers: 144,
    cablePorts: 8,
    ipRating: "IP20",
    mountType: "rack",
  },
};
