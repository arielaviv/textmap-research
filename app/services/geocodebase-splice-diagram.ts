/**
 * DataStore splice.txt ASCII Generation
 *
 * Generates ASCII splice diagrams from fibers.json data.
 * These diagrams are human-readable and agent-parseable representations
 * of splice configurations at each closure.
 *
 * Format is designed to be:
 * 1. Self-documenting - inline annotations explain everything
 * 2. TIA-598 compliant - fiber colors are explicit
 * 3. Agent-readable - structured for AI understanding
 * 4. Field-friendly - technicians can use for reference
 */

import type {
  ClosureFibersData,
  FiberAllocation,
  SpliceDiagramConfig,
  SplitterPortAssignment,
} from "../types/geocodebase";
import { getFiberColor, TIA_598_COLORS } from "./geocodebase-fibers";

// ============================================================================
// ASCII Art Constants
// ============================================================================

const BOX_CHARS = {
  topLeft: "╔",
  topRight: "╗",
  bottomLeft: "╚",
  bottomRight: "╝",
  horizontal: "═",
  vertical: "║",
  teeRight: "╠",
  teeLeft: "╣",
  cross: "╬",
} as const;

const LINE_WIDTH = 72;

// ============================================================================
// Main Generation Function
// ============================================================================

/**
 * Generate ASCII splice diagram for a closure
 *
 * @param config - Configuration with closure data
 * @returns ASCII art string representing the splice diagram
 */
export function generateClosureSpliceTxt(config: SpliceDiagramConfig): string {
  const { closureId, location, splitterRatio, fibersData, showColors, showPorts } = config;

  const lines: string[] = [];

  // Header
  lines.push(makeTopBorder());
  lines.push(makeHeaderLine(`${closureId} SPLICE DIAGRAM`));
  lines.push(makeHeaderLine(`Splitter: ${splitterRatio} | Location: ${location}`));
  lines.push(makeSeparator());

  // Input Cable Section
  lines.push(makeContentLine("INPUT CABLE"));
  lines.push(makeContentLine(`  ID: ${fibersData.input_cable.id}`));
  lines.push(makeContentLine(`  Fiber Count: ${fibersData.input_cable.fiber_count}F`));
  lines.push(makeContentLine(`  From: ${fibersData.input_cable.from}`));
  lines.push(makeEmptyLine());

  // Fiber Allocation Section
  lines.push(makeSeparator());
  lines.push(makeContentLine("FIBER ALLOCATION"));
  lines.push(makeEmptyLine());
  lines.push(...formatFiberAllocationTable(fibersData.fiber_allocation, showColors));
  lines.push(makeEmptyLine());

  // Splitter Section
  lines.push(makeSeparator());
  lines.push(makeContentLine(`SPLITTER ${splitterRatio}`));
  lines.push(makeEmptyLine());
  lines.push(...formatSplitterDiagram(fibersData, splitterRatio, showPorts));
  lines.push(makeEmptyLine());

  // Port Assignments Section
  lines.push(makeSeparator());
  lines.push(makeContentLine("PORT ASSIGNMENTS"));
  lines.push(makeEmptyLine());
  lines.push(...formatPortAssignments(fibersData.splitter_output));
  lines.push(makeEmptyLine());

  // Pass-Through Section (if any)
  if (fibersData.pass_through && fibersData.pass_through.length > 0) {
    lines.push(makeSeparator());
    lines.push(makeContentLine("PASS-THROUGH FIBERS"));
    lines.push(makeEmptyLine());
    lines.push(...formatPassThrough(fibersData.pass_through));
    lines.push(makeEmptyLine());
  }

  // Summary Statistics
  lines.push(makeSeparator());
  lines.push(...formatSummary(fibersData));

  // Footer
  lines.push(makeBottomBorder());
  lines.push("");
  lines.push(`Updated: ${fibersData.updated_at}`);

  return lines.join("\n");
}

// ============================================================================
// Box Drawing Helpers
// ============================================================================

function makeTopBorder(): string {
  return BOX_CHARS.topLeft + BOX_CHARS.horizontal.repeat(LINE_WIDTH - 2) + BOX_CHARS.topRight;
}

function makeBottomBorder(): string {
  return BOX_CHARS.bottomLeft + BOX_CHARS.horizontal.repeat(LINE_WIDTH - 2) + BOX_CHARS.bottomRight;
}

function makeSeparator(): string {
  return BOX_CHARS.teeRight + BOX_CHARS.horizontal.repeat(LINE_WIDTH - 2) + BOX_CHARS.teeLeft;
}

function makeHeaderLine(text: string): string {
  const padding = LINE_WIDTH - 4 - text.length;
  const leftPad = Math.floor(padding / 2);
  const rightPad = padding - leftPad;
  return (
    BOX_CHARS.vertical +
    " ".repeat(leftPad + 1) +
    text +
    " ".repeat(rightPad + 1) +
    BOX_CHARS.vertical
  );
}

function makeContentLine(text: string): string {
  const padding = LINE_WIDTH - 4 - text.length;
  return `${BOX_CHARS.vertical}  ${text}${" ".repeat(Math.max(0, padding))}${BOX_CHARS.vertical}`;
}

function makeEmptyLine(): string {
  return BOX_CHARS.vertical + " ".repeat(LINE_WIDTH - 2) + BOX_CHARS.vertical;
}

// ============================================================================
// Fiber Allocation Formatting
// ============================================================================

/**
 * Format fiber allocation as a table
 */
function formatFiberAllocationTable(allocations: FiberAllocation[], showColors: boolean): string[] {
  const lines: string[] = [];

  // Table header
  const header = showColors
    ? "  Fiber │ Color    │ Usage         │ Destination"
    : "  Fiber │ Usage         │ Destination";
  lines.push(makeContentLine(header));
  lines.push(
    makeContentLine(
      showColors
        ? "  ──────┼──────────┼───────────────┼───────────────"
        : "  ──────┼───────────────┼───────────────",
    ),
  );

  // Table rows
  for (const allocation of allocations) {
    const fiberNum = String(allocation.fiber).padStart(5);
    const colorStr = showColors ? `${allocation.color.padEnd(8)} │ ` : "";
    const usageStr = allocation.usage.padEnd(13);
    const destStr = allocation.destination || "—";

    const row = showColors
      ? `  ${fiberNum} │ ${colorStr}${usageStr} │ ${destStr}`
      : `  ${fiberNum} │ ${usageStr} │ ${destStr}`;

    lines.push(makeContentLine(row));
  }

  return lines;
}

// ============================================================================
// Splitter Diagram Formatting
// ============================================================================

/**
 * Format splitter as ASCII art
 */
function formatSplitterDiagram(
  fibersData: ClosureFibersData,
  splitterRatio: string,
  showPorts: boolean,
): string[] {
  const lines: string[] = [];
  const capacity = parseSplitterCapacity(splitterRatio);

  // Splitter visualization
  lines.push(makeContentLine("        ┌─────────────────────────────────────────┐"));
  lines.push(
    makeContentLine(`   ────▶│        ${splitterRatio.padEnd(6)} SPLITTER              │`),
  );
  lines.push(makeContentLine("        │                                         │"));

  // Show ports
  if (showPorts) {
    const portsPerRow = 8;
    const rows = Math.ceil(capacity / portsPerRow);

    for (let row = 0; row < rows; row++) {
      const startPort = row * portsPerRow + 1;
      const endPort = Math.min((row + 1) * portsPerRow, capacity);
      let portLine = "        │  ";

      for (let port = startPort; port <= endPort; port++) {
        const assignment = fibersData.splitter_output.find((p) => p.port === port);
        const status = assignment?.status === "allocated" ? "●" : "○";
        portLine += `${status} P${String(port).padStart(2)} `;
      }

      portLine = `${portLine.padEnd(LINE_WIDTH - 4)}│`;
      lines.push(makeContentLine(portLine.substring(2, LINE_WIDTH)));
    }
  }

  lines.push(makeContentLine("        │                                         │"));
  lines.push(makeContentLine("        └─────────────────────────────────────────┘"));

  // Legend
  lines.push(makeEmptyLine());
  lines.push(makeContentLine("  Legend: ● Allocated  ○ Available"));

  return lines;
}

/**
 * Parse splitter ratio to numeric capacity
 */
function parseSplitterCapacity(ratio: string): number {
  const match = ratio.match(/1:(\d+)/);
  return match ? parseInt(match[1], 10) : 8;
}

// ============================================================================
// Port Assignment Formatting
// ============================================================================

/**
 * Format port assignments as a list
 */
function formatPortAssignments(ports: SplitterPortAssignment[]): string[] {
  const lines: string[] = [];

  // Group by status
  const allocated = ports.filter((p) => p.status === "allocated");
  const available = ports.filter((p) => p.status === "available");
  const reserved = ports.filter((p) => p.status === "reserved");

  // Allocated ports
  if (allocated.length > 0) {
    lines.push(makeContentLine("  ALLOCATED:"));
    for (const port of allocated) {
      const colorName = port.fiber_color || getFiberColor(port.port);
      const line = `    Port ${String(port.port).padStart(2)} [${colorName.padEnd(6)}] → ${port.address_id || "—"}`;
      lines.push(makeContentLine(line));
    }
    lines.push(makeEmptyLine());
  }

  // Available ports (summary)
  if (available.length > 0) {
    const portNumbers = available.map((p) => p.port).join(", ");
    lines.push(makeContentLine(`  AVAILABLE: Ports ${portNumbers}`));
    lines.push(makeEmptyLine());
  }

  // Reserved ports
  if (reserved.length > 0) {
    const portNumbers = reserved.map((p) => p.port).join(", ");
    lines.push(makeContentLine(`  RESERVED: Ports ${portNumbers}`));
  }

  return lines;
}

// ============================================================================
// Pass-Through Formatting
// ============================================================================

/**
 * Format pass-through fibers
 */
function formatPassThrough(
  passThrough: { to_closure: string; fiber_indices: number[] }[],
): string[] {
  const lines: string[] = [];

  for (const entry of passThrough) {
    const fibers = entry.fiber_indices.join(", ");
    lines.push(makeContentLine(`  → ${entry.to_closure}`));
    lines.push(makeContentLine(`    Fibers: ${fibers}`));
    lines.push(makeEmptyLine());
  }

  return lines;
}

// ============================================================================
// Summary Statistics
// ============================================================================

/**
 * Format summary statistics
 */
function formatSummary(fibersData: ClosureFibersData): string[] {
  const lines: string[] = [];

  const totalPorts = parseSplitterCapacity(fibersData.splitter_ratio);
  const allocatedPorts = fibersData.splitter_output.filter((p) => p.status === "allocated").length;
  const availablePorts = fibersData.splitter_output.filter((p) => p.status === "available").length;

  const utilizationPercent = Math.round((allocatedPorts / totalPorts) * 100);

  // Fiber counts
  const splitterInputFibers = fibersData.fiber_allocation.filter(
    (f) => f.usage === "splitter_input",
  ).length;
  const passThroughFibers = fibersData.fiber_allocation.filter(
    (f) => f.usage === "pass_through",
  ).length;
  const reserveFibers = fibersData.fiber_allocation.filter((f) => f.usage === "reserve").length;

  lines.push(makeContentLine("SUMMARY"));
  lines.push(makeEmptyLine());
  lines.push(makeContentLine(`  Splitter Capacity:  ${totalPorts} ports`));
  lines.push(
    makeContentLine(`  Allocated:          ${allocatedPorts} ports (${utilizationPercent}%)`),
  );
  lines.push(makeContentLine(`  Available:          ${availablePorts} ports`));
  lines.push(makeEmptyLine());
  lines.push(makeContentLine(`  Input Fibers:       ${fibersData.input_cable.fiber_count}F`));
  lines.push(makeContentLine(`  Splitter Input:     ${splitterInputFibers}F`));
  lines.push(makeContentLine(`  Pass-Through:       ${passThroughFibers}F`));
  lines.push(makeContentLine(`  Reserve:            ${reserveFibers}F`));

  return lines;
}

// ============================================================================
// Compact Splice Diagram (for inline display)
// ============================================================================

/**
 * Generate a compact single-line splice summary
 */
export function generateCompactSpliceSummary(fibersData: ClosureFibersData): string {
  const totalPorts = parseSplitterCapacity(fibersData.splitter_ratio);
  const allocated = fibersData.splitter_output.filter((p) => p.status === "allocated").length;

  return `[${fibersData.closure_id}] ${fibersData.splitter_ratio} | ${allocated}/${totalPorts} ports | ${fibersData.input_cable.fiber_count}F in`;
}

/**
 * Generate a mini ASCII splice diagram (for zone grid integration)
 */
export function generateMiniSpliceDiagram(fibersData: ClosureFibersData): string {
  const capacity = parseSplitterCapacity(fibersData.splitter_ratio);
  const lines: string[] = [];

  // Compact header
  lines.push(`●[${fibersData.closure_id}:${fibersData.splitter_ratio}]`);

  // Fiber input indicator
  lines.push(`│ ${fibersData.input_cable.fiber_count}F ─▶`);

  // Port status as dots
  let portLine = "│ ";
  for (let i = 1; i <= capacity; i++) {
    const port = fibersData.splitter_output.find((p) => p.port === i);
    portLine += port?.status === "allocated" ? "●" : "○";
  }
  lines.push(portLine);

  return lines.join("\n");
}

// ============================================================================
// TIA-598 Color Reference
// ============================================================================

/**
 * Generate TIA-598 color reference chart
 */
export function generateTIA598ColorChart(): string {
  const lines: string[] = [];

  lines.push("TIA-598-D FIBER COLOR STANDARD");
  lines.push("════════════════════════════════");
  lines.push("");
  lines.push("Position │ Color   │ Code │ Hex");
  lines.push("─────────┼─────────┼──────┼────────");

  const colorCodes: Record<string, string> = {
    blue: "BL",
    orange: "OR",
    green: "GR",
    brown: "BR",
    slate: "SL",
    white: "WH",
    red: "RD",
    black: "BK",
    yellow: "YL",
    violet: "VI",
    rose: "RS",
    aqua: "AQ",
  };

  const colorHex: Record<string, string> = {
    blue: "#0000FF",
    orange: "#FF8000",
    green: "#00FF00",
    brown: "#8B4513",
    slate: "#708090",
    white: "#FFFFFF",
    red: "#FF0000",
    black: "#000000",
    yellow: "#FFFF00",
    violet: "#EE82EE",
    rose: "#FF007F",
    aqua: "#00FFFF",
  };

  for (let i = 0; i < TIA_598_COLORS.length; i++) {
    const color = TIA_598_COLORS[i];
    const pos = String(i + 1).padStart(8);
    const colorName = color.padEnd(7);
    const code = (colorCodes[color] || "??").padEnd(4);
    const hex = colorHex[color] || "#??????";
    lines.push(`${pos} │ ${colorName} │ ${code} │ ${hex}`);
  }

  lines.push("");
  lines.push("Note: Colors repeat for fiber positions 13-24, 25-36, etc.");

  return lines.join("\n");
}

// ============================================================================
// Splice Diagram Validation
// ============================================================================

/**
 * Validate splice diagram is complete and consistent
 */
export function validateSpliceDiagram(fibersData: ClosureFibersData): {
  valid: boolean;
  errors: string[];
  warnings: string[];
} {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Check fiber allocation covers all input fibers
  const allocatedFiberCount = fibersData.fiber_allocation.length;
  if (allocatedFiberCount !== fibersData.input_cable.fiber_count) {
    errors.push(
      `Fiber count mismatch: ${allocatedFiberCount} allocated vs ${fibersData.input_cable.fiber_count} in cable`,
    );
  }

  // Check splitter output count matches ratio
  const expectedPorts = parseSplitterCapacity(fibersData.splitter_ratio);
  if (fibersData.splitter_output.length !== expectedPorts) {
    errors.push(
      `Splitter port count mismatch: ${fibersData.splitter_output.length} vs expected ${expectedPorts}`,
    );
  }

  // Check for duplicate fiber numbers
  const fiberNumbers = fibersData.fiber_allocation.map((f) => f.fiber);
  const uniqueFibers = new Set(fiberNumbers);
  if (uniqueFibers.size !== fiberNumbers.length) {
    errors.push("Duplicate fiber numbers in allocation");
  }

  // Check for orphaned allocated ports (no address)
  const orphanedPorts = fibersData.splitter_output.filter(
    (p) => p.status === "allocated" && !p.address_id,
  );
  if (orphanedPorts.length > 0) {
    warnings.push(`${orphanedPorts.length} allocated ports have no address assigned`);
  }

  // Check for unassigned allocated fibers
  const splitterInputCount = fibersData.fiber_allocation.filter(
    (f) => f.usage === "splitter_input",
  ).length;
  if (splitterInputCount === 0) {
    warnings.push("No fibers allocated to splitter input");
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

// ============================================================================
// Export Functions
// ============================================================================

/**
 * Generate splice diagram for all closures in a zone
 */
export function generateZoneSpliceDiagrams(
  closureFibersMap: Map<string, ClosureFibersData>,
  showColors: boolean = true,
  showPorts: boolean = true,
): Map<string, string> {
  const diagrams = new Map<string, string>();

  for (const [closureId, fibersData] of closureFibersMap) {
    const config: SpliceDiagramConfig = {
      closureId,
      location: fibersData.location,
      splitterRatio: fibersData.splitter_ratio,
      fibersData,
      showColors,
      showPorts,
    };

    diagrams.set(closureId, generateClosureSpliceTxt(config));
  }

  return diagrams;
}

/**
 * Generate consolidated splice document for all closures
 */
export function generateConsolidatedSpliceDocument(
  closureFibersMap: Map<string, ClosureFibersData>,
  projectName: string,
): string {
  const lines: string[] = [];

  // Document header
  lines.push("╔══════════════════════════════════════════════════════════════════════════════╗");
  lines.push(`║  SPLICE SCHEDULE: ${projectName.padEnd(57)}║`);
  lines.push(`║  Generated: ${new Date().toISOString().padEnd(62)}║`);
  lines.push(`║  Total Closures: ${String(closureFibersMap.size).padEnd(57)}║`);
  lines.push("╚══════════════════════════════════════════════════════════════════════════════╝");
  lines.push("");
  lines.push("");

  // Individual closure diagrams
  for (const [closureId, fibersData] of closureFibersMap) {
    const config: SpliceDiagramConfig = {
      closureId,
      location: fibersData.location,
      splitterRatio: fibersData.splitter_ratio,
      fibersData,
      showColors: true,
      showPorts: true,
    };

    lines.push(generateClosureSpliceTxt(config));
    lines.push("");
    lines.push("─".repeat(80));
    lines.push("");
  }

  // TIA-598 reference
  lines.push("");
  lines.push(generateTIA598ColorChart());

  return lines.join("\n");
}
