/**
 * DataStore fibers.json - Source of Truth for Splice Data
 *
 * CRITICAL ARCHITECTURE:
 * fibers.json IS the canonical source for splice data at each closure.
 * ReactFlow FTTHDenNode reads FROM this data - it doesn't own splice state.
 *
 * Data Flow:
 * Network changes → generateDataStore()
 *     ↓
 * closures/{closure-id}/fibers.json (structured data) ← SOURCE OF TRUTH
 *     ↓
 * ReactFlow FTTHDenNode reads fibers.json → renders visual splice diagram
 *
 * Benefits:
 * 1. Single source of truth - no sync issues
 * 2. Agent-editable - AI modifies fibers.json, UI updates automatically
 * 3. Simpler ReactFlow - FTTHDenNode becomes pure renderer
 * 4. Field scenarios work - agent reroutes cable → updates DataStore → splice auto-updates
 */

import type {
  ClosureFibersData,
  FiberAllocation,
  NetworkCableInput,
  NetworkNodeInput,
  SplitterPortAssignment,
} from "../types/geocodebase";

// ============================================================================
// TIA-598 Color Standards
// ============================================================================

/**
 * TIA-598 standard fiber colors (1-12)
 */
export const TIA_598_COLORS: string[] = [
  "blue", // 1
  "orange", // 2
  "green", // 3
  "brown", // 4
  "slate", // 5
  "white", // 6
  "red", // 7
  "black", // 8
  "yellow", // 9
  "violet", // 10
  "rose", // 11
  "aqua", // 12
];

/**
 * Get TIA-598 color for a fiber number (1-12 cycle)
 */
export function getFiberColor(fiberNumber: number): string {
  const index = (fiberNumber - 1) % 12;
  return TIA_598_COLORS[index] || "blue";
}

// ============================================================================
// Main Generation Functions
// ============================================================================

/**
 * Generate fibers.json data for a closure
 *
 * @param closure - The closure node
 * @param incomingCable - The cable feeding this closure
 * @param connectedHomes - Houses connected via drop cables
 * @param downstreamClosures - Closures downstream (for pass-through fibers)
 * @param cables - All cables for path lookup
 * @param nodeById - Node lookup map
 */
export function generateClosureFibersJson(
  closure: NetworkNodeInput,
  incomingCable: NetworkCableInput | null,
  connectedHomes: NetworkNodeInput[],
  downstreamClosures: NetworkNodeInput[],
  cables: NetworkCableInput[],
  nodeById: Map<string, NetworkNodeInput>,
): ClosureFibersData {
  const splitterRatio = closure.splitterRatio || "1:8";
  const splitterCapacity = parseSplitterRatio(splitterRatio);

  // Build fiber allocation table
  const fiberAllocation: FiberAllocation[] = [];
  const splitterOutput: SplitterPortAssignment[] = [];

  // Calculate fiber needs
  const _homesCount = connectedHomes.length;
  const _downstreamFiberNeed = calculateDownstreamFiberNeed(downstreamClosures);

  // Initialize input cable info
  const inputCable = incomingCable
    ? {
        id: incomingCable.id,
        fiber_count: incomingCable.fiberCount || 12,
        from: incomingCable.source,
      }
    : {
        id: "none",
        fiber_count: 12,
        from: "unknown",
      };

  // Allocate fibers
  let currentFiber = 1;

  // 1. Splitter input fiber
  fiberAllocation.push({
    fiber: currentFiber,
    color: getFiberColor(currentFiber),
    usage: "splitter_input",
    destination: `splitter-${splitterRatio}`,
  });
  currentFiber++;

  // 2. Pass-through fibers for downstream closures
  const passThroughData: { to_closure: string; fiber_indices: number[] }[] = [];

  for (const downstream of downstreamClosures) {
    const downstreamFibers = downstream.totalFibers || 12;
    const fibersNeeded = Math.ceil(downstreamFibers / 12); // At least 1 fiber per downstream

    const fiberIndices: number[] = [];
    for (let i = 0; i < fibersNeeded && currentFiber <= inputCable.fiber_count; i++) {
      fiberAllocation.push({
        fiber: currentFiber,
        color: getFiberColor(currentFiber),
        usage: "pass_through",
        destination: downstream.id,
      });
      fiberIndices.push(currentFiber);
      currentFiber++;
    }

    if (fiberIndices.length > 0) {
      passThroughData.push({
        to_closure: downstream.id,
        fiber_indices: fiberIndices,
      });
    }
  }

  // 3. Reserve fibers (remaining)
  while (currentFiber <= inputCable.fiber_count) {
    fiberAllocation.push({
      fiber: currentFiber,
      color: getFiberColor(currentFiber),
      usage: "reserve",
    });
    currentFiber++;
  }

  // 4. Generate splitter output port assignments
  const dropCables = cables.filter(
    (c) =>
      c.source === closure.id &&
      (c.cableType === "drop" || !c.cableType) &&
      nodeById.get(c.target)?.type === "house",
  );

  for (let port = 1; port <= splitterCapacity; port++) {
    const dropCable = dropCables[port - 1];
    const home = dropCable ? nodeById.get(dropCable.target) : null;

    splitterOutput.push({
      port,
      address_id: home?.id || null,
      drop_cable: dropCable?.id || null,
      status: home ? "allocated" : "available",
      fiber_color: getFiberColor(port),
    });
  }

  return {
    closure_id: closure.id,
    location: closure.label || closure.id,
    splitter_ratio: splitterRatio,
    input_cable: inputCable,
    fiber_allocation: fiberAllocation,
    splitter_output: splitterOutput,
    pass_through: passThroughData.length > 0 ? passThroughData : undefined,
    updated_at: new Date().toISOString(),
  };
}

/**
 * Parse splitter ratio string to numeric capacity
 */
export function parseSplitterRatio(ratio: string): number {
  const match = ratio.match(/1:(\d+)/);
  return match ? parseInt(match[1], 10) : 8;
}

/**
 * Calculate total fiber need for downstream closures
 */
function calculateDownstreamFiberNeed(downstreamClosures: NetworkNodeInput[]): number {
  return downstreamClosures.reduce((sum, closure) => {
    const fibers = closure.totalFibers || 12;
    return sum + Math.ceil(fibers / 12); // 1 fiber per 12 downstream fibers
  }, 0);
}

// ============================================================================
// Fiber Allocation Helpers
// ============================================================================

/**
 * Get the number of available splitter ports
 */
export function getAvailablePorts(fibersData: ClosureFibersData): number {
  return fibersData.splitter_output.filter((p) => p.status === "available").length;
}

/**
 * Get the number of allocated splitter ports
 */
export function getAllocatedPorts(fibersData: ClosureFibersData): number {
  return fibersData.splitter_output.filter((p) => p.status === "allocated").length;
}

/**
 * Get fibers by usage type
 */
export function getFibersByUsage(
  fibersData: ClosureFibersData,
  usage: FiberAllocation["usage"],
): FiberAllocation[] {
  return fibersData.fiber_allocation.filter((f) => f.usage === usage);
}

/**
 * Find the next available splitter port
 */
export function getNextAvailablePort(fibersData: ClosureFibersData): number | null {
  const available = fibersData.splitter_output.find((p) => p.status === "available");
  return available?.port || null;
}

/**
 * Allocate a splitter port to a home
 */
export function allocatePort(
  fibersData: ClosureFibersData,
  port: number,
  addressId: string,
  dropCableId: string,
): ClosureFibersData {
  const updatedOutput = fibersData.splitter_output.map((p) =>
    p.port === port
      ? {
          ...p,
          address_id: addressId,
          drop_cable: dropCableId,
          status: "allocated" as const,
        }
      : p,
  );

  return {
    ...fibersData,
    splitter_output: updatedOutput,
    updated_at: new Date().toISOString(),
  };
}

/**
 * Release a splitter port (disconnect home)
 */
export function releasePort(fibersData: ClosureFibersData, port: number): ClosureFibersData {
  const updatedOutput = fibersData.splitter_output.map((p) =>
    p.port === port
      ? {
          ...p,
          address_id: null,
          drop_cable: null,
          status: "available" as const,
        }
      : p,
  );

  return {
    ...fibersData,
    splitter_output: updatedOutput,
    updated_at: new Date().toISOString(),
  };
}

// ============================================================================
// Pass-Through Fiber Management
// ============================================================================

/**
 * Add a pass-through fiber allocation
 */
export function addPassThroughFiber(
  fibersData: ClosureFibersData,
  fiberNumber: number,
  destinationClosureId: string,
): ClosureFibersData {
  // Update fiber allocation
  const updatedAllocation = fibersData.fiber_allocation.map((f) =>
    f.fiber === fiberNumber
      ? {
          ...f,
          usage: "pass_through" as const,
          destination: destinationClosureId,
        }
      : f,
  );

  // Update pass-through data
  const passThrough = [...(fibersData.pass_through || [])];
  const existingEntry = passThrough.find((p) => p.to_closure === destinationClosureId);

  if (existingEntry) {
    if (!existingEntry.fiber_indices.includes(fiberNumber)) {
      existingEntry.fiber_indices.push(fiberNumber);
    }
  } else {
    passThrough.push({
      to_closure: destinationClosureId,
      fiber_indices: [fiberNumber],
    });
  }

  return {
    ...fibersData,
    fiber_allocation: updatedAllocation,
    pass_through: passThrough,
    updated_at: new Date().toISOString(),
  };
}

/**
 * Remove a pass-through fiber allocation
 */
export function removePassThroughFiber(
  fibersData: ClosureFibersData,
  fiberNumber: number,
): ClosureFibersData {
  // Update fiber allocation to reserve
  const updatedAllocation = fibersData.fiber_allocation.map((f) =>
    f.fiber === fiberNumber
      ? {
          ...f,
          usage: "reserve" as const,
          destination: undefined,
        }
      : f,
  );

  // Update pass-through data
  const passThrough = (fibersData.pass_through || [])
    .map((p) => ({
      ...p,
      fiber_indices: p.fiber_indices.filter((idx) => idx !== fiberNumber),
    }))
    .filter((p) => p.fiber_indices.length > 0);

  return {
    ...fibersData,
    fiber_allocation: updatedAllocation,
    pass_through: passThrough.length > 0 ? passThrough : undefined,
    updated_at: new Date().toISOString(),
  };
}

// ============================================================================
// Conversion Functions
// ============================================================================

/**
 * Convert ClosureFibersData to FTTHDenNode-compatible splice config
 * This allows the existing ReactFlow component to render correctly
 */
export function toSpliceConfig(fibersData: ClosureFibersData): Array<{
  input: number;
  output: string | number;
  drop: string;
  loss: number;
  color: string;
}> {
  const spliceConfig: Array<{
    input: number;
    output: string | number;
    drop: string;
    loss: number;
    color: string;
  }> = [];

  // Build splice entries from fiber allocation and splitter output
  for (const port of fibersData.splitter_output) {
    if (port.status === "allocated" && port.address_id) {
      spliceConfig.push({
        input: 1, // Splitter input fiber
        output: port.port,
        drop: port.address_id,
        loss: calculatePortLoss(fibersData.splitter_ratio),
        color: port.fiber_color || getFiberColor(port.port),
      });
    }
  }

  return spliceConfig;
}

/**
 * Calculate optical loss for a splitter port
 */
function calculatePortLoss(splitterRatio: string): number {
  const SPLITTER_LOSS: Record<string, number> = {
    "1:2": 3.6,
    "1:4": 7.2,
    "1:8": 10.8,
    "1:16": 14.1,
    "1:32": 17.5,
  };
  return SPLITTER_LOSS[splitterRatio] || 10.8;
}

/**
 * Convert ClosureFibersData to splice color map
 */
export function toSpliceColorMap(fibersData: ClosureFibersData): Array<{
  dropNumber: number;
  inputColor: string;
  outputColor: string;
}> {
  return fibersData.splitter_output
    .filter((p) => p.status === "allocated")
    .map((p) => ({
      dropNumber: p.port,
      inputColor: getFiberColor(1), // Input fiber color
      outputColor: p.fiber_color || getFiberColor(p.port),
    }));
}

/**
 * Convert ClosureFibersData to splicedFibers array (port numbers that are in use)
 */
export function toSplicedFibers(fibersData: ClosureFibersData): number[] {
  return fibersData.splitter_output.filter((p) => p.status === "allocated").map((p) => p.port);
}

/**
 * Convert ClosureFibersData to passThroughFibers array
 */
export function toPassThroughFibers(fibersData: ClosureFibersData): number[] {
  return fibersData.fiber_allocation.filter((f) => f.usage === "pass_through").map((f) => f.fiber);
}

// ============================================================================
// Validation Functions
// ============================================================================

/**
 * Validate that fiber allocation is consistent
 */
export function validateFibersData(fibersData: ClosureFibersData): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  // Check that allocated ports have addresses
  for (const port of fibersData.splitter_output) {
    if (port.status === "allocated" && !port.address_id) {
      errors.push(`Port ${port.port} is allocated but has no address_id`);
    }
  }

  // Check that fiber numbers are unique
  const fiberNumbers = fibersData.fiber_allocation.map((f) => f.fiber);
  const uniqueFibers = new Set(fiberNumbers);
  if (uniqueFibers.size !== fiberNumbers.length) {
    errors.push("Duplicate fiber numbers in allocation");
  }

  // Check that port numbers are unique
  const portNumbers = fibersData.splitter_output.map((p) => p.port);
  const uniquePorts = new Set(portNumbers);
  if (uniquePorts.size !== portNumbers.length) {
    errors.push("Duplicate port numbers in splitter output");
  }

  // Check splitter capacity
  const splitterCapacity = parseSplitterRatio(fibersData.splitter_ratio);
  const allocatedCount = getAllocatedPorts(fibersData);
  if (allocatedCount > splitterCapacity) {
    errors.push(
      `Over capacity: ${allocatedCount} ports allocated, capacity is ${splitterCapacity}`,
    );
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Check if a home can be connected to this closure
 */
export function canConnectHome(fibersData: ClosureFibersData): boolean {
  return getAvailablePorts(fibersData) > 0;
}

/**
 * Get closure capacity summary
 */
export function getCapacitySummary(fibersData: ClosureFibersData): {
  splitterRatio: string;
  totalPorts: number;
  allocatedPorts: number;
  availablePorts: number;
  reservedPorts: number;
  utilizationPercent: number;
} {
  const totalPorts = parseSplitterRatio(fibersData.splitter_ratio);
  const allocatedPorts = getAllocatedPorts(fibersData);
  const availablePorts = getAvailablePorts(fibersData);
  const reservedPorts = fibersData.splitter_output.filter((p) => p.status === "reserved").length;

  return {
    splitterRatio: fibersData.splitter_ratio,
    totalPorts,
    allocatedPorts,
    availablePorts,
    reservedPorts,
    utilizationPercent: Math.round((allocatedPorts / totalPorts) * 100),
  };
}
