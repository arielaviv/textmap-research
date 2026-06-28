/**
 * Text Twin Optical Budget Utilities
 *
 * Provides optical budget calculation and visualization for FTTH networks.
 * Used by the Text Twin system to show dB loss inline on paths.
 */

import type {
  CableTier,
  OpticalBudgetBreakdown,
  OpticalStatus,
  TopologyChain,
  TopologyNode,
} from "../types/text-twin-enhanced";
import { OPTICAL_BUDGET_CONSTANTS } from "../types/text-twin-enhanced";

// ============================================================================
// Types
// ============================================================================

/**
 * Network node for optical calculations
 */
interface OpticalNetworkNode {
  id: string;
  type: string;
  label?: string;
  position: [number, number];
  splitterRatio?: string;
}

/**
 * Network cable for optical calculations
 */
interface OpticalNetworkCable {
  id: string;
  source: string;
  target: string;
  length: number; // meters
  cableType?: CableTier;
  pathType?: "underground" | "aerial" | "conduit" | "aerial_span";
}

// ============================================================================
// Optical Budget Calculation
// ============================================================================

/**
 * Calculate optical loss for a cable segment
 * @param lengthMeters Cable length in meters
 * @returns Fiber loss in dB
 */
export function calculateFiberLoss(lengthMeters: number): number {
  const lengthKm = lengthMeters / 1000;
  return lengthKm * OPTICAL_BUDGET_CONSTANTS.fiberLossPerKm;
}

/**
 * Get splitter loss for a given ratio
 * @param ratio Splitter ratio string (e.g., "1:8", "1:16")
 * @returns Splitter loss in dB
 */
export function getSplitterLoss(ratio: string | undefined): number {
  if (!ratio) return 0;

  // Handle both "1:8" and "8" formats
  const cleanRatio = ratio.includes(":") ? ratio : `1:${ratio}`;
  return OPTICAL_BUDGET_CONSTANTS.splitterLoss[cleanRatio] ?? 0;
}

/**
 * Determine optical status based on total loss
 */
export function getOpticalStatus(totalLoss: number): OpticalStatus {
  if (totalLoss >= OPTICAL_BUDGET_CONSTANTS.criticalThreshold) {
    return "critical";
  }
  if (totalLoss >= OPTICAL_BUDGET_CONSTANTS.warningThreshold) {
    return "warning";
  }
  return "ok";
}

/**
 * Calculate full optical budget breakdown for a path
 * @param path Array of node IDs from CO to destination
 * @param nodeById Map of nodes by ID
 * @param cables Array of all cables
 * @returns Optical budget breakdown
 */
export function calculatePathOpticalLoss(
  path: string[],
  nodeById: Map<string, OpticalNetworkNode>,
  cables: OpticalNetworkCable[],
): OpticalBudgetBreakdown {
  const destNodeId = path[path.length - 1];
  let fiberLoss = 0;
  let splitterLoss = 0;
  let connectorLoss = 0;
  let spliceLoss = 0;

  // Calculate fiber loss based on cable lengths
  for (let i = 0; i < path.length - 1; i++) {
    const cable = cables.find(
      (c) =>
        (c.source === path[i] && c.target === path[i + 1]) ||
        (c.target === path[i] && c.source === path[i + 1]),
    );
    if (cable?.length) {
      fiberLoss += calculateFiberLoss(cable.length);
    }

    // Add connector loss at each junction
    connectorLoss += OPTICAL_BUDGET_CONSTANTS.connectorLoss;
  }

  // Calculate splitter loss
  for (const nodeId of path) {
    const node = nodeById.get(nodeId);
    if (node?.splitterRatio) {
      splitterLoss += getSplitterLoss(node.splitterRatio);
      // Add splice loss at each splitter
      spliceLoss += OPTICAL_BUDGET_CONSTANTS.spliceLoss;
    }
  }

  const contingency = OPTICAL_BUDGET_CONSTANTS.contingency;
  const totalLoss = fiberLoss + splitterLoss + connectorLoss + spliceLoss + contingency;
  const margin = OPTICAL_BUDGET_CONSTANTS.maxBudget - totalLoss;
  const status = getOpticalStatus(totalLoss);

  return {
    nodeId: destNodeId,
    pathToNode: path,
    totalLoss: Math.round(totalLoss * 10) / 10,
    fiberLoss: Math.round(fiberLoss * 10) / 10,
    splitterLoss: Math.round(splitterLoss * 10) / 10,
    connectorLoss: Math.round(connectorLoss * 10) / 10,
    spliceLoss: Math.round(spliceLoss * 10) / 10,
    contingency,
    status,
    margin: Math.round(margin * 10) / 10,
    isCompliant: totalLoss <= OPTICAL_BUDGET_CONSTANTS.maxBudget,
  };
}

/**
 * Format optical loss for inline display
 * @param loss Loss in dB
 * @returns Formatted string like "2.1dB"
 */
export function formatOpticalLoss(loss: number): string {
  return `${loss.toFixed(1)}dB`;
}

/**
 * Format optical annotation for inline grid display
 * Shows loss at a node with status indicator
 * @param loss Loss in dB
 * @param showStatus Whether to show status symbol
 * @returns Formatted string like "+10.8dB ✓" or "27.3dB ⚠"
 */
export function formatOpticalAnnotation(loss: number, showStatus = true): string {
  const formatted = formatOpticalLoss(loss);
  if (!showStatus) return formatted;

  const status = getOpticalStatus(loss);
  const symbol = status === "ok" ? "✓" : status === "warning" ? "⚠" : "✗";
  return `${formatted} ${symbol}`;
}

/**
 * Format a complete path with optical budget
 * Example output:
 * ★[OLT] ══[2.1dB]══ ◆[CAB-01] ──[4.2dB]── ●[CL-03:+10.8dB] ··[1.2dB]·· ○[H-07]
 *                                                              Total: 18.3dB ✓
 */
export function formatPathWithOpticalBudget(
  chain: TopologyChain,
  symbols: Record<string, string> = {},
): string {
  const defaultSymbols: Record<string, string> = {
    co: "★",
    cabinet: "◆",
    "cabinet-t3": "◇",
    closure: "●",
    den: "●",
    house: "○",
    pole: "│",
  };

  const sym = { ...defaultSymbols, ...symbols };
  const lines: string[] = [];
  let pathLine = "";

  for (let i = 0; i < chain.path.length; i++) {
    const node = chain.path[i];
    const nodeSymbol = sym[node.nodeType] || "?";
    const label = node.label || node.nodeId;

    // Add node representation
    if (node.splitterRatio) {
      pathLine += `${nodeSymbol}[${label}:${node.splitterRatio}]`;
    } else {
      pathLine += `${nodeSymbol}[${label}]`;
    }

    // Add cable to next node
    if (node.cableToNext) {
      const cableSymbol =
        node.cableToNext.tier === "feeder"
          ? "══"
          : node.cableToNext.tier === "distribution"
            ? "──"
            : "··";
      const cableLoss = calculateFiberLoss(node.cableToNext.length);
      pathLine += ` ${cableSymbol}[${formatOpticalLoss(cableLoss)}]${cableSymbol} `;
    }
  }

  lines.push(pathLine);

  // Add total line
  const statusSymbol = chain.isValid ? "✓" : "✗";
  const totalLine = `${"".padStart(pathLine.length - 30)}Total: ${formatOpticalLoss(chain.totalOpticalLoss)} ${statusSymbol}`;
  lines.push(totalLine);

  return lines.join("\n");
}

// ============================================================================
// Optical Budget Validation
// ============================================================================

/**
 * Validate optical budget for all paths in a network
 */
export function validateOpticalBudgets(
  homes: OpticalNetworkNode[],
  nodeById: Map<string, OpticalNetworkNode>,
  cables: OpticalNetworkCable[],
  findPathToCO: (homeId: string) => string[] | null,
): {
  compliant: OpticalBudgetBreakdown[];
  violations: OpticalBudgetBreakdown[];
  summary: {
    totalHomes: number;
    compliantHomes: number;
    maxLoss: number;
    avgLoss: number;
    criticalCount: number;
    warningCount: number;
  };
} {
  const compliant: OpticalBudgetBreakdown[] = [];
  const violations: OpticalBudgetBreakdown[] = [];
  const losses: number[] = [];

  for (const home of homes) {
    const path = findPathToCO(home.id);
    if (!path) {
      violations.push({
        nodeId: home.id,
        pathToNode: [],
        totalLoss: Infinity,
        fiberLoss: 0,
        splitterLoss: 0,
        connectorLoss: 0,
        spliceLoss: 0,
        contingency: 0,
        status: "critical",
        margin: -Infinity,
        isCompliant: false,
      });
      continue;
    }

    const budget = calculatePathOpticalLoss(path, nodeById, cables);
    losses.push(budget.totalLoss);

    if (budget.isCompliant) {
      compliant.push(budget);
    } else {
      violations.push(budget);
    }
  }

  const avgLoss = losses.length > 0 ? losses.reduce((a, b) => a + b, 0) / losses.length : 0;
  const maxLoss = losses.length > 0 ? Math.max(...losses) : 0;

  return {
    compliant,
    violations,
    summary: {
      totalHomes: homes.length,
      compliantHomes: compliant.length,
      maxLoss: Math.round(maxLoss * 10) / 10,
      avgLoss: Math.round(avgLoss * 10) / 10,
      criticalCount: violations.filter((v) => v.status === "critical").length,
      warningCount: compliant.filter((c) => c.status === "warning").length,
    },
  };
}

// ============================================================================
// Topology Chain Building
// ============================================================================

/**
 * Build a topology chain from CO to a specific home
 */
export function buildTopologyChain(
  homeId: string,
  nodeById: Map<string, OpticalNetworkNode>,
  cables: OpticalNetworkCable[],
  findPathToCO: (homeId: string) => string[] | null,
): TopologyChain | null {
  const path = findPathToCO(homeId);
  if (!path) return null;

  const home = nodeById.get(homeId);
  const topologyNodes: TopologyNode[] = [];
  let cumulativeLoss = 0;
  let cascadeDepth = 0;

  for (let i = 0; i < path.length; i++) {
    const nodeId = path[i];
    const node = nodeById.get(nodeId);
    if (!node) continue;

    // Calculate loss at this node
    if (node.splitterRatio) {
      cumulativeLoss += getSplitterLoss(node.splitterRatio);
      cascadeDepth++;
    }

    // Find cable to next node
    let cableToNext: TopologyNode["cableToNext"];
    if (i < path.length - 1) {
      const nextNodeId = path[i + 1];
      const cable = cables.find(
        (c) =>
          (c.source === nodeId && c.target === nextNodeId) ||
          (c.target === nodeId && c.source === nextNodeId),
      );
      if (cable) {
        const cableLoss = calculateFiberLoss(cable.length);
        cumulativeLoss += cableLoss;
        cableToNext = {
          cableId: cable.id,
          length: cable.length,
          tier: cable.cableType || "distribution",
          pathType: cable.pathType || "underground",
        };
      }
    }

    topologyNodes.push({
      nodeId: node.id,
      nodeType: node.type as TopologyNode["nodeType"],
      label: node.label,
      position: node.position,
      splitterRatio: node.splitterRatio,
      opticalLossAtNode: Math.round(cumulativeLoss * 10) / 10,
      cableToNext,
    });
  }

  // Add contingency
  const totalLoss = cumulativeLoss + OPTICAL_BUDGET_CONSTANTS.contingency;
  const issues: string[] = [];

  if (totalLoss > OPTICAL_BUDGET_CONSTANTS.maxBudget) {
    issues.push(
      `Optical budget exceeded: ${formatOpticalLoss(totalLoss)} > ${OPTICAL_BUDGET_CONSTANTS.maxBudget}dB`,
    );
  }

  if (cascadeDepth > 2) {
    issues.push(`Cascade depth exceeded: ${cascadeDepth} > 2 levels`);
  }

  return {
    homeId,
    homeAddress: home?.label,
    path: topologyNodes.reverse(), // Reverse to show CO first
    totalOpticalLoss: Math.round(totalLoss * 10) / 10,
    cascadeDepth,
    isValid: issues.length === 0,
    issues,
  };
}

// ============================================================================
// Optical Budget Display Helpers
// ============================================================================

/**
 * Generate optical budget summary for display in Text Twin
 */
export function generateOpticalBudgetSummary(budgets: OpticalBudgetBreakdown[]): string {
  if (budgets.length === 0) return "No optical paths to analyze.";

  const maxLoss = Math.max(...budgets.map((b) => b.totalLoss));
  const avgLoss = budgets.reduce((a, b) => a + b.totalLoss, 0) / budgets.length;
  const compliant = budgets.filter((b) => b.isCompliant).length;
  const critical = budgets.filter((b) => b.status === "critical").length;
  const warning = budgets.filter((b) => b.status === "warning").length;

  const lines: string[] = [];
  lines.push(`║  OPTICAL BUDGET SUMMARY:`);
  lines.push(
    `║  ✓ Compliant paths: ${compliant}/${budgets.length} (${((compliant / budgets.length) * 100).toFixed(0)}%)`,
  );
  lines.push(
    `║  ✓ Max optical loss: ${formatOpticalLoss(maxLoss)} (limit ${OPTICAL_BUDGET_CONSTANTS.maxBudget}dB)`,
  );
  lines.push(`║  ✓ Avg optical loss: ${formatOpticalLoss(avgLoss)}`);

  if (warning > 0) {
    lines.push(`║  ⚠ Warning (>${OPTICAL_BUDGET_CONSTANTS.warningThreshold}dB): ${warning} paths`);
  }
  if (critical > 0) {
    lines.push(
      `║  ✗ Critical (>${OPTICAL_BUDGET_CONSTANTS.criticalThreshold}dB): ${critical} paths`,
    );
  }

  return lines.join("\n");
}

/**
 * Generate optical loss annotation for a cable in the ASCII grid
 * @param cable The cable to annotate
 * @returns Annotation string like "[2.1dB]"
 */
export function generateCableOpticalAnnotation(cable: OpticalNetworkCable): string {
  const loss = calculateFiberLoss(cable.length);
  return `[${formatOpticalLoss(loss)}]`;
}

/**
 * Generate cumulative optical loss annotation for a node
 * @param cumulativeLoss Total loss from CO to this node
 * @returns Annotation string like "+18.3dB ✓"
 */
export function generateNodeOpticalAnnotation(cumulativeLoss: number): string {
  const status = getOpticalStatus(cumulativeLoss);
  const symbol = status === "ok" ? "✓" : status === "warning" ? "⚠" : "✗";
  return `+${formatOpticalLoss(cumulativeLoss)} ${symbol}`;
}
