/**
 * DataStore Street Labels
 *
 * Adds street name labels to ASCII zone grids for spatial reference.
 * Street names are placed along road segments to help AI agents
 * understand the geographic context of the network.
 *
 * Key features:
 * - Extracts longest street segments for label placement
 * - Places horizontal labels along east-west roads
 * - Places vertical labels along north-south roads
 * - Avoids overwriting important grid elements
 */

import type { GridWithStreets, StreetLabel, ZoneBounds } from "../types/geocodebase";
import type { InfrastructureRoad } from "./zone-text-twin";
import { GRID_HEIGHT, GRID_WIDTH, SYMBOLS } from "./zone-text-twin";

// ============================================================================
// Types
// ============================================================================

interface RoadSegment {
  roadId: string;
  name: string;
  coordinates: [number, number][];
  orientation: "horizontal" | "vertical";
  lengthMeters: number;
  gridStart: [number, number];
  gridEnd: [number, number];
}

interface ProcessedRoad {
  name: string;
  segments: RoadSegment[];
  totalLength: number;
  dominantOrientation: "horizontal" | "vertical";
}

// ============================================================================
// Distance Calculation
// ============================================================================

/**
 * Calculate Haversine distance between two coordinates in meters
 */
function haversineDistanceLocal(coord1: [number, number], coord2: [number, number]): number {
  const R = 6371000; // Earth's radius in meters
  const lat1 = (coord1[1] * Math.PI) / 180;
  const lat2 = (coord2[1] * Math.PI) / 180;
  const dLat = ((coord2[1] - coord1[1]) * Math.PI) / 180;
  const dLon = ((coord2[0] - coord1[0]) * Math.PI) / 180;

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
}

// ============================================================================
// Main Functions
// ============================================================================

/**
 * Extract street labels from road data
 *
 * Analyzes road segments to find the best positions for street name labels.
 * Prioritizes longer, named streets and separates horizontal from vertical labels.
 *
 * @param roads - Array of infrastructure roads with coordinates
 * @param zoneBounds - Zone boundary coordinates
 * @returns Object with horizontal and vertical street labels
 */
export function extractStreetLabels(
  roads: InfrastructureRoad[],
  zoneBounds: ZoneBounds,
  gw: number = GRID_WIDTH,
  gh: number = GRID_HEIGHT,
): { horizontal: StreetLabel[]; vertical: StreetLabel[] } {
  const horizontal: StreetLabel[] = [];
  const vertical: StreetLabel[] = [];

  // Calculate conversion factors
  const cellWidth = (zoneBounds.maxLng - zoneBounds.minLng) / gw;
  const cellHeight = (zoneBounds.maxLat - zoneBounds.minLat) / gh;

  // Map coordinate to grid position (Y-axis inverted)
  const toGrid = (coord: [number, number]): [number, number] => {
    const x = Math.floor((coord[0] - zoneBounds.minLng) / cellWidth);
    const y = gh - 1 - Math.floor((coord[1] - zoneBounds.minLat) / cellHeight);
    return [Math.max(0, Math.min(gw - 1, x)), Math.max(0, Math.min(gh - 1, y))];
  };

  // Process roads and group by name
  const roadsByName = new Map<string, ProcessedRoad>();

  for (const road of roads) {
    // Skip unnamed roads
    if (!road.name) continue;

    const name = road.name.trim();
    if (!name) continue;

    // Process each segment of the road
    for (let i = 0; i < road.coordinates.length - 1; i++) {
      const start = road.coordinates[i];
      const end = road.coordinates[i + 1];

      // Calculate segment properties
      const lengthMeters = haversineDistanceLocal(start, end);
      const gridStart = toGrid(start);
      const gridEnd = toGrid(end);

      // Determine orientation (horizontal if dx > dy)
      const dx = Math.abs(gridEnd[0] - gridStart[0]);
      const dy = Math.abs(gridEnd[1] - gridStart[1]);
      const orientation = dx >= dy ? "horizontal" : "vertical";

      const segment: RoadSegment = {
        roadId: road.id,
        name,
        coordinates: [start, end],
        orientation,
        lengthMeters,
        gridStart,
        gridEnd,
      };

      // Add to road group
      if (!roadsByName.has(name)) {
        roadsByName.set(name, {
          name,
          segments: [],
          totalLength: 0,
          dominantOrientation: "horizontal",
        });
      }
      const processedRoad = roadsByName.get(name)!;
      processedRoad.segments.push(segment);
      processedRoad.totalLength += lengthMeters;
    }
  }

  // Calculate dominant orientation for each road
  for (const [_, processedRoad] of roadsByName) {
    let horizontalLength = 0;
    let verticalLength = 0;
    for (const seg of processedRoad.segments) {
      if (seg.orientation === "horizontal") {
        horizontalLength += seg.lengthMeters;
      } else {
        verticalLength += seg.lengthMeters;
      }
    }
    processedRoad.dominantOrientation =
      horizontalLength >= verticalLength ? "horizontal" : "vertical";
  }

  // Sort roads by total length (longest first)
  const sortedRoads = Array.from(roadsByName.values()).sort(
    (a, b) => b.totalLength - a.totalLength,
  );

  // Track which rows/cols already have labels to avoid overlap
  const usedRows = new Set<number>();
  const usedCols = new Set<number>();

  // Select best segments for labels
  for (const road of sortedRoads) {
    // Find the longest segment matching the road's dominant orientation
    const matchingSegments = road.segments.filter(
      (s) => s.orientation === road.dominantOrientation,
    );

    if (matchingSegments.length === 0) continue;

    // Sort by length and pick the longest
    matchingSegments.sort((a, b) => b.lengthMeters - a.lengthMeters);
    const bestSegment = matchingSegments[0];

    // Calculate label position (midpoint of segment)
    const midX = Math.floor((bestSegment.gridStart[0] + bestSegment.gridEnd[0]) / 2);
    const midY = Math.floor((bestSegment.gridStart[1] + bestSegment.gridEnd[1]) / 2);

    // Prepare label text (uppercase, brackets for clarity)
    const labelText = formatStreetName(road.name);
    const labelLength = labelText.length;

    if (road.dominantOrientation === "horizontal") {
      // Check if this row is already used
      if (usedRows.has(midY)) continue;

      // Calculate label position (centered on segment midpoint)
      const startX = Math.max(2, midX - Math.floor(labelLength / 2));
      const endX = startX + labelLength;

      // Ensure label fits in grid
      if (endX > gw - 2) continue;

      horizontal.push({
        name: labelText,
        position: [startX, midY],
        orientation: "horizontal",
        length: labelLength,
      });

      usedRows.add(midY);
    } else {
      // Vertical label
      // Check if this column is already used
      if (usedCols.has(midX)) continue;

      // For vertical labels, each character needs its own row
      const startY = Math.max(2, midY - Math.floor(labelLength / 2));
      const endY = startY + labelLength;

      // Ensure label fits in grid
      if (endY > gh - 2) continue;

      vertical.push({
        name: labelText,
        position: [midX, startY],
        orientation: "vertical",
        length: labelLength,
      });

      usedCols.add(midX);
    }
  }

  // Limit labels to avoid clutter (max 3 of each orientation)
  return {
    horizontal: horizontal.slice(0, 3),
    vertical: vertical.slice(0, 3),
  };
}

/**
 * Format street name for display in ASCII grid
 *
 * @param name - Raw street name
 * @returns Formatted name in brackets, uppercase
 */
function formatStreetName(name: string): string {
  // Remove common suffixes/prefixes to shorten
  let formatted = name
    .replace(/\s+Street$/i, " ST")
    .replace(/\s+Avenue$/i, " AVE")
    .replace(/\s+Boulevard$/i, " BLVD")
    .replace(/\s+Road$/i, " RD")
    .replace(/\s+Drive$/i, " DR")
    .replace(/\s+Lane$/i, " LN")
    .replace(/\s+Court$/i, " CT")
    .replace(/^רחוב\s+/i, "") // Hebrew "street" prefix
    .replace(/^שדרות\s+/i, "") // Hebrew "boulevard" prefix
    .trim()
    .toUpperCase();

  // Truncate long names
  if (formatted.length > 15) {
    formatted = formatted.substring(0, 15);
  }

  return `[${formatted}]`;
}

/**
 * Place a street label on the ASCII grid
 *
 * Places characters one-by-one, avoiding overwriting important elements.
 *
 * @param grid - 2D character array (will be modified)
 * @param label - Street label to place
 */
export function placeStreetLabel(
  grid: string[][],
  label: StreetLabel,
  gw: number = GRID_WIDTH,
  gh: number = GRID_HEIGHT,
): void {
  const [startX, startY] = label.position;
  const text = label.name;

  // Elements that can be overwritten for labels
  const overwritable = new Set([
    SYMBOLS.empty,
    SYMBOLS.road_h,
    SYMBOLS.road_v,
    SYMBOLS.road_cross,
    SYMBOLS.sidewalk,
    " ",
  ]);

  if (label.orientation === "horizontal") {
    // Place characters left-to-right
    for (let i = 0; i < text.length; i++) {
      const x = startX + i;
      const y = startY;

      // Check bounds
      if (x < 0 || x >= gw || y < 0 || y >= gh) continue;

      // Check if cell can be overwritten
      const currentCell = grid[y][x];
      if (overwritable.has(currentCell)) {
        grid[y][x] = text[i];
      }
    }
  } else {
    // Vertical: place characters top-to-bottom
    for (let i = 0; i < text.length; i++) {
      const x = startX;
      const y = startY + i;

      // Check bounds
      if (x < 0 || x >= gw || y < 0 || y >= gh) continue;

      // Check if cell can be overwritten
      const currentCell = grid[y][x];
      if (overwritable.has(currentCell)) {
        grid[y][x] = text[i];
      }
    }
  }
}

/**
 * Add street labels to an existing grid
 *
 * Main entry point: extracts street labels from road data and places them on the grid.
 *
 * @param grid - 2D character array (will be modified in place)
 * @param roads - Infrastructure road data
 * @param zoneBounds - Zone boundary coordinates
 * @returns Object with the modified grid and label information
 */
export function addStreetLabelsToGrid(
  grid: string[][],
  roads: InfrastructureRoad[],
  zoneBounds: ZoneBounds,
  gw: number = GRID_WIDTH,
  gh: number = GRID_HEIGHT,
): GridWithStreets {
  // Extract labels from road data
  const { horizontal, vertical } = extractStreetLabels(roads, zoneBounds, gw, gh);

  // Place all labels on the grid
  for (const label of horizontal) {
    placeStreetLabel(grid, label, gw, gh);
  }

  for (const label of vertical) {
    placeStreetLabel(grid, label, gw, gh);
  }

  // Convert grid to string
  const gridString = grid.map((row) => row.join("")).join("\n");

  return {
    grid: gridString,
    streetLabels: [...horizontal, ...vertical],
    horizontalStreets: horizontal,
    verticalStreets: vertical,
  };
}

/**
 * Create a grid header with zone info and street names
 *
 * Generates a formatted header for the ASCII grid with zone metadata.
 *
 * @param zoneId - Zone identifier (e.g., "A1")
 * @param zoneBounds - Zone boundary coordinates
 * @param streetLabels - Array of street labels placed on grid
 * @returns Formatted header string
 */
export function createGridHeader(
  zoneId: string,
  zoneBounds: ZoneBounds,
  streetLabels: StreetLabel[],
  gw: number = GRID_WIDTH,
): string {
  const centerLat = (zoneBounds.minLat + zoneBounds.maxLat) / 2;
  const centerLng = (zoneBounds.minLng + zoneBounds.maxLng) / 2;

  const streetNames = streetLabels.map((l) => l.name.replace(/^\[|\]$/g, "")).join(", ");

  const lines = [
    `╔${"═".repeat(gw - 2)}╗`,
    `║  ZONE ${zoneId} | Center: ${centerLng.toFixed(4)}, ${centerLat.toFixed(4)}`.padEnd(gw - 3) +
      " ║",
  ];

  if (streetNames) {
    lines.push(`${`║  Streets: ${streetNames}`.padEnd(gw - 3)} ║`);
  }

  lines.push(`╠${"═".repeat(gw - 2)}╣`);

  return lines.join("\n");
}

/**
 * Create a grid footer with legend
 *
 * @returns Formatted footer string
 */
export function createGridFooter(gw: number = GRID_WIDTH): string {
  const lines = [
    `╠${"═".repeat(gw - 2)}╣`,
    `${`║  Legend: [STREET NAME] = Street labels on roads`.padEnd(gw - 3)} ║`,
    `╚${"═".repeat(gw - 2)}╝`,
  ];

  return lines.join("\n");
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Get street names visible in a zone
 *
 * @param roads - Infrastructure road data
 * @param zoneBounds - Zone boundary coordinates
 * @returns Array of unique street names
 */
export function getStreetNamesInZone(
  roads: InfrastructureRoad[],
  zoneBounds: ZoneBounds,
): string[] {
  const names = new Set<string>();

  for (const road of roads) {
    if (!road.name) continue;

    // Check if any part of the road is within the zone
    for (const coord of road.coordinates) {
      const [lng, lat] = coord;
      if (
        lng >= zoneBounds.minLng &&
        lng <= zoneBounds.maxLng &&
        lat >= zoneBounds.minLat &&
        lat <= zoneBounds.maxLat
      ) {
        names.add(road.name.trim());
        break;
      }
    }
  }

  return Array.from(names).sort();
}

/**
 * Find the best position to annotate a street name
 *
 * Finds the longest visible segment of a street within a zone.
 *
 * @param streetName - Name of the street to find
 * @param roads - Infrastructure road data
 * @param zoneBounds - Zone boundary coordinates
 * @returns Best position and orientation for the label, or null
 */
export function findStreetAnnotationPosition(
  streetName: string,
  roads: InfrastructureRoad[],
  zoneBounds: ZoneBounds,
  gw: number = GRID_WIDTH,
  gh: number = GRID_HEIGHT,
): { position: [number, number]; orientation: "horizontal" | "vertical" } | null {
  const cellWidth = (zoneBounds.maxLng - zoneBounds.minLng) / gw;
  const cellHeight = (zoneBounds.maxLat - zoneBounds.minLat) / gh;

  const toGrid = (coord: [number, number]): [number, number] => {
    const x = Math.floor((coord[0] - zoneBounds.minLng) / cellWidth);
    const y = gh - 1 - Math.floor((coord[1] - zoneBounds.minLat) / cellHeight);
    return [Math.max(0, Math.min(gw - 1, x)), Math.max(0, Math.min(gh - 1, y))];
  };

  let bestSegment: {
    midpoint: [number, number];
    orientation: "horizontal" | "vertical";
    length: number;
  } | null = null;

  for (const road of roads) {
    if (road.name?.trim().toLowerCase() !== streetName.trim().toLowerCase()) continue;

    for (let i = 0; i < road.coordinates.length - 1; i++) {
      const start = road.coordinates[i];
      const end = road.coordinates[i + 1];

      // Check if segment is within zone
      const startInZone =
        start[0] >= zoneBounds.minLng &&
        start[0] <= zoneBounds.maxLng &&
        start[1] >= zoneBounds.minLat &&
        start[1] <= zoneBounds.maxLat;
      const endInZone =
        end[0] >= zoneBounds.minLng &&
        end[0] <= zoneBounds.maxLng &&
        end[1] >= zoneBounds.minLat &&
        end[1] <= zoneBounds.maxLat;

      if (!startInZone && !endInZone) continue;

      const length = haversineDistanceLocal(start, end);
      if (!bestSegment || length > bestSegment.length) {
        const gridStart = toGrid(start);
        const gridEnd = toGrid(end);
        const dx = Math.abs(gridEnd[0] - gridStart[0]);
        const dy = Math.abs(gridEnd[1] - gridStart[1]);

        bestSegment = {
          midpoint: [
            Math.floor((gridStart[0] + gridEnd[0]) / 2),
            Math.floor((gridStart[1] + gridEnd[1]) / 2),
          ],
          orientation: dx >= dy ? "horizontal" : "vertical",
          length,
        };
      }
    }
  }

  return bestSegment
    ? { position: bestSegment.midpoint, orientation: bestSegment.orientation }
    : null;
}
