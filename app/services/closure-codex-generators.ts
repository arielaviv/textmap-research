/**
 * Closure DataStore Generators
 *
 * Six generator functions that produce per-closure files from existing
 * closureFibersMap data. Each returns the structured content for one
 * of the new closure files:
 *   hardware.json, optical-budget.json, verification.json,
 *   photos.json, CLOSURE.md, and _index.json.
 */

import type {
  ClosureConnectorEntry,
  ClosureHardwareData,
  ClosureIndexData,
  ClosureIndexEntry,
  ClosureOpticalBudgetData,
  ClosurePhotosData,
  ClosureVerificationData,
  OpticalLossBreakdown,
  OpticalPathEntry,
} from "../types/closure-codex";
import { OPTICAL_LOSS, SPLITTER_LOSS_DB } from "../types/closure-codex";
import type { ClosureFibersData } from "../types/geocodebase";
import { CONNECTOR_TYPES, DEFAULT_CONNECTOR_ID } from "../types/splice-connectors";
import type { SpliceTrayDefinition } from "../types/splice-equipment";
import { ENCLOSURE_TYPES } from "../types/splice-equipment";

// TIA-598-C standard colors (1-based position → color name)
const TIA_598_COLORS = [
  "Blue",
  "Orange",
  "Green",
  "Brown",
  "Slate",
  "White",
  "Red",
  "Black",
  "Yellow",
  "Violet",
  "Rose",
  "Aqua",
];

// ---------------------------------------------------------------------------
// Network context passed from the generation pipeline
// ---------------------------------------------------------------------------

export interface ClosureNetworkContext {
  /** Distance from OLT to this closure in km (if known) */
  distanceFromOltKm?: number;
  /** Number of splice points between OLT and this closure */
  spliceCount?: number;
  /** Number of connector pairs between OLT and this closure */
  connectorPairCount?: number;
  /** Coordinates [lng, lat] of this closure */
  coordinates?: [number, number] | null;
}

// ---------------------------------------------------------------------------
// 1. generateClosureHardware
// ---------------------------------------------------------------------------

function selectEnclosure(fiberCount: number): string {
  if (fiberCount <= 12) return "wall-12f";
  if (fiberCount <= 24) return "inline-24f";
  if (fiberCount <= 48) return "dome-48f";
  if (fiberCount <= 96) return "dome-96f";
  return "rack-144f";
}

function buildTrays(fiberCount: number): SpliceTrayDefinition[] {
  const trayCapacity = 12;
  const trayCount = Math.ceil(fiberCount / trayCapacity);
  const trays: SpliceTrayDefinition[] = [];

  for (let i = 0; i < trayCount; i++) {
    const start = i * trayCapacity + 1;
    const end = Math.min((i + 1) * trayCapacity, fiberCount);
    trays.push({
      id: `tray-${i + 1}`,
      name: `Tray ${i + 1}`,
      capacity: trayCapacity,
      fiberRange: `${start}-${end}`,
      trayNumber: i + 1,
      spliceType: "fusion",
    });
  }

  return trays;
}

export function generateClosureHardware(
  fibersData: ClosureFibersData,
  closureId: string,
): ClosureHardwareData {
  const ratio = fibersData.splitter_ratio || "1:8";
  const splitterPorts = Number.parseInt(ratio.split(":")[1] || "8", 10);
  const fiberCount = fibersData.input_cable?.fiber_count ?? 12;

  const enclosureId = selectEnclosure(fiberCount);
  const enclosure = ENCLOSURE_TYPES[enclosureId] ?? ENCLOSURE_TYPES["dome-48f"];

  const connectorType = CONNECTOR_TYPES[DEFAULT_CONNECTOR_ID];

  const connectors: ClosureConnectorEntry[] = [];
  for (let port = 1; port <= splitterPorts; port++) {
    const splitterOutput = fibersData.splitter_output?.find((s) => s.port === port);
    const colorIndex = (port - 1) % TIA_598_COLORS.length;

    connectors.push({
      port,
      connectorTypeId: DEFAULT_CONNECTOR_ID,
      connector: connectorType,
      addressId: splitterOutput?.address_id ?? null,
      fiberColor: TIA_598_COLORS[colorIndex],
    });
  }

  const splitterLoss = SPLITTER_LOSS_DB[ratio] ?? 10.8;

  return {
    closureId,
    enclosure,
    trays: buildTrays(fiberCount),
    splitter: {
      ratio,
      model: `PLC-${ratio.replace(":", "x")}`,
      insertionLoss: splitterLoss,
    },
    connectors,
    spliceProtectors: {
      count: fiberCount,
      type: "heat-shrink",
    },
    serialNumber: null,
    status: "planned",
    updatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// 2. generateClosureOpticalBudget
// ---------------------------------------------------------------------------

export function generateClosureOpticalBudget(
  fibersData: ClosureFibersData,
  closureId: string,
  networkContext?: ClosureNetworkContext,
): ClosureOpticalBudgetData {
  const ratio = fibersData.splitter_ratio || "1:8";
  const splitterLoss = SPLITTER_LOSS_DB[ratio] ?? 10.8;
  const splitterPorts = Number.parseInt(ratio.split(":")[1] || "8", 10);

  const distanceKm = networkContext?.distanceFromOltKm ?? 0;
  const spliceCount = networkContext?.spliceCount ?? 3;
  const connectorPairCount = networkContext?.connectorPairCount ?? 3;

  const paths: OpticalPathEntry[] = [];

  for (let port = 1; port <= splitterPorts; port++) {
    const splitterOutput = fibersData.splitter_output?.find((s) => s.port === port);

    const breakdown: OpticalLossBreakdown = {
      fiberLoss: distanceKm * OPTICAL_LOSS.fiberPerKm,
      connectorLoss: connectorPairCount * OPTICAL_LOSS.connectorPair,
      spliceLoss: spliceCount * OPTICAL_LOSS.fusionSplice,
      splitterLoss,
      contingency: OPTICAL_LOSS.contingency,
    };

    const cumulativeLoss =
      breakdown.fiberLoss +
      breakdown.connectorLoss +
      breakdown.spliceLoss +
      breakdown.splitterLoss +
      breakdown.contingency;

    paths.push({
      port,
      addressId: splitterOutput?.address_id ?? null,
      distanceKm,
      cumulativeLoss: Math.round(cumulativeLoss * 100) / 100,
      budgetRemaining: Math.round((OPTICAL_LOSS.maxBudget - cumulativeLoss) * 100) / 100,
      breakdown,
      compliant: cumulativeLoss <= OPTICAL_LOSS.maxBudget,
    });
  }

  const designSpliceLoss = spliceCount * OPTICAL_LOSS.fusionSplice;

  return {
    closureId,
    maxBudget: OPTICAL_LOSS.maxBudget,
    designSpliceLoss: Math.round(designSpliceLoss * 100) / 100,
    measuredSpliceLoss: null,
    designSplitterLoss: splitterLoss,
    measuredSplitterLoss: null,
    paths,
    updatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// 3. generateClosureVerification
// ---------------------------------------------------------------------------

export function generateClosureVerification(closureId: string): ClosureVerificationData {
  return {
    closureId,
    verifications: [],
    updatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// 4. generateClosurePhotos
// ---------------------------------------------------------------------------

export function generateClosurePhotos(closureId: string): ClosurePhotosData {
  return {
    closureId,
    photos: [],
    updatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// 5. generateClosureMd
// ---------------------------------------------------------------------------

export function generateClosureMd(fibersData: ClosureFibersData, closureId: string): string {
  const ratio = fibersData.splitter_ratio || "1:8";
  const fiberCount = fibersData.input_cable?.fiber_count ?? 12;
  const location = fibersData.location || "Unknown";
  const homeCount = fibersData.splitter_output?.filter((s) => s.status === "allocated").length ?? 0;
  const now = new Date().toISOString();

  return [
    `# ${closureId}`,
    "",
    `**Location:** ${location}`,
    `**Splitter Ratio:** ${ratio}`,
    `**Fiber Count:** ${fiberCount}`,
    `**Homes Served:** ${homeCount}`,
    "",
    "## Changelog",
    "",
    `### ${now}`,
    "",
    `- Created during network generation`,
    `- Splitter ratio: ${ratio}`,
    `- Input cable: ${fiberCount} fibers from ${fibersData.input_cable?.from ?? "unknown"}`,
    `- Homes allocated: ${homeCount}`,
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// 6. generateClosureIndex
// ---------------------------------------------------------------------------

export function generateClosureIndex(
  closureFibersMap: Map<string, ClosureFibersData>,
  opticalBudgetMap?: Map<string, ClosureOpticalBudgetData>,
  coordinatesMap?: Map<string, [number, number]>,
): ClosureIndexData {
  const closures: ClosureIndexEntry[] = [];

  for (const [closureId, fibersData] of closureFibersMap) {
    const ratio = fibersData.splitter_ratio || "1:8";
    const splitterPorts = Number.parseInt(ratio.split(":")[1] || "8", 10);
    const allocatedPorts =
      fibersData.splitter_output?.filter((s) => s.status === "allocated").length ?? 0;

    let maxLoss = 0;
    const budget = opticalBudgetMap?.get(closureId);
    if (budget) {
      for (const path of budget.paths) {
        if (path.cumulativeLoss > maxLoss) {
          maxLoss = path.cumulativeLoss;
        }
      }
    }

    closures.push({
      id: closureId,
      location: fibersData.location || "Unknown",
      splitterRatio: ratio,
      homesServed: allocatedPorts,
      maxLoss: Math.round(maxLoss * 100) / 100,
      portUtilization: {
        allocated: allocatedPorts,
        total: splitterPorts,
      },
      status: fibersData.status ?? "planned",
      coordinates: coordinatesMap?.get(closureId) ?? null,
    });
  }

  return {
    closures,
    updatedAt: new Date().toISOString(),
  };
}
