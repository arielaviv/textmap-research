/**
 * Splice Connector Types — Connector form factors, pigtail definitions,
 * and adapter definitions for FTTH splice enclosure modeling.
 */

// ---------------------------------------------------------------------------
// Type aliases
// ---------------------------------------------------------------------------

/** Physical form factor of a fiber optic connector. */
type ConnectorFormFactor = "SC" | "LC" | "FC" | "ST" | "MPO" | "MTP";

/** Polish type applied to the ferrule end-face. */
type ConnectorPolish = "UPC" | "APC" | "PC";

/** Fiber type used in pigtails. */
type PigtailFiberType = "SM" | "MM" | "SM-G657A1" | "SM-G657A2";

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

/** A specific connector variant (form factor + polish combination). */
export interface ConnectorType {
  /** Unique identifier, e.g. "sc-upc" */
  id: string;
  /** Human-readable name, e.g. "SC/UPC" */
  name: string;
  /** Physical form factor */
  type: ConnectorFormFactor;
  /** Ferrule polish */
  polish: ConnectorPolish;
  /** Typical insertion loss per mated pair (dB) */
  insertionLoss: number;
  /** Minimum return loss (dB, negative value) */
  returnLoss: number;
  /** Short description */
  description: string;
}

/** A pre-terminated pigtail used inside splice enclosures. */
export interface PigtailDefinition {
  /** Unique identifier */
  id: string;
  /** Reference to a ConnectorType.id */
  connectorType: string;
  /** Fiber specification */
  fiberType: PigtailFiberType;
  /** Factory pigtail length in meters */
  lengthMeters: number;
  /** Jacket or boot color (TIA-598 or vendor convention) */
  color: string;
}

/** A bulkhead adapter allowing two connectors to mate. */
export interface AdapterDefinition {
  /** Unique identifier */
  id: string;
  /** ConnectorType.id on one side */
  connectorTypeA: string;
  /** ConnectorType.id on the other side */
  connectorTypeB: string;
  /** Adapter insertion loss (dB) */
  insertionLoss: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Canonical set of connector types used in FTTH splice enclosures. */
export const CONNECTOR_TYPES: Record<string, ConnectorType> = {
  "sc-upc": {
    id: "sc-upc",
    name: "SC/UPC",
    type: "SC",
    polish: "UPC",
    insertionLoss: 0.3,
    returnLoss: -50,
    description: "Standard SC connector with UPC polish — common in PON OLTs",
  },
  "sc-apc": {
    id: "sc-apc",
    name: "SC/APC",
    type: "SC",
    polish: "APC",
    insertionLoss: 0.3,
    returnLoss: -60,
    description: "SC connector with APC polish — required for GPON ONTs",
  },
  "lc-upc": {
    id: "lc-upc",
    name: "LC/UPC",
    type: "LC",
    polish: "UPC",
    insertionLoss: 0.2,
    returnLoss: -50,
    description: "Small form-factor LC with UPC — high-density patch panels",
  },
  "lc-apc": {
    id: "lc-apc",
    name: "LC/APC",
    type: "LC",
    polish: "APC",
    insertionLoss: 0.2,
    returnLoss: -60,
    description: "LC with APC polish — used in PON distribution frames",
  },
  "fc-upc": {
    id: "fc-upc",
    name: "FC/UPC",
    type: "FC",
    polish: "UPC",
    insertionLoss: 0.3,
    returnLoss: -50,
    description: "FC connector with UPC — legacy test equipment",
  },
  "fc-apc": {
    id: "fc-apc",
    name: "FC/APC",
    type: "FC",
    polish: "APC",
    insertionLoss: 0.3,
    returnLoss: -60,
    description: "FC with APC polish — precision test and measurement",
  },
  "mpo-upc": {
    id: "mpo-upc",
    name: "MPO/UPC",
    type: "MPO",
    polish: "UPC",
    insertionLoss: 0.35,
    returnLoss: -50,
    description: "MPO multi-fiber connector — ribbon cable trunk lines",
  },
  "mtp-apc": {
    id: "mtp-apc",
    name: "MTP/APC",
    type: "MTP",
    polish: "APC",
    insertionLoss: 0.35,
    returnLoss: -60,
    description: "MTP (enhanced MPO) with APC — high-density data center",
  },
};

/** Default connector ID for new pigtails / patch cords. */
export const DEFAULT_CONNECTOR_ID = "sc-upc";
