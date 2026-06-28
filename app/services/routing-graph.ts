/**
 * Canonical Routing Graph Service
 *
 * This is the SINGLE SOURCE OF TRUTH for:
 * - Where equipment CAN be placed (graph nodes)
 * - Where cables CAN be routed (graph edges)
 *
 * All routing decisions MUST use this graph. No direct point-to-point connections allowed.
 *
 * Key guarantees:
 * 1. Every node is on a valid street or infrastructure element
 * 2. Every edge follows a valid path (no building crossings)
 * 3. The graph is fully connected (single component)
 * 4. Consistent 5-decimal precision (~1.1m) for node IDs
 */

import * as turf from "@turf/turf";
import type { Position } from "geojson";

// =============================================================================
// INTERFACES
// =============================================================================

/**
 * A node in the routing graph where equipment can be placed
 */
export interface RoutingNode {
  id: string; // Unique, based on snapped coordinates (5-decimal precision)
  position: [number, number]; // [lng, lat]
  type: "street" | "intersection" | "pole" | "handhole" | "conduit_access";
  streetName?: string; // For debugging/display
  streetIds?: string[]; // IDs of streets this node belongs to
  /** Which side of the street this node is on (for sidewalk nodes) */
  streetSide?: "left" | "right";
  /** The original road centerline position (before sidewalk offset) */
  centerlinePosition?: [number, number];
}

/**
 * An edge in the routing graph representing a valid cable path
 */
export interface RoutingEdge {
  id: string; // Unique edge identifier
  fromNodeId: string;
  toNodeId: string;
  distance: number; // meters
  geometry: Position[]; // Full path geometry for visualization
  pathType: "sidewalk" | "road_crossing" | "aerial_span" | "conduit";
  streetName?: string;
  /** Which side of the street this edge is on (for sidewalk edges) */
  streetSide?: "left" | "right";
  /** Cost multipliers for different deployment types */
  costs: {
    /** Cost in meters-equivalent for underground deployment */
    underground: number;
    /** Cost in meters-equivalent for aerial deployment */
    aerial: number;
  };
}

/** Adjacency entry for graph traversal */
export interface AdjacencyEntry {
  nodeId: string;
  edgeId: string;
  distance: number;
  /** Underground deployment cost */
  undergroundCost: number;
  /** Aerial deployment cost */
  aerialCost: number;
}

/**
 * The complete routing graph
 */
export interface RoutingGraph {
  nodes: Map<string, RoutingNode>;
  edges: Map<string, RoutingEdge>;
  adjacency: Map<string, AdjacencyEntry[]>;
  metadata: {
    createdAt: Date;
    nodeCount: number;
    edgeCount: number;
    componentCount: number;
    totalStreetLength: number;
    boundingBox: [number, number, number, number]; // [minLng, minLat, maxLng, maxLat]
    /** Whether the graph uses sidewalk-offset nodes */
    useSidewalkOffset: boolean;
    /** Service area polygon (if provided) */
    serviceAreaBuffer?: Position[];
  };
}

/**
 * Input street segment for graph construction
 */
export interface StreetSegment {
  id: string;
  name?: string;
  geometry: Position[]; // Array of [lng, lat] coordinates
  highway?: string; // OSM highway type
}

/**
 * Building polygon for crossing validation
 */
export interface BuildingPolygon {
  id: string;
  geometry: Position[][]; // Polygon coordinates (outer ring, optional holes)
}

/**
 * Existing infrastructure for brownfield overlay
 */
export interface ExistingInfrastructure {
  poles?: Array<{ id: string; position: [number, number] }>;
  handholes?: Array<{ id: string; position: [number, number] }>;
  conduits?: Array<{ id: string; geometry: Position[] }>;
  aerialSpans?: Array<{ id: string; geometry: Position[] }>;
}

/**
 * Configuration options for graph construction
 */
export interface RoutingGraphConfig {
  /** Node sampling interval along streets (meters). Default: 12 */
  samplingInterval: number;
  /** Threshold for merging nearby nodes (meters). Default: 5 */
  mergeThreshold: number;
  /** Coordinate precision (decimal places). Default: 5 (~1.1m) */
  coordinatePrecision: number;
  /** Maximum distance for bridge edges between components (meters). Default: 100 */
  maxBridgeDistance: number;
  /** Whether to log detailed progress. Default: true */
  verbose: boolean;
  /** Sidewalk offset distance from road centerline (meters). Default: 4 */
  sidewalkOffset: number;
  /** Buffer distance beyond service area polygon (meters). Default: 50 */
  serviceAreaBuffer: number;
  /** Whether to create dual-sidewalk nodes (both sides of street). Default: true */
  dualSidewalk: boolean;
  /** Cost multiplier for road crossing edges. Default: 3.0 */
  roadCrossingCostMultiplier: number;
}

/**
 * Logging interface for graph construction progress
 */
export interface RoutingGraphLogger {
  info: (message: string, data?: Record<string, unknown>) => void;
  warn: (message: string, data?: Record<string, unknown>) => void;
  error: (message: string, data?: Record<string, unknown>) => void;
}

// =============================================================================
// DEFAULT CONFIGURATION
// =============================================================================

const DEFAULT_CONFIG: RoutingGraphConfig = {
  samplingInterval: 12, // meters
  mergeThreshold: 15, // meters - increased from 5m to handle tiny gaps in imported conduit data
  coordinatePrecision: 5, // ~1.1m precision
  maxBridgeDistance: 100, // meters
  verbose: true,
  sidewalkOffset: 4, // meters from road centerline
  serviceAreaBuffer: 50, // meters beyond service area
  dualSidewalk: true, // create nodes on both sides of street
  roadCrossingCostMultiplier: 3.0, // crossing is 3x the distance cost
};

// =============================================================================
// COST CALCULATION CONSTANTS
// =============================================================================

/** Cost multipliers for different edge types */
const EDGE_COST_MULTIPLIERS = {
  /** Sidewalk edge - standard underground cost */
  sidewalk: { underground: 1.0, aerial: 0.7 },
  /** Road crossing - expensive due to traffic, permits, and restoration */
  road_crossing: { underground: 3.0, aerial: 1.0 },
  /** Aerial span - cheaper but requires poles */
  aerial_span: { underground: 2.0, aerial: 0.5 },
  /** Existing conduit - cheapest option */
  conduit: { underground: 0.3, aerial: 0.3 },
};

// =============================================================================
// NODE ID GENERATION
// =============================================================================

/**
 * Generate a unique node ID from coordinates with consistent precision
 * Using 5 decimal places gives ~1.1m precision, allowing automatic merge of nearby points
 */
export function generateNodeId(lng: number, lat: number, precision = 5): string {
  const roundedLng = lng.toFixed(precision);
  const roundedLat = lat.toFixed(precision);
  return `${roundedLng},${roundedLat}`;
}

/**
 * Parse a node ID back to coordinates
 */
export function parseNodeId(nodeId: string): [number, number] {
  const [lng, lat] = nodeId.split(",").map(Number);
  return [lng, lat];
}

// =============================================================================
// SPATIAL UTILITIES
// =============================================================================

/**
 * Calculate distance between two points in meters
 */
export function calculateDistance(p1: [number, number], p2: [number, number]): number {
  return turf.distance(turf.point(p1), turf.point(p2), { units: "meters" });
}

/**
 * Sample points along a line at regular intervals
 */
export function sampleStreetNodes(
  geometry: Position[],
  intervalMeters: number,
  streetId: string,
  streetName?: string,
  precision = 5,
): RoutingNode[] {
  if (geometry.length < 2) {
    return [];
  }

  const nodes: RoutingNode[] = [];
  const line = turf.lineString(geometry);
  const totalLength = turf.length(line, { units: "meters" });

  // Always include start point
  const startPos: [number, number] = [geometry[0][0], geometry[0][1]];
  nodes.push({
    id: generateNodeId(startPos[0], startPos[1], precision),
    position: startPos,
    type: "street",
    streetName,
    streetIds: [streetId],
  });

  // Sample intermediate points
  let distance = intervalMeters;
  while (distance < totalLength) {
    const point = turf.along(line, distance, { units: "meters" });
    const coords = point.geometry.coordinates as [number, number];
    nodes.push({
      id: generateNodeId(coords[0], coords[1], precision),
      position: coords,
      type: "street",
      streetName,
      streetIds: [streetId],
    });
    distance += intervalMeters;
  }

  // Always include end point
  const endPos: [number, number] = [
    geometry[geometry.length - 1][0],
    geometry[geometry.length - 1][1],
  ];
  nodes.push({
    id: generateNodeId(endPos[0], endPos[1], precision),
    position: endPos,
    type: "street",
    streetName,
    streetIds: [streetId],
  });

  return nodes;
}

/**
 * Extract the sub-segment of a LineString between two points using turf.lineSlice.
 * Falls back to a straight line if the slice fails (e.g. points outside the line).
 */
function sliceLineSegment(
  fullGeometry: Position[],
  startPoint: [number, number],
  endPoint: [number, number],
): Position[] {
  try {
    const line = turf.lineString(fullGeometry);
    const sliced = turf.lineSlice(turf.point(startPoint), turf.point(endPoint), line);
    const coords = sliced.geometry.coordinates;
    if (coords.length >= 2) return coords;
  } catch {
    /* fall through to straight-line fallback */
  }
  return [startPoint, endPoint];
}

/**
 * Check if two line segments are within merge distance of each other
 */
export function areSegmentsNear(
  p1: [number, number],
  p2: [number, number],
  thresholdMeters: number,
): boolean {
  return calculateDistance(p1, p2) <= thresholdMeters;
}

/**
 * Calculate edge costs based on edge type and distance
 */
export function calculateEdgeCosts(
  distance: number,
  pathType: RoutingEdge["pathType"],
): RoutingEdge["costs"] {
  const multipliers = EDGE_COST_MULTIPLIERS[pathType];
  return {
    underground: distance * multipliers.underground,
    aerial: distance * multipliers.aerial,
  };
}

/**
 * Offset a point perpendicular to a line direction
 * @param point The point to offset
 * @param bearing The bearing of the line (degrees, 0 = north)
 * @param offsetMeters Distance to offset (positive = right, negative = left)
 */
function offsetPointPerpendicular(
  point: [number, number],
  bearing: number,
  offsetMeters: number,
): [number, number] {
  // Perpendicular bearing is 90 degrees to the right
  const perpBearing = (bearing + 90) % 360;
  const destination = turf.destination(
    turf.point(point),
    offsetMeters / 1000, // convert to km
    perpBearing,
    { units: "kilometers" },
  );
  return destination.geometry.coordinates as [number, number];
}

/**
 * Calculate bearing between two points
 */
function calculateBearing(from: [number, number], to: [number, number]): number {
  return turf.bearing(turf.point(from), turf.point(to));
}

/**
 * Sample sidewalk-offset nodes along a street segment
 * Creates nodes on one or both sides of the street
 */
export function sampleSidewalkNodes(
  geometry: Position[],
  intervalMeters: number,
  streetId: string,
  streetName: string | undefined,
  sidewalkOffset: number,
  dualSidewalk: boolean,
  precision = 5,
): { left: RoutingNode[]; right: RoutingNode[] } {
  if (geometry.length < 2) {
    return { left: [], right: [] };
  }

  const leftNodes: RoutingNode[] = [];
  const rightNodes: RoutingNode[] = [];
  const line = turf.lineString(geometry);
  const totalLength = turf.length(line, { units: "meters" });

  // Sample points along the centerline
  const sampleDistances: number[] = [0]; // Always include start
  let distance = intervalMeters;
  while (distance < totalLength) {
    sampleDistances.push(distance);
    distance += intervalMeters;
  }
  sampleDistances.push(totalLength); // Always include end

  for (let i = 0; i < sampleDistances.length; i++) {
    const dist = sampleDistances[i];
    const point = turf.along(line, dist, { units: "meters" });
    const centerPos = point.geometry.coordinates as [number, number];

    // Calculate bearing at this point
    let bearing: number;
    if (i < sampleDistances.length - 1) {
      // Look ahead
      const nextPoint = turf.along(line, Math.min(dist + 1, totalLength), { units: "meters" });
      bearing = calculateBearing(centerPos, nextPoint.geometry.coordinates as [number, number]);
    } else if (i > 0) {
      // Look back for last point
      const prevPoint = turf.along(line, Math.max(dist - 1, 0), { units: "meters" });
      bearing = calculateBearing(prevPoint.geometry.coordinates as [number, number], centerPos);
    } else {
      bearing = calculateBearing(geometry[0] as [number, number], geometry[1] as [number, number]);
    }

    // Create right-side node
    const rightPos = offsetPointPerpendicular(centerPos, bearing, sidewalkOffset);
    rightNodes.push({
      id: generateNodeId(rightPos[0], rightPos[1], precision),
      position: rightPos,
      type: "street",
      streetName,
      streetIds: [streetId],
      streetSide: "right",
      centerlinePosition: centerPos,
    });

    // Create left-side node if dual sidewalk enabled
    if (dualSidewalk) {
      const leftPos = offsetPointPerpendicular(centerPos, bearing, -sidewalkOffset);
      leftNodes.push({
        id: generateNodeId(leftPos[0], leftPos[1], precision),
        position: leftPos,
        type: "street",
        streetName,
        streetIds: [streetId],
        streetSide: "left",
        centerlinePosition: centerPos,
      });
    }
  }

  return { left: leftNodes, right: rightNodes };
}

/**
 * Create road crossing edges between left and right sidewalk nodes at intersections
 * These edges represent crossing the road at designated points
 */
export function createRoadCrossingEdge(
  leftNode: RoutingNode,
  rightNode: RoutingNode,
  costMultiplier: number,
): RoutingEdge {
  const distance = calculateDistance(leftNode.position, rightNode.position);
  const costs = calculateEdgeCosts(distance, "road_crossing");
  // Apply additional cost multiplier for road crossings
  costs.underground *= costMultiplier;

  return {
    id: `crossing_${leftNode.id}_${rightNode.id}`,
    fromNodeId: leftNode.id,
    toNodeId: rightNode.id,
    distance,
    geometry: [leftNode.position, rightNode.position],
    pathType: "road_crossing",
    costs,
  };
}

/**
 * Create a buffered service area polygon for clipping
 * @param serviceArea The original service area polygon coordinates
 * @param bufferMeters Buffer distance in meters
 */
export function createBufferedServiceArea(
  serviceArea: Position[],
  bufferMeters: number,
): Position[] {
  if (serviceArea.length < 4) {
    return serviceArea;
  }

  const polygon = turf.polygon([serviceArea]);
  const buffered = turf.buffer(polygon, bufferMeters / 1000, { units: "kilometers" });

  if (!buffered) {
    return serviceArea;
  }

  // Handle potential MultiPolygon result
  if (buffered.geometry.type === "Polygon") {
    return buffered.geometry.coordinates[0];
  } else if (buffered.geometry.type === "MultiPolygon") {
    // Return largest polygon
    let maxArea = 0;
    let largestRing: Position[] = serviceArea;
    for (const coords of buffered.geometry.coordinates) {
      const poly = turf.polygon(coords);
      const area = turf.area(poly);
      if (area > maxArea) {
        maxArea = area;
        largestRing = coords[0];
      }
    }
    return largestRing;
  }

  return serviceArea;
}

/**
 * Check if a point is inside the service area (with buffer)
 */
export function isPointInServiceArea(
  point: [number, number],
  serviceAreaWithBuffer: Position[],
): boolean {
  if (serviceAreaWithBuffer.length < 4) {
    return true; // No service area defined, accept all
  }

  const polygon = turf.polygon([serviceAreaWithBuffer]);
  return turf.booleanPointInPolygon(turf.point(point), polygon);
}

/**
 * Create corner arc nodes at intersections
 * Instead of sharp diagonal corners, create smooth arc transitions
 * @param intersectionNode The intersection node
 * @param connectedStreetIds IDs of streets meeting at this intersection
 * @param streetSegments All street segments (to get geometries)
 * @param arcRadius Radius of the corner arc in meters (default: 3m)
 * @param numArcPoints Number of points along the arc (default: 3)
 */
export function createCornerArcNodes(
  intersectionNode: RoutingNode,
  connectedStreetIds: string[],
  streetSegments: StreetSegment[],
  sidewalkOffset: number,
  arcRadius = 3,
  numArcPoints = 3,
  precision = 5,
): { nodes: RoutingNode[]; edges: RoutingEdge[] } {
  const nodes: RoutingNode[] = [];
  const edges: RoutingEdge[] = [];

  if (connectedStreetIds.length < 2) {
    return { nodes, edges };
  }

  // Get bearings of all streets at this intersection
  const streetBearings: Array<{ streetId: string; bearing: number; streetName?: string }> = [];

  for (const streetId of connectedStreetIds) {
    const segment = streetSegments.find((s) => s.id === streetId);
    if (!segment || segment.geometry.length < 2) continue;

    // Find which end of the segment is at the intersection
    const startDist = calculateDistance(
      intersectionNode.position,
      segment.geometry[0] as [number, number],
    );
    const endDist = calculateDistance(
      intersectionNode.position,
      segment.geometry[segment.geometry.length - 1] as [number, number],
    );

    let bearing: number;
    if (startDist < endDist) {
      // Intersection is at start, bearing points away from intersection
      bearing = calculateBearing(
        segment.geometry[0] as [number, number],
        segment.geometry[1] as [number, number],
      );
    } else {
      // Intersection is at end, bearing points toward intersection
      const n = segment.geometry.length;
      bearing = calculateBearing(
        segment.geometry[n - 1] as [number, number],
        segment.geometry[n - 2] as [number, number],
      );
    }

    streetBearings.push({ streetId, bearing, streetName: segment.name });
  }

  // Sort by bearing to process corners in order
  streetBearings.sort((a, b) => a.bearing - b.bearing);

  // Create corner arcs between adjacent streets
  for (let i = 0; i < streetBearings.length; i++) {
    const current = streetBearings[i];
    const next = streetBearings[(i + 1) % streetBearings.length];

    // Calculate angle between streets
    let angleDiff = next.bearing - current.bearing;
    if (angleDiff < 0) angleDiff += 360;

    // Only create arc if angle is significant (not a straight continuation)
    if (angleDiff < 30 || angleDiff > 330) continue;

    // Create arc points
    const startAngle = current.bearing + 90; // Perpendicular (right side of current street)
    const endAngle = next.bearing - 90; // Perpendicular (right side of next street)

    // Arc from right side of current street to right side of next street
    for (let j = 0; j <= numArcPoints; j++) {
      const t = j / numArcPoints;
      // Interpolate angle
      let arcAngle = startAngle + t * (endAngle - startAngle);
      if (endAngle < startAngle) {
        arcAngle = startAngle + t * (endAngle + 360 - startAngle);
        if (arcAngle >= 360) arcAngle -= 360;
      }

      const arcPos = turf.destination(
        turf.point(intersectionNode.position),
        (sidewalkOffset + arcRadius) / 1000,
        arcAngle,
        { units: "kilometers" },
      ).geometry.coordinates as [number, number];

      const arcNode: RoutingNode = {
        id: generateNodeId(arcPos[0], arcPos[1], precision),
        position: arcPos,
        type: "intersection",
        streetName: `${current.streetName || current.streetId} / ${next.streetName || next.streetId}`,
        streetIds: [current.streetId, next.streetId],
        streetSide: "right",
        centerlinePosition: intersectionNode.position,
      };

      nodes.push(arcNode);

      // Connect arc nodes sequentially
      if (j > 0) {
        const prevNode = nodes[nodes.length - 2];
        const distance = calculateDistance(prevNode.position, arcNode.position);
        edges.push({
          id: `arc_${prevNode.id}_${arcNode.id}`,
          fromNodeId: prevNode.id,
          toNodeId: arcNode.id,
          distance,
          geometry: [prevNode.position, arcNode.position],
          pathType: "sidewalk",
          streetSide: "right",
          costs: calculateEdgeCosts(distance, "sidewalk"),
        });
      }
    }
  }

  return { nodes, edges };
}

// =============================================================================
// BUILDING CROSSING VALIDATION
// =============================================================================

/**
 * Create a spatial index for buildings to speed up crossing checks
 */
export function createBuildingSpatialIndex(
  buildings: BuildingPolygon[],
): Map<string, BuildingPolygon[]> {
  const cellSize = 0.001; // ~100m cells
  const index = new Map<string, BuildingPolygon[]>();

  for (const building of buildings) {
    if (!building.geometry || building.geometry.length === 0) continue;

    const ring = building.geometry[0];
    const bbox = turf.bbox(turf.polygon([ring]));
    const minCellX = Math.floor(bbox[0] / cellSize);
    const maxCellX = Math.ceil(bbox[2] / cellSize);
    const minCellY = Math.floor(bbox[1] / cellSize);
    const maxCellY = Math.ceil(bbox[3] / cellSize);

    for (let x = minCellX; x <= maxCellX; x++) {
      for (let y = minCellY; y <= maxCellY; y++) {
        const cellKey = `${x},${y}`;
        const cell = index.get(cellKey) || [];
        cell.push(building);
        index.set(cellKey, cell);
      }
    }
  }

  return index;
}

/**
 * Get buildings that might intersect with a line segment
 */
function getCandidateBuildings(
  p1: [number, number],
  p2: [number, number],
  index: Map<string, BuildingPolygon[]>,
): BuildingPolygon[] {
  const cellSize = 0.001;
  const minX = Math.floor(Math.min(p1[0], p2[0]) / cellSize);
  const maxX = Math.ceil(Math.max(p1[0], p2[0]) / cellSize);
  const minY = Math.floor(Math.min(p1[1], p2[1]) / cellSize);
  const maxY = Math.ceil(Math.max(p1[1], p2[1]) / cellSize);

  const candidates = new Set<BuildingPolygon>();
  for (let x = minX; x <= maxX; x++) {
    for (let y = minY; y <= maxY; y++) {
      const cellKey = `${x},${y}`;
      const buildings = index.get(cellKey);
      if (buildings) {
        for (const b of buildings) {
          candidates.add(b);
        }
      }
    }
  }

  return Array.from(candidates);
}

/**
 * Check if an edge crosses any building polygon
 * Returns true if the edge is INVALID (crosses a building)
 */
export function edgeCrossesBuilding(
  p1: [number, number],
  p2: [number, number],
  buildingIndex: Map<string, BuildingPolygon[]>,
): boolean {
  const candidates = getCandidateBuildings(p1, p2, buildingIndex);

  if (candidates.length === 0) {
    return false;
  }

  const edgeLine = turf.lineString([p1, p2]);

  for (const building of candidates) {
    if (!building.geometry || building.geometry.length === 0) continue;

    try {
      const polygon = turf.polygon(building.geometry);

      // Check if line crosses the polygon boundary
      if (turf.booleanCrosses(edgeLine, polygon)) {
        return true;
      }

      // Check if line is entirely within the polygon (both endpoints inside)
      const p1Inside = turf.booleanPointInPolygon(turf.point(p1), polygon);
      const p2Inside = turf.booleanPointInPolygon(turf.point(p2), polygon);

      if (p1Inside && p2Inside) {
        return true;
      }
    } catch {
      // Invalid polygon geometry, skip
    }
  }

  return false;
}

// =============================================================================
// GRAPH CONNECTIVITY (UNION-FIND)
// =============================================================================

/**
 * Union-Find data structure for efficiently detecting connected components
 */
class UnionFind {
  private parent: Map<string, string>;
  private rank: Map<string, number>;

  constructor() {
    this.parent = new Map();
    this.rank = new Map();
  }

  makeSet(x: string): void {
    if (!this.parent.has(x)) {
      this.parent.set(x, x);
      this.rank.set(x, 0);
    }
  }

  find(x: string): string {
    if (!this.parent.has(x)) {
      this.makeSet(x);
    }

    let root = x;
    while (this.parent.get(root) !== root) {
      root = this.parent.get(root)!;
    }

    // Path compression
    let current = x;
    while (current !== root) {
      const next = this.parent.get(current)!;
      this.parent.set(current, root);
      current = next;
    }

    return root;
  }

  union(x: string, y: string): void {
    const rootX = this.find(x);
    const rootY = this.find(y);

    if (rootX === rootY) return;

    const rankX = this.rank.get(rootX) || 0;
    const rankY = this.rank.get(rootY) || 0;

    if (rankX < rankY) {
      this.parent.set(rootX, rootY);
    } else if (rankX > rankY) {
      this.parent.set(rootY, rootX);
    } else {
      this.parent.set(rootY, rootX);
      this.rank.set(rootX, rankX + 1);
    }
  }

  getComponents(): Map<string, string[]> {
    const components = new Map<string, string[]>();

    for (const node of this.parent.keys()) {
      const root = this.find(node);
      const component = components.get(root) || [];
      component.push(node);
      components.set(root, component);
    }

    return components;
  }
}

/**
 * Find connected components in the graph
 */
export function findConnectedComponents(
  nodes: Map<string, RoutingNode>,
  edges: Map<string, RoutingEdge>,
): string[][] {
  const uf = new UnionFind();

  // Add all nodes
  for (const nodeId of nodes.keys()) {
    uf.makeSet(nodeId);
  }

  // Connect nodes via edges
  for (const edge of edges.values()) {
    uf.union(edge.fromNodeId, edge.toNodeId);
  }

  const componentMap = uf.getComponents();
  return Array.from(componentMap.values());
}

// =============================================================================
// INTERSECTION DETECTION
// =============================================================================

/**
 * Detect street intersections where multiple streets meet
 */
export function detectIntersections(
  nodes: Map<string, RoutingNode>,
  _mergeThreshold: number,
): Map<string, RoutingNode> {
  const updatedNodes = new Map<string, RoutingNode>();

  for (const [nodeId, node] of nodes) {
    // Count how many unique streets this node belongs to
    const uniqueStreets = new Set(node.streetIds || []);

    if (uniqueStreets.size > 1) {
      // This is an intersection
      updatedNodes.set(nodeId, {
        ...node,
        type: "intersection",
      });
    } else {
      updatedNodes.set(nodeId, node);
    }
  }

  return updatedNodes;
}

/**
 * Merge nodes that are within threshold distance
 * Returns a mapping from old node IDs to merged node IDs
 *
 * IMPORTANT: Nodes with different streetSide values are NOT merged together
 * to keep left-sidewalk and right-sidewalk nodes separate at intersections.
 */
export function mergeNearbyNodes(
  nodes: Map<string, RoutingNode>,
  thresholdMeters: number,
): { mergedNodes: Map<string, RoutingNode>; mergeMap: Map<string, string> } {
  const mergeMap = new Map<string, string>();
  const mergedNodes = new Map<string, RoutingNode>();
  const processed = new Set<string>();

  const nodeList = Array.from(nodes.entries());

  for (let i = 0; i < nodeList.length; i++) {
    const [nodeId, node] = nodeList[i];

    if (processed.has(nodeId)) continue;

    // Find all nodes within threshold distance AND on same street side
    const cluster: Array<{ id: string; node: RoutingNode }> = [{ id: nodeId, node }];
    processed.add(nodeId);

    for (let j = i + 1; j < nodeList.length; j++) {
      const [otherId, otherNode] = nodeList[j];
      if (processed.has(otherId)) continue;

      // Only merge nodes on the same street side (or both undefined)
      // This prevents left-sidewalk and right-sidewalk nodes from merging
      // which would place intersection nodes at road centerline
      const sameSide =
        node.streetSide === otherNode.streetSide ||
        (node.streetSide === undefined && otherNode.streetSide === undefined);

      if (!sameSide) continue;

      const dist = calculateDistance(node.position, otherNode.position);
      if (dist <= thresholdMeters) {
        cluster.push({ id: otherId, node: otherNode });
        processed.add(otherId);
      }
    }

    if (cluster.length === 1) {
      // No merging needed
      mergedNodes.set(nodeId, node);
      mergeMap.set(nodeId, nodeId);
    } else {
      // Merge cluster: calculate centroid and combine properties
      const allStreetIds = new Set<string>();
      const streetNames = new Set<string>();
      let bestType: RoutingNode["type"] = "street";

      // IMPORTANT: Find infrastructure node if present - its position is authoritative
      // Infrastructure nodes (conduit_access, pole, handhole) have precise positions from imported data
      // and should NOT be moved to a centroid when merged with street nodes.
      // This prevents closures from being placed OFF the underground path.
      let infrastructureNode: { id: string; node: RoutingNode } | undefined;

      for (const item of cluster) {
        for (const sid of item.node.streetIds || []) {
          allStreetIds.add(sid);
        }
        if (item.node.streetName) {
          streetNames.add(item.node.streetName);
        }
        // Prefer more specific types
        if (item.node.type === "intersection") {
          bestType = "intersection";
        } else if (
          item.node.type === "pole" ||
          item.node.type === "handhole" ||
          item.node.type === "conduit_access"
        ) {
          bestType = item.node.type;
          // Keep track of the first infrastructure node - its position is authoritative
          if (!infrastructureNode) {
            infrastructureNode = item;
          }
        }
      }

      // Determine merged position:
      // - If infrastructure node exists, use its EXACT position (it's on the actual conduit/pole)
      // - Otherwise, compute centroid of all nodes
      let mergedPosition: [number, number];
      if (infrastructureNode) {
        // Use infrastructure node's exact position - DO NOT average with street nodes
        // This ensures closures placed on conduit_access nodes stay ON the conduit
        mergedPosition = infrastructureNode.node.position;
      } else {
        // No infrastructure node - compute centroid as before
        let sumLng = 0;
        let sumLat = 0;
        for (const item of cluster) {
          sumLng += item.node.position[0];
          sumLat += item.node.position[1];
        }
        mergedPosition = [sumLng / cluster.length, sumLat / cluster.length];
      }

      const mergedId = generateNodeId(mergedPosition[0], mergedPosition[1]);

      // Preserve streetSide from the cluster (all nodes have same streetSide due to merge filter)
      const streetSide = cluster[0].node.streetSide;

      const mergedNode: RoutingNode = {
        id: mergedId,
        position: mergedPosition,
        type: allStreetIds.size > 1 ? "intersection" : bestType,
        streetName: Array.from(streetNames).join(" / "),
        streetIds: Array.from(allStreetIds),
        streetSide,
      };

      mergedNodes.set(mergedId, mergedNode);

      // Map all original IDs to the merged ID
      for (const item of cluster) {
        mergeMap.set(item.id, mergedId);
      }
    }
  }

  return { mergedNodes, mergeMap };
}

// =============================================================================
// SHORTEST PATH (DIJKSTRA)
// =============================================================================

/** Deployment type affects edge cost calculation */
export type DeploymentType = "underground" | "aerial";

/**
 * Find shortest path between two nodes using Dijkstra's algorithm
 * @param deploymentType Optional deployment type to use cost-based routing instead of distance
 */
export function findShortestPath(
  graph: RoutingGraph,
  fromNodeId: string,
  toNodeId: string,
  deploymentType?: DeploymentType,
): { path: string[]; distance: number; edges: string[]; cost: number } | null {
  if (!graph.nodes.has(fromNodeId) || !graph.nodes.has(toNodeId)) {
    return null;
  }

  const costs = new Map<string, number>();
  const distances = new Map<string, number>();
  const previous = new Map<string, { nodeId: string; edgeId: string } | null>();
  const visited = new Set<string>();

  // Priority queue (simple implementation)
  const queue: Array<{ nodeId: string; cost: number }> = [];

  costs.set(fromNodeId, 0);
  distances.set(fromNodeId, 0);
  previous.set(fromNodeId, null);
  queue.push({ nodeId: fromNodeId, cost: 0 });

  while (queue.length > 0) {
    // Find minimum cost node
    queue.sort((a, b) => a.cost - b.cost);
    const current = queue.shift()!;

    if (visited.has(current.nodeId)) continue;
    visited.add(current.nodeId);

    if (current.nodeId === toNodeId) {
      // Reconstruct path
      const path: string[] = [];
      const edges: string[] = [];
      let curr: string | undefined = toNodeId;

      while (curr) {
        path.unshift(curr);
        const prev = previous.get(curr);
        if (prev) {
          edges.unshift(prev.edgeId);
          curr = prev.nodeId;
        } else {
          break;
        }
      }

      return {
        path,
        distance: distances.get(toNodeId)!,
        edges,
        cost: costs.get(toNodeId)!,
      };
    }

    // Process neighbors
    const neighbors = graph.adjacency.get(current.nodeId) || [];
    for (const neighbor of neighbors) {
      if (visited.has(neighbor.nodeId)) continue;

      // Get the edge to determine cost
      const edge = graph.edges.get(neighbor.edgeId);
      let edgeCost: number;
      if (deploymentType && edge?.costs) {
        // Use deployment-specific cost
        edgeCost = edge.costs[deploymentType];
      } else {
        // Fall back to distance
        edgeCost = neighbor.distance;
      }

      const newCost = current.cost + edgeCost;
      const newDist = (distances.get(current.nodeId) || 0) + neighbor.distance;
      const oldCost = costs.get(neighbor.nodeId);

      if (oldCost === undefined || newCost < oldCost) {
        costs.set(neighbor.nodeId, newCost);
        distances.set(neighbor.nodeId, newDist);
        previous.set(neighbor.nodeId, {
          nodeId: current.nodeId,
          edgeId: neighbor.edgeId,
        });
        queue.push({ nodeId: neighbor.nodeId, cost: newCost });
      }
    }
  }

  return null; // No path found
}

/**
 * Find nearest graph node to a given point
 */
export function findNearestNode(
  graph: RoutingGraph,
  point: [number, number],
  maxDistance = Infinity,
): RoutingNode | null {
  let nearest: RoutingNode | null = null;
  let minDist = maxDistance;

  for (const node of graph.nodes.values()) {
    const dist = calculateDistance(point, node.position);
    if (dist < minDist) {
      minDist = dist;
      nearest = node;
    }
  }

  return nearest;
}

// =============================================================================
// BRIDGE EDGES FOR CONNECTIVITY
// =============================================================================

/**
 * Create bridge edges to connect disconnected components
 * Only creates bridges that don't cross buildings
 */
function createBridgeEdges(
  components: string[][],
  nodes: Map<string, RoutingNode>,
  buildingIndex: Map<string, BuildingPolygon[]>,
  maxBridgeDistance: number,
  logger: RoutingGraphLogger,
): RoutingEdge[] {
  if (components.length <= 1) {
    return [];
  }

  logger.info("Creating bridge edges to connect components", {
    componentCount: components.length,
  });

  const bridges: RoutingEdge[] = [];

  // For each pair of components, find the best bridge
  for (let i = 0; i < components.length - 1; i++) {
    for (let j = i + 1; j < components.length; j++) {
      let bestBridge: {
        from: RoutingNode;
        to: RoutingNode;
        distance: number;
      } | null = null;

      // Find closest pair of nodes between components
      for (const nodeIdA of components[i]) {
        const nodeA = nodes.get(nodeIdA);
        if (!nodeA) continue;

        for (const nodeIdB of components[j]) {
          const nodeB = nodes.get(nodeIdB);
          if (!nodeB) continue;

          const dist = calculateDistance(nodeA.position, nodeB.position);

          if (dist <= maxBridgeDistance) {
            // Check if this bridge would cross a building
            if (!edgeCrossesBuilding(nodeA.position, nodeB.position, buildingIndex)) {
              if (!bestBridge || dist < bestBridge.distance) {
                bestBridge = { from: nodeA, to: nodeB, distance: dist };
              }
            }
          }
        }
      }

      if (bestBridge) {
        const edgeId = `bridge_${bestBridge.from.id}_${bestBridge.to.id}`;
        bridges.push({
          id: edgeId,
          fromNodeId: bestBridge.from.id,
          toNodeId: bestBridge.to.id,
          distance: bestBridge.distance,
          geometry: [bestBridge.from.position, bestBridge.to.position],
          pathType: "road_crossing",
          costs: calculateEdgeCosts(bestBridge.distance, "road_crossing"),
        });

        logger.info("Created bridge edge", {
          edgeId,
          distance: Math.round(bestBridge.distance),
          from: bestBridge.from.id,
          to: bestBridge.to.id,
        });
      } else {
        logger.warn("Could not create bridge between components", {
          componentI: i,
          componentJ: j,
          reason: "No valid path within distance that doesn't cross buildings",
        });
      }
    }
  }

  return bridges;
}

/**
 * Guarantee a single connected component. createBridgeEdges only bridges gaps
 * within maxBridgeDistance and never crosses buildings, so real OSM areas can
 * still leave several components split by larger gaps (the live run that
 * motivated WS-A had 6). Placement and routing degrade badly on a disconnected
 * graph, so this fallback connects every remaining component to the first by
 * its nearest node pair — ignoring the distance cap, crossing a building only
 * as a last resort. The component count is still reported in the design verdict,
 * so a forced long bridge stays visible rather than silently hidden.
 */
function forceBridgeComponents(
  components: string[][],
  nodes: Map<string, RoutingNode>,
  buildingIndex: Map<string, BuildingPolygon[]>,
  logger: RoutingGraphLogger,
): RoutingEdge[] {
  if (components.length <= 1) return [];

  const bridges: RoutingEdge[] = [];
  const base = components[0];

  for (let j = 1; j < components.length; j++) {
    let best: {
      from: RoutingNode;
      to: RoutingNode;
      distance: number;
      crosses: boolean;
    } | null = null;

    for (const idA of base) {
      const nodeA = nodes.get(idA);
      if (!nodeA) continue;
      for (const idB of components[j]) {
        const nodeB = nodes.get(idB);
        if (!nodeB) continue;
        const dist = calculateDistance(nodeA.position, nodeB.position);
        const crosses = edgeCrossesBuilding(nodeA.position, nodeB.position, buildingIndex);
        // Prefer the shortest non-crossing pair; only take a crossing pair if no
        // non-crossing pair has been found yet.
        if (
          !best ||
          (best.crosses && !crosses) ||
          (best.crosses === crosses && dist < best.distance)
        ) {
          best = { from: nodeA, to: nodeB, distance: dist, crosses };
        }
      }
    }

    if (!best) continue;
    const edgeId = `forced-bridge_${best.from.id}_${best.to.id}`;
    bridges.push({
      id: edgeId,
      fromNodeId: best.from.id,
      toNodeId: best.to.id,
      distance: best.distance,
      geometry: [best.from.position, best.to.position],
      pathType: "road_crossing",
      costs: calculateEdgeCosts(best.distance, "road_crossing"),
    });
    logger.warn("Forced bridge to guarantee connectivity", {
      edgeId,
      distance: Math.round(best.distance),
      crossesBuilding: best.crosses,
    });
  }

  return bridges;
}

// =============================================================================
// MAIN GRAPH BUILDER
// =============================================================================

/**
 * Build the canonical routing graph from street segments and buildings
 *
 * @param streetSegments - Array of street segments from OSM or other source
 * @param buildings - Array of building polygons for crossing validation
 * @param existingInfra - Optional existing infrastructure (poles, handholes, conduits)
 * @param config - Configuration options
 * @param logger - Logger for progress output
 * @returns The constructed routing graph
 */
export function buildRoutingGraph(
  streetSegments: StreetSegment[],
  buildings: BuildingPolygon[] = [],
  existingInfra?: ExistingInfrastructure,
  config: Partial<RoutingGraphConfig> = {},
  logger?: RoutingGraphLogger,
  serviceArea?: Position[],
): RoutingGraph {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  const log: RoutingGraphLogger = logger || {
    info: (msg, data) => cfg.verbose && console.log(`[RoutingGraph] ${msg}`, data || ""),
    warn: (msg, data) => console.warn(`[RoutingGraph] WARNING: ${msg}`, data || ""),
    error: (msg, data) => console.error(`[RoutingGraph] ERROR: ${msg}`, data || ""),
  };

  log.info("Starting routing graph construction", {
    streetCount: streetSegments.length,
    buildingCount: buildings.length,
    config: cfg,
  });

  // Step 0: Create buffered service area for clipping (if provided)
  let bufferedServiceArea: Position[] | undefined;
  if (serviceArea && serviceArea.length >= 4) {
    bufferedServiceArea = createBufferedServiceArea(serviceArea, cfg.serviceAreaBuffer);
    log.info("Service area buffered", {
      bufferMeters: cfg.serviceAreaBuffer,
      originalPointCount: serviceArea.length,
      bufferedPointCount: bufferedServiceArea.length,
    });
  } else {
    log.info("No service area provided - nodes will not be clipped");
  }

  // Step 1: Create building spatial index
  log.info("Creating building spatial index");
  const buildingIndex = createBuildingSpatialIndex(buildings);
  log.info("Building index created", { cellCount: buildingIndex.size });

  // Step 2: Sample nodes along all streets (using sidewalk offset if configured)
  const useSidewalkOffset = cfg.sidewalkOffset > 0;
  log.info("Sampling nodes along streets", {
    useSidewalkOffset,
    sidewalkOffset: cfg.sidewalkOffset,
    dualSidewalk: cfg.dualSidewalk,
  });
  const rawNodes = new Map<string, RoutingNode>();
  let totalStreetLength = 0;

  // Track pairs of left/right nodes for road crossings
  const crossingPairs: Array<{ left: RoutingNode; right: RoutingNode; streetId: string }> = [];

  for (const segment of streetSegments) {
    if (!segment.geometry || segment.geometry.length < 2) continue;

    const line = turf.lineString(segment.geometry);
    totalStreetLength += turf.length(line, { units: "meters" });

    if (useSidewalkOffset) {
      // Use sidewalk-offset sampling
      const { left, right } = sampleSidewalkNodes(
        segment.geometry,
        cfg.samplingInterval,
        segment.id,
        segment.name,
        cfg.sidewalkOffset,
        cfg.dualSidewalk,
        cfg.coordinatePrecision,
      );

      // Add right-side nodes
      for (const node of right) {
        const existing = rawNodes.get(node.id);
        if (existing) {
          const streetIds = new Set([...(existing.streetIds || []), ...(node.streetIds || [])]);
          rawNodes.set(node.id, {
            ...existing,
            streetIds: Array.from(streetIds),
            streetName: existing.streetName
              ? `${existing.streetName} / ${node.streetName || ""}`
              : node.streetName,
          });
        } else {
          rawNodes.set(node.id, node);
        }
      }

      // Add left-side nodes if dual sidewalk enabled
      if (cfg.dualSidewalk) {
        for (const node of left) {
          const existing = rawNodes.get(node.id);
          if (existing) {
            const streetIds = new Set([...(existing.streetIds || []), ...(node.streetIds || [])]);
            rawNodes.set(node.id, {
              ...existing,
              streetIds: Array.from(streetIds),
              streetName: existing.streetName
                ? `${existing.streetName} / ${node.streetName || ""}`
                : node.streetName,
            });
          } else {
            rawNodes.set(node.id, node);
          }
        }

        // Track crossing pairs at start and end of each segment
        if (left.length > 0 && right.length > 0) {
          // Crossing at segment start
          crossingPairs.push({ left: left[0], right: right[0], streetId: segment.id });
          // Crossing at segment end
          if (left.length > 1 && right.length > 1) {
            crossingPairs.push({
              left: left[left.length - 1],
              right: right[right.length - 1],
              streetId: segment.id,
            });
          }
        }
      }
    } else {
      // Fallback to centerline sampling (original behavior)
      const nodes = sampleStreetNodes(
        segment.geometry,
        cfg.samplingInterval,
        segment.id,
        segment.name,
        cfg.coordinatePrecision,
      );

      for (const node of nodes) {
        const existing = rawNodes.get(node.id);
        if (existing) {
          const streetIds = new Set([...(existing.streetIds || []), ...(node.streetIds || [])]);
          rawNodes.set(node.id, {
            ...existing,
            streetIds: Array.from(streetIds),
            streetName: existing.streetName
              ? `${existing.streetName} / ${node.streetName || ""}`
              : node.streetName,
          });
        } else {
          rawNodes.set(node.id, node);
        }
      }
    }
  }

  log.info("Raw nodes sampled", { count: rawNodes.size });

  // Step 3: Add existing infrastructure nodes
  if (existingInfra) {
    log.info("Adding existing infrastructure nodes");

    if (existingInfra.poles) {
      for (const pole of existingInfra.poles) {
        const nodeId = generateNodeId(pole.position[0], pole.position[1], cfg.coordinatePrecision);
        const existing = rawNodes.get(nodeId);
        rawNodes.set(nodeId, {
          ...existing,
          id: nodeId,
          position: pole.position,
          type: "pole",
          streetIds: existing?.streetIds,
          streetName: existing?.streetName,
        });
      }
    }

    if (existingInfra.handholes) {
      for (const handhole of existingInfra.handholes) {
        const nodeId = generateNodeId(
          handhole.position[0],
          handhole.position[1],
          cfg.coordinatePrecision,
        );
        const existing = rawNodes.get(nodeId);
        rawNodes.set(nodeId, {
          ...existing,
          id: nodeId,
          position: handhole.position,
          type: "handhole",
          streetIds: existing?.streetIds,
          streetName: existing?.streetName,
        });
      }
    }

    // Sample nodes along conduits (like streets) so MIP can place equipment along them
    if (existingInfra.conduits) {
      log.info("Sampling nodes along conduits");
      let conduitNodesCount = 0;
      for (const conduit of existingInfra.conduits) {
        if (conduit.geometry.length < 2) continue;

        // Sample nodes along the conduit path at the same interval as streets
        const conduitNodes = sampleStreetNodes(
          conduit.geometry,
          cfg.samplingInterval,
          `conduit_${conduit.id}`,
          undefined,
          cfg.coordinatePrecision,
        );

        // Add sampled nodes as conduit_access type
        for (const node of conduitNodes) {
          const existing = rawNodes.get(node.id);
          rawNodes.set(node.id, {
            ...existing,
            id: node.id,
            position: node.position,
            type: "conduit_access",
            streetIds: existing?.streetIds || node.streetIds,
            streetName: existing?.streetName,
          });
          conduitNodesCount++;
        }
      }
      log.info("Conduit nodes sampled", { count: conduitNodesCount });
    }

    // Sample nodes along aerial spans so MIP can place equipment along them
    if (existingInfra.aerialSpans) {
      log.info("Sampling nodes along aerial spans");
      let aerialNodesCount = 0;
      for (const span of existingInfra.aerialSpans) {
        if (span.geometry.length < 2) continue;

        // Sample nodes along the aerial span path at the same interval as streets
        const spanNodes = sampleStreetNodes(
          span.geometry,
          cfg.samplingInterval,
          `aerial_${span.id}`,
          undefined,
          cfg.coordinatePrecision,
        );

        // Add sampled nodes - use "pole" type since aerial spans typically connect poles
        for (const node of spanNodes) {
          const existing = rawNodes.get(node.id);
          // Don't overwrite if already a pole (from explicit pole data)
          if (existing?.type === "pole") continue;

          rawNodes.set(node.id, {
            ...existing,
            id: node.id,
            position: node.position,
            type: existing?.type || "street", // Keep existing type or default to street
            streetIds: existing?.streetIds || node.streetIds,
            streetName: existing?.streetName,
          });
          aerialNodesCount++;
        }
      }
      log.info("Aerial span nodes sampled", { count: aerialNodesCount });
    }

    log.info("Infrastructure nodes added", {
      poles: existingInfra.poles?.length || 0,
      handholes: existingInfra.handholes?.length || 0,
      conduits: existingInfra.conduits?.length || 0,
      aerialSpans: existingInfra.aerialSpans?.length || 0,
    });
  }

  // Step 4: Merge nearby nodes (especially at intersections)
  log.info("Merging nearby nodes", { threshold: cfg.mergeThreshold });
  const { mergedNodes, mergeMap } = mergeNearbyNodes(rawNodes, cfg.mergeThreshold);
  log.info("Nodes merged", {
    before: rawNodes.size,
    after: mergedNodes.size,
    merged: rawNodes.size - mergedNodes.size,
  });

  // Step 5: Detect intersections
  log.info("Detecting intersections");
  let nodesWithIntersections = detectIntersections(mergedNodes, cfg.mergeThreshold);
  const intersectionCount = Array.from(nodesWithIntersections.values()).filter(
    (n) => n.type === "intersection",
  ).length;
  log.info("Intersections detected", { count: intersectionCount });

  // Step 5b: Clip nodes outside buffered service area
  if (bufferedServiceArea && bufferedServiceArea.length >= 4) {
    log.info("Clipping nodes outside service area");
    const beforeClipCount = nodesWithIntersections.size;
    const clippedNodes = new Map<string, RoutingNode>();

    for (const [nodeId, node] of nodesWithIntersections) {
      if (isPointInServiceArea(node.position, bufferedServiceArea)) {
        clippedNodes.set(nodeId, node);
      }
    }

    const removedCount = beforeClipCount - clippedNodes.size;
    log.info("Service area clipping complete", {
      before: beforeClipCount,
      after: clippedNodes.size,
      removed: removedCount,
      removedPercent: `${((removedCount / beforeClipCount) * 100).toFixed(1)}%`,
    });

    nodesWithIntersections = clippedNodes;
  }

  // Step 6: Create edges along streets (with building validation)
  log.info("Creating edges along streets");
  const edges = new Map<string, RoutingEdge>();
  let rejectedEdges = 0;

  for (const segment of streetSegments) {
    if (!segment.geometry || segment.geometry.length < 2) continue;

    // Create edges between consecutive sampled nodes
    const nodeIds: string[] = [];
    for (let i = 0; i < segment.geometry.length; i++) {
      const pos = segment.geometry[i];
      const rawId = generateNodeId(pos[0], pos[1], cfg.coordinatePrecision);
      const mergedId = mergeMap.get(rawId) || rawId;
      if (nodeIds.length === 0 || nodeIds[nodeIds.length - 1] !== mergedId) {
        nodeIds.push(mergedId);
      }
    }

    for (let i = 0; i < nodeIds.length - 1; i++) {
      const fromId = nodeIds[i];
      const toId = nodeIds[i + 1];

      if (fromId === toId) continue;

      const fromNode = nodesWithIntersections.get(fromId);
      const toNode = nodesWithIntersections.get(toId);

      if (!fromNode || !toNode) continue;

      // Check if edge crosses any building
      if (edgeCrossesBuilding(fromNode.position, toNode.position, buildingIndex)) {
        rejectedEdges++;
        continue; // REJECT this edge - it crosses a building
      }

      const edgeId = `${fromId}_${toId}`;
      const reverseId = `${toId}_${fromId}`;

      if (!edges.has(edgeId) && !edges.has(reverseId)) {
        const distance = calculateDistance(fromNode.position, toNode.position);
        edges.set(edgeId, {
          id: edgeId,
          fromNodeId: fromId,
          toNodeId: toId,
          distance,
          geometry: [fromNode.position, toNode.position],
          pathType: "sidewalk",
          streetName: segment.name,
          streetSide: fromNode.streetSide || "right",
          costs: calculateEdgeCosts(distance, "sidewalk"),
        });
      }
    }
  }

  log.info("Edges created", {
    count: edges.size,
    rejected: rejectedEdges,
    rejectionReason: "Building crossing",
  });

  // Step 6b: Add road crossing edges (only when using dual sidewalk)
  if (useSidewalkOffset && cfg.dualSidewalk && crossingPairs.length > 0) {
    log.info("Adding road crossing edges", { pairCount: crossingPairs.length });
    let crossingEdgesAdded = 0;

    for (const pair of crossingPairs) {
      // Check if both nodes exist after merging
      const leftId = mergeMap.get(pair.left.id) || pair.left.id;
      const rightId = mergeMap.get(pair.right.id) || pair.right.id;

      if (leftId === rightId) continue; // Skip if merged to same node

      const leftNode = nodesWithIntersections.get(leftId);
      const rightNode = nodesWithIntersections.get(rightId);

      if (!leftNode || !rightNode) continue;

      // Don't create crossing if it would cross a building
      if (edgeCrossesBuilding(leftNode.position, rightNode.position, buildingIndex)) {
        continue;
      }

      // Create the road crossing edge
      const crossingEdge = createRoadCrossingEdge(
        leftNode,
        rightNode,
        cfg.roadCrossingCostMultiplier,
      );

      // Check if edge already exists
      const reverseId = `crossing_${rightId}_${leftId}`;
      if (!edges.has(crossingEdge.id) && !edges.has(reverseId)) {
        edges.set(crossingEdge.id, crossingEdge);
        crossingEdgesAdded++;
      }
    }

    log.info("Road crossing edges added", { count: crossingEdgesAdded });
  }

  // Step 7: Add existing infrastructure edges (conduits, aerial spans)
  // These edges connect the sampled nodes created in Step 3
  if (existingInfra) {
    if (existingInfra.conduits) {
      log.info("Adding conduit edges between sampled nodes");
      let conduitEdgesAdded = 0;

      for (const conduit of existingInfra.conduits) {
        if (conduit.geometry.length < 2) continue;

        // Re-sample nodes to get the same sequence as Step 3
        const conduitNodes = sampleStreetNodes(
          conduit.geometry,
          cfg.samplingInterval,
          `conduit_${conduit.id}`,
          undefined,
          cfg.coordinatePrecision,
        );

        // Create edges between consecutive sampled nodes
        for (let i = 0; i < conduitNodes.length - 1; i++) {
          const fromNode = conduitNodes[i];
          const toNode = conduitNodes[i + 1];
          const fromId = mergeMap.get(fromNode.id) || fromNode.id;
          const toId = mergeMap.get(toNode.id) || toNode.id;

          if (fromId === toId) continue;

          // Check if both nodes exist after clipping
          const fromExists = nodesWithIntersections.has(fromId);
          const toExists = nodesWithIntersections.has(toId);
          if (!fromExists || !toExists) continue;

          const edgeId = `conduit_${conduit.id}_${i}`;
          const reverseId = `conduit_${conduit.id}_${i}_rev`;

          if (!edges.has(edgeId) && !edges.has(reverseId)) {
            const conduitDistance = calculateDistance(fromNode.position, toNode.position);
            edges.set(edgeId, {
              id: edgeId,
              fromNodeId: fromId,
              toNodeId: toId,
              distance: conduitDistance,
              geometry: sliceLineSegment(conduit.geometry, fromNode.position, toNode.position),
              pathType: "conduit",
              costs: calculateEdgeCosts(conduitDistance, "conduit"),
            });
            conduitEdgesAdded++;
          }
        }
      }
      log.info("Conduit edges added", { count: conduitEdgesAdded });
    }

    if (existingInfra.aerialSpans) {
      log.info("Adding aerial span edges between sampled nodes");
      let aerialEdgesAdded = 0;

      for (const span of existingInfra.aerialSpans) {
        if (span.geometry.length < 2) continue;

        // Re-sample nodes to get the same sequence as Step 3
        const spanNodes = sampleStreetNodes(
          span.geometry,
          cfg.samplingInterval,
          `aerial_${span.id}`,
          undefined,
          cfg.coordinatePrecision,
        );

        // Create edges between consecutive sampled nodes
        for (let i = 0; i < spanNodes.length - 1; i++) {
          const fromNode = spanNodes[i];
          const toNode = spanNodes[i + 1];
          const fromId = mergeMap.get(fromNode.id) || fromNode.id;
          const toId = mergeMap.get(toNode.id) || toNode.id;

          if (fromId === toId) continue;

          // Check if both nodes exist after clipping
          const fromExists = nodesWithIntersections.has(fromId);
          const toExists = nodesWithIntersections.has(toId);
          if (!fromExists || !toExists) continue;

          const edgeId = `aerial_${span.id}_${i}`;
          const reverseId = `aerial_${span.id}_${i}_rev`;

          if (!edges.has(edgeId) && !edges.has(reverseId)) {
            const aerialDistance = calculateDistance(fromNode.position, toNode.position);
            edges.set(edgeId, {
              id: edgeId,
              fromNodeId: fromId,
              toNodeId: toId,
              distance: aerialDistance,
              geometry: sliceLineSegment(span.geometry, fromNode.position, toNode.position),
              pathType: "aerial_span",
              costs: calculateEdgeCosts(aerialDistance, "aerial_span"),
            });
            aerialEdgesAdded++;
          }
        }
      }
      log.info("Aerial span edges added", { count: aerialEdgesAdded });
    }
  }

  // Step 8: Build adjacency list
  log.info("Building adjacency list");
  const adjacency = new Map<string, AdjacencyEntry[]>();

  for (const node of nodesWithIntersections.keys()) {
    adjacency.set(node, []);
  }

  for (const edge of edges.values()) {
    const fromAdj = adjacency.get(edge.fromNodeId) || [];
    fromAdj.push({
      nodeId: edge.toNodeId,
      edgeId: edge.id,
      distance: edge.distance,
      undergroundCost: edge.costs.underground,
      aerialCost: edge.costs.aerial,
    });
    adjacency.set(edge.fromNodeId, fromAdj);

    const toAdj = adjacency.get(edge.toNodeId) || [];
    toAdj.push({
      nodeId: edge.fromNodeId,
      edgeId: edge.id,
      distance: edge.distance,
      undergroundCost: edge.costs.underground,
      aerialCost: edge.costs.aerial,
    });
    adjacency.set(edge.toNodeId, toAdj);
  }

  // Step 9: Check connectivity and add bridge edges if needed
  log.info("Checking graph connectivity");
  let components = findConnectedComponents(nodesWithIntersections, edges);
  log.info("Initial connectivity check", {
    componentCount: components.length,
    largestComponent: Math.max(...components.map((c) => c.length)),
  });

  if (components.length > 1) {
    log.warn("Graph has multiple components, attempting to create bridges", {
      componentCount: components.length,
    });

    const bridges = createBridgeEdges(
      components,
      nodesWithIntersections,
      buildingIndex,
      cfg.maxBridgeDistance,
      log,
    );

    for (const bridge of bridges) {
      edges.set(bridge.id, bridge);

      // Update adjacency
      const fromAdj = adjacency.get(bridge.fromNodeId) || [];
      fromAdj.push({
        nodeId: bridge.toNodeId,
        edgeId: bridge.id,
        distance: bridge.distance,
        undergroundCost: bridge.costs.underground,
        aerialCost: bridge.costs.aerial,
      });
      adjacency.set(bridge.fromNodeId, fromAdj);

      const toAdj = adjacency.get(bridge.toNodeId) || [];
      toAdj.push({
        nodeId: bridge.fromNodeId,
        edgeId: bridge.id,
        distance: bridge.distance,
        undergroundCost: bridge.costs.underground,
        aerialCost: bridge.costs.aerial,
      });
      adjacency.set(bridge.toNodeId, toAdj);
    }

    // Recheck connectivity
    components = findConnectedComponents(nodesWithIntersections, edges);
    log.info("Connectivity after bridging", {
      componentCount: components.length,
      bridgesAdded: bridges.length,
    });

    // Distance-capped bridging left the graph split — force a single component
    // so placement/routing don't fail on disconnected nodes (WS-A A4).
    if (components.length > 1) {
      const forced = forceBridgeComponents(components, nodesWithIntersections, buildingIndex, log);
      for (const bridge of forced) {
        edges.set(bridge.id, bridge);
        const fromAdj = adjacency.get(bridge.fromNodeId) || [];
        fromAdj.push({
          nodeId: bridge.toNodeId,
          edgeId: bridge.id,
          distance: bridge.distance,
          undergroundCost: bridge.costs.underground,
          aerialCost: bridge.costs.aerial,
        });
        adjacency.set(bridge.fromNodeId, fromAdj);

        const toAdj = adjacency.get(bridge.toNodeId) || [];
        toAdj.push({
          nodeId: bridge.fromNodeId,
          edgeId: bridge.id,
          distance: bridge.distance,
          undergroundCost: bridge.costs.underground,
          aerialCost: bridge.costs.aerial,
        });
        adjacency.set(bridge.toNodeId, toAdj);
      }

      components = findConnectedComponents(nodesWithIntersections, edges);
      log.info("Connectivity after forced bridging", {
        componentCount: components.length,
        forcedBridges: forced.length,
      });
    }
  }

  // Calculate bounding box
  let minLng = Infinity,
    minLat = Infinity,
    maxLng = -Infinity,
    maxLat = -Infinity;
  for (const node of nodesWithIntersections.values()) {
    minLng = Math.min(minLng, node.position[0]);
    minLat = Math.min(minLat, node.position[1]);
    maxLng = Math.max(maxLng, node.position[0]);
    maxLat = Math.max(maxLat, node.position[1]);
  }

  const graph: RoutingGraph = {
    nodes: nodesWithIntersections,
    edges,
    adjacency,
    metadata: {
      createdAt: new Date(),
      nodeCount: nodesWithIntersections.size,
      edgeCount: edges.size,
      componentCount: components.length,
      totalStreetLength: Math.round(totalStreetLength),
      boundingBox: [minLng, minLat, maxLng, maxLat],
      useSidewalkOffset: cfg.sidewalkOffset > 0,
      serviceAreaBuffer: bufferedServiceArea,
    },
  };

  log.info("Routing graph construction complete", {
    nodes: graph.metadata.nodeCount,
    edges: graph.metadata.edgeCount,
    components: graph.metadata.componentCount,
    streetLength: `${Math.round(totalStreetLength)}m`,
  });

  if (graph.metadata.componentCount > 1) {
    log.warn("GRAPH IS NOT FULLY CONNECTED", {
      componentCount: graph.metadata.componentCount,
      message:
        "Some nodes are unreachable. Check if OSM data has gaps or buildings block all paths.",
    });
  }

  return graph;
}

// =============================================================================
// VALIDATION UTILITIES
// =============================================================================

/**
 * Validate that a point can be snapped to the routing graph
 */
export function validatePointSnapping(
  graph: RoutingGraph,
  point: [number, number],
  maxSnapDistance = 50,
): { valid: boolean; nearestNode: RoutingNode | null; distance: number } {
  const nearest = findNearestNode(graph, point, maxSnapDistance);

  if (!nearest) {
    return { valid: false, nearestNode: null, distance: Infinity };
  }

  const distance = calculateDistance(point, nearest.position);
  return {
    valid: distance <= maxSnapDistance,
    nearestNode: nearest,
    distance,
  };
}

/**
 * Validate that a route exists between two points
 */
export function validateRoute(
  graph: RoutingGraph,
  from: [number, number],
  to: [number, number],
  maxSnapDistance = 50,
): {
  valid: boolean;
  fromNode: RoutingNode | null;
  toNode: RoutingNode | null;
  path: string[] | null;
  distance: number | null;
  error?: string;
} {
  const fromSnap = validatePointSnapping(graph, from, maxSnapDistance);
  if (!fromSnap.valid) {
    return {
      valid: false,
      fromNode: null,
      toNode: null,
      path: null,
      distance: null,
      error: `Source point too far from routing graph (${Math.round(fromSnap.distance)}m)`,
    };
  }

  const toSnap = validatePointSnapping(graph, to, maxSnapDistance);
  if (!toSnap.valid) {
    return {
      valid: false,
      fromNode: fromSnap.nearestNode,
      toNode: null,
      path: null,
      distance: null,
      error: `Destination point too far from routing graph (${Math.round(toSnap.distance)}m)`,
    };
  }

  const pathResult = findShortestPath(graph, fromSnap.nearestNode!.id, toSnap.nearestNode!.id);

  if (!pathResult) {
    return {
      valid: false,
      fromNode: fromSnap.nearestNode,
      toNode: toSnap.nearestNode,
      path: null,
      distance: null,
      error: "No path exists between points (nodes may be in different components)",
    };
  }

  return {
    valid: true,
    fromNode: fromSnap.nearestNode,
    toNode: toSnap.nearestNode,
    path: pathResult.path,
    distance: pathResult.distance,
  };
}

// =============================================================================
// GRAPH STATISTICS AND DEBUGGING
// =============================================================================

/**
 * Get detailed statistics about the routing graph
 */
export function getGraphStatistics(graph: RoutingGraph): {
  nodesByType: Record<string, number>;
  edgesByType: Record<string, number>;
  avgEdgeLength: number;
  maxEdgeLength: number;
  minEdgeLength: number;
  avgDegree: number;
  isolatedNodes: number;
  components: Array<{ size: number; nodeIds: string[] }>;
} {
  const nodesByType: Record<string, number> = {};
  const edgesByType: Record<string, number> = {};
  let totalEdgeLength = 0;
  let maxEdgeLength = 0;
  let minEdgeLength = Infinity;
  let totalDegree = 0;
  let isolatedNodes = 0;

  for (const node of graph.nodes.values()) {
    nodesByType[node.type] = (nodesByType[node.type] || 0) + 1;
    const degree = graph.adjacency.get(node.id)?.length || 0;
    totalDegree += degree;
    if (degree === 0) isolatedNodes++;
  }

  for (const edge of graph.edges.values()) {
    edgesByType[edge.pathType] = (edgesByType[edge.pathType] || 0) + 1;
    totalEdgeLength += edge.distance;
    maxEdgeLength = Math.max(maxEdgeLength, edge.distance);
    minEdgeLength = Math.min(minEdgeLength, edge.distance);
  }

  const components = findConnectedComponents(graph.nodes, graph.edges).map((nodeIds) => ({
    size: nodeIds.length,
    nodeIds,
  }));

  return {
    nodesByType,
    edgesByType,
    avgEdgeLength: graph.edges.size > 0 ? totalEdgeLength / graph.edges.size : 0,
    maxEdgeLength,
    minEdgeLength: minEdgeLength === Infinity ? 0 : minEdgeLength,
    avgDegree: graph.nodes.size > 0 ? totalDegree / graph.nodes.size : 0,
    isolatedNodes,
    components: components.sort((a, b) => b.size - a.size),
  };
}

// =============================================================================
// CONNECTIVITY VALIDATION (Pre-Generation Check)
// =============================================================================

/**
 * Result of connectivity validation before network generation
 */
export interface ConnectivityValidationResult {
  /** Whether all demand points are reachable from CO */
  allReachable: boolean;
  /** CO node in the graph (or nearest node) */
  coNode: RoutingNode | null;
  /** Demand points that ARE reachable from CO */
  reachablePoints: Array<{
    position: [number, number];
    graphNode: RoutingNode;
    distanceFromCO: number;
  }>;
  /** Demand points that are NOT reachable (in different component) */
  unreachablePoints: Array<{
    position: [number, number];
    nearestGraphNode: RoutingNode | null;
    reason: "different_component" | "too_far_from_graph" | "no_path";
  }>;
  /** Gaps in the infrastructure that need to be bridged */
  infrastructureGaps: Array<{
    fromComponent: string[];
    toComponent: string[];
    shortestGapDistance: number;
    suggestedBridgeFrom: [number, number];
    suggestedBridgeTo: [number, number];
  }>;
  /** Summary statistics */
  summary: {
    totalDemandPoints: number;
    reachableCount: number;
    unreachableCount: number;
    componentCount: number;
    coComponentSize: number;
  };
}

/**
 * Validate that all demand points (buildings/homes) are reachable from the CO position
 * through the routing graph. This should be called BEFORE network generation.
 *
 * @param graph The routing graph (with infrastructure)
 * @param coPosition Central Office / OLT position [lng, lat]
 * @param demandPoints Array of positions representing buildings/homes to serve
 * @param maxSnapDistance Maximum distance to snap points to graph (meters)
 * @returns Validation result with reachable/unreachable points and gap information
 */
export function validateConnectivityForGeneration(
  graph: RoutingGraph,
  coPosition: [number, number],
  demandPoints: [number, number][],
  maxSnapDistance = 100,
): ConnectivityValidationResult {
  console.log("[Connectivity] Starting validation...");
  console.log(
    `[Connectivity] CO position: [${coPosition[0].toFixed(6)}, ${coPosition[1].toFixed(6)}]`,
  );
  console.log(`[Connectivity] Demand points: ${demandPoints.length}`);
  console.log(`[Connectivity] Graph: ${graph.nodes.size} nodes, ${graph.edges.size} edges`);

  // Step 1: Find CO's nearest node in the graph
  const coNode = findNearestNode(graph, coPosition, maxSnapDistance);
  if (!coNode) {
    console.error("[Connectivity] ❌ CO position is too far from routing graph!");
    return {
      allReachable: false,
      coNode: null,
      reachablePoints: [],
      unreachablePoints: demandPoints.map((pos) => ({
        position: pos,
        nearestGraphNode: null,
        reason: "too_far_from_graph" as const,
      })),
      infrastructureGaps: [],
      summary: {
        totalDemandPoints: demandPoints.length,
        reachableCount: 0,
        unreachableCount: demandPoints.length,
        componentCount: graph.metadata.componentCount,
        coComponentSize: 0,
      },
    };
  }

  console.log(`[Connectivity] CO snapped to node: ${coNode.id} (type: ${coNode.type})`);

  // Step 2: Find all connected components
  const components = findConnectedComponents(graph.nodes, graph.edges);
  console.log(`[Connectivity] Found ${components.length} components`);

  // Step 3: Identify which component the CO is in
  let coComponent: string[] = [];
  let coComponentIndex = -1;
  for (let i = 0; i < components.length; i++) {
    if (components[i].includes(coNode.id)) {
      coComponent = components[i];
      coComponentIndex = i;
      break;
    }
  }

  const coComponentSet = new Set(coComponent);
  console.log(
    `[Connectivity] CO is in component ${coComponentIndex} with ${coComponent.length} nodes`,
  );

  // Step 4: Check each demand point
  const reachablePoints: ConnectivityValidationResult["reachablePoints"] = [];
  const unreachablePoints: ConnectivityValidationResult["unreachablePoints"] = [];

  for (const demandPos of demandPoints) {
    const nearestNode = findNearestNode(graph, demandPos, maxSnapDistance);

    if (!nearestNode) {
      unreachablePoints.push({
        position: demandPos,
        nearestGraphNode: null,
        reason: "too_far_from_graph",
      });
      continue;
    }

    // Check if in same component as CO
    if (coComponentSet.has(nearestNode.id)) {
      // In same component - try to find actual path
      const pathResult = findShortestPath(graph, coNode.id, nearestNode.id, "underground");
      if (pathResult) {
        reachablePoints.push({
          position: demandPos,
          graphNode: nearestNode,
          distanceFromCO: pathResult.distance,
        });
      } else {
        // Same component but no path (shouldn't happen, but handle it)
        unreachablePoints.push({
          position: demandPos,
          nearestGraphNode: nearestNode,
          reason: "no_path",
        });
      }
    } else {
      // Different component - definitely unreachable
      unreachablePoints.push({
        position: demandPos,
        nearestGraphNode: nearestNode,
        reason: "different_component",
      });
    }
  }

  // Step 5: Identify gaps between components (for suggesting bridges)
  const infrastructureGaps: ConnectivityValidationResult["infrastructureGaps"] = [];

  if (components.length > 1) {
    // Find gaps between CO component and other components that have unreachable points
    const componentsWithUnreachable = new Set<number>();
    for (const unreachable of unreachablePoints) {
      if (unreachable.nearestGraphNode && unreachable.reason === "different_component") {
        for (let i = 0; i < components.length; i++) {
          if (components[i].includes(unreachable.nearestGraphNode.id)) {
            componentsWithUnreachable.add(i);
            break;
          }
        }
      }
    }

    // For each component with unreachable points, find shortest gap to CO component
    for (const otherComponentIndex of componentsWithUnreachable) {
      const otherComponent = components[otherComponentIndex];
      let shortestGap = Infinity;
      let bestFromNode: RoutingNode | null = null;
      let bestToNode: RoutingNode | null = null;

      // Find closest pair of nodes between CO component and other component
      for (const coNodeId of coComponent) {
        const coN = graph.nodes.get(coNodeId);
        if (!coN) continue;

        for (const otherNodeId of otherComponent) {
          const otherN = graph.nodes.get(otherNodeId);
          if (!otherN) continue;

          const dist = calculateDistance(coN.position, otherN.position);
          if (dist < shortestGap) {
            shortestGap = dist;
            bestFromNode = coN;
            bestToNode = otherN;
          }
        }
      }

      if (bestFromNode && bestToNode) {
        infrastructureGaps.push({
          fromComponent: coComponent.slice(0, 5), // Sample node IDs
          toComponent: otherComponent.slice(0, 5),
          shortestGapDistance: shortestGap,
          suggestedBridgeFrom: bestFromNode.position,
          suggestedBridgeTo: bestToNode.position,
        });
      }
    }
  }

  // Log summary
  const allReachable = unreachablePoints.length === 0;
  console.log(`[Connectivity] ${allReachable ? "✅" : "❌"} Validation complete:`);
  console.log(`[Connectivity]   - Reachable: ${reachablePoints.length}/${demandPoints.length}`);
  console.log(`[Connectivity]   - Unreachable: ${unreachablePoints.length}`);
  if (infrastructureGaps.length > 0) {
    console.log(`[Connectivity]   - Infrastructure gaps: ${infrastructureGaps.length}`);
    for (const gap of infrastructureGaps) {
      console.log(
        `[Connectivity]     Gap: ${gap.shortestGapDistance.toFixed(1)}m (suggest bridge)`,
      );
    }
  }

  return {
    allReachable,
    coNode,
    reachablePoints,
    unreachablePoints,
    infrastructureGaps,
    summary: {
      totalDemandPoints: demandPoints.length,
      reachableCount: reachablePoints.length,
      unreachableCount: unreachablePoints.length,
      componentCount: components.length,
      coComponentSize: coComponent.length,
    },
  };
}

/**
 * Create bridge edges to connect disconnected infrastructure components.
 * Call this after validateConnectivityForGeneration identifies gaps.
 *
 * @param graph The routing graph to modify (will add bridge edges)
 * @param gaps Infrastructure gaps from validation result
 * @param pathType Type of path for bridge edges (default: underground for new trenching)
 * @returns Updated graph with bridge edges added
 */
export function addBridgeEdgesForGaps(
  graph: RoutingGraph,
  gaps: ConnectivityValidationResult["infrastructureGaps"],
  pathType: RoutingEdge["pathType"] = "sidewalk",
): RoutingGraph {
  console.log(`[Connectivity] Adding ${gaps.length} bridge edges to connect components...`);

  for (const gap of gaps) {
    // Create nodes at bridge positions if they don't exist
    const fromNodeId = generateNodeId(gap.suggestedBridgeFrom[0], gap.suggestedBridgeFrom[1]);
    const toNodeId = generateNodeId(gap.suggestedBridgeTo[0], gap.suggestedBridgeTo[1]);

    // Add nodes if they don't exist
    if (!graph.nodes.has(fromNodeId)) {
      graph.nodes.set(fromNodeId, {
        id: fromNodeId,
        position: gap.suggestedBridgeFrom,
        type: "street",
      });
    }
    if (!graph.nodes.has(toNodeId)) {
      graph.nodes.set(toNodeId, {
        id: toNodeId,
        position: gap.suggestedBridgeTo,
        type: "street",
      });
    }

    // Create bridge edge
    const edgeId = `bridge_${fromNodeId}_${toNodeId}`;
    const bridgeEdge: RoutingEdge = {
      id: edgeId,
      fromNodeId,
      toNodeId,
      distance: gap.shortestGapDistance,
      geometry: [gap.suggestedBridgeFrom, gap.suggestedBridgeTo],
      pathType,
      costs: calculateEdgeCosts(gap.shortestGapDistance, pathType),
    };

    graph.edges.set(edgeId, bridgeEdge);

    // Update adjacency
    const fromAdj = graph.adjacency.get(fromNodeId) || [];
    fromAdj.push({
      nodeId: toNodeId,
      edgeId,
      distance: gap.shortestGapDistance,
      undergroundCost: bridgeEdge.costs.underground,
      aerialCost: bridgeEdge.costs.aerial,
    });
    graph.adjacency.set(fromNodeId, fromAdj);

    const toAdj = graph.adjacency.get(toNodeId) || [];
    toAdj.push({
      nodeId: fromNodeId,
      edgeId,
      distance: gap.shortestGapDistance,
      undergroundCost: bridgeEdge.costs.underground,
      aerialCost: bridgeEdge.costs.aerial,
    });
    graph.adjacency.set(toNodeId, toAdj);

    console.log(
      `[Connectivity] ✅ Added bridge edge: ${gap.shortestGapDistance.toFixed(1)}m (${pathType})`,
    );
  }

  // Update metadata
  graph.metadata.componentCount = findConnectedComponents(graph.nodes, graph.edges).length;
  console.log(`[Connectivity] Graph now has ${graph.metadata.componentCount} component(s)`);

  return graph;
}

/**
 * Bridge nearby conduit endpoints to handle tiny gaps in imported underground path data.
 * This creates conduit-type edges between endpoints of different conduits within threshold.
 *
 * Call this after building the routing graph to ensure distribution cables can route
 * through conduits even when there are small gaps in the imported data.
 *
 * @param graph The routing graph to modify
 * @param conduits Array of conduits with geometry
 * @param maxGapDistance Maximum gap distance to bridge (meters). Default: 20m
 * @returns Updated graph with conduit endpoint bridges
 */
export function bridgeConduitEndpoints(
  graph: RoutingGraph,
  conduits: Array<{ id: string; geometry: [number, number][] }>,
  maxGapDistance = 20,
): RoutingGraph {
  if (!conduits || conduits.length < 2) {
    return graph;
  }

  console.log(`[ConduitBridge] Checking ${conduits.length} conduits for endpoint gaps...`);

  // Collect all conduit endpoints (first and last point of each conduit)
  const endpoints: Array<{
    conduitId: string;
    position: [number, number];
    isStart: boolean;
    nodeId: string;
  }> = [];

  for (const conduit of conduits) {
    if (conduit.geometry.length < 2) continue;

    const startPos = conduit.geometry[0];
    const endPos = conduit.geometry[conduit.geometry.length - 1];

    endpoints.push({
      conduitId: conduit.id,
      position: startPos,
      isStart: true,
      nodeId: generateNodeId(startPos[0], startPos[1]),
    });
    endpoints.push({
      conduitId: conduit.id,
      position: endPos,
      isStart: false,
      nodeId: generateNodeId(endPos[0], endPos[1]),
    });
  }

  let bridgesAdded = 0;

  // Check each pair of endpoints from different conduits
  for (let i = 0; i < endpoints.length; i++) {
    for (let j = i + 1; j < endpoints.length; j++) {
      const ep1 = endpoints[i];
      const ep2 = endpoints[j];

      // Skip if same conduit
      if (ep1.conduitId === ep2.conduitId) continue;

      // Skip if same node (already merged)
      if (ep1.nodeId === ep2.nodeId) continue;

      // Calculate distance
      const distance = calculateDistance(ep1.position, ep2.position);

      // Skip if too far
      if (distance > maxGapDistance) continue;

      // Check if edge already exists
      const edgeId = `conduit_bridge_${ep1.nodeId}_${ep2.nodeId}`;
      const reverseId = `conduit_bridge_${ep2.nodeId}_${ep1.nodeId}`;
      if (graph.edges.has(edgeId) || graph.edges.has(reverseId)) continue;

      // Check if both nodes exist in graph
      if (!graph.nodes.has(ep1.nodeId) || !graph.nodes.has(ep2.nodeId)) {
        // Nodes might have been merged or clipped - try to find nearest existing nodes
        let fromId = ep1.nodeId;
        let toId = ep2.nodeId;

        if (!graph.nodes.has(fromId)) {
          const nearest = findNearestNode(graph, ep1.position);
          if (nearest && calculateDistance(nearest.position, ep1.position) < maxGapDistance) {
            fromId = nearest.id;
          } else {
            continue;
          }
        }
        if (!graph.nodes.has(toId)) {
          const nearest = findNearestNode(graph, ep2.position);
          if (nearest && calculateDistance(nearest.position, ep2.position) < maxGapDistance) {
            toId = nearest.id;
          } else {
            continue;
          }
        }

        // Create the bridge edge with found node IDs
        const bridgeEdge: RoutingEdge = {
          id: edgeId,
          fromNodeId: fromId,
          toNodeId: toId,
          distance,
          geometry: [ep1.position, ep2.position],
          pathType: "conduit", // Use conduit type for low cost (0.3x)
          costs: calculateEdgeCosts(distance, "conduit"),
        };

        graph.edges.set(edgeId, bridgeEdge);

        // Update adjacency
        const fromAdj = graph.adjacency.get(fromId) || [];
        fromAdj.push({
          nodeId: toId,
          edgeId,
          distance,
          undergroundCost: bridgeEdge.costs.underground,
          aerialCost: bridgeEdge.costs.aerial,
        });
        graph.adjacency.set(fromId, fromAdj);

        const toAdj = graph.adjacency.get(toId) || [];
        toAdj.push({
          nodeId: fromId,
          edgeId,
          distance,
          undergroundCost: bridgeEdge.costs.underground,
          aerialCost: bridgeEdge.costs.aerial,
        });
        graph.adjacency.set(toId, toAdj);

        bridgesAdded++;
        console.log(
          `[ConduitBridge] ✅ Bridged ${ep1.conduitId} → ${ep2.conduitId}: ${distance.toFixed(1)}m`,
        );
      } else {
        // Both nodes exist - create the bridge edge directly
        const bridgeEdge: RoutingEdge = {
          id: edgeId,
          fromNodeId: ep1.nodeId,
          toNodeId: ep2.nodeId,
          distance,
          geometry: [ep1.position, ep2.position],
          pathType: "conduit",
          costs: calculateEdgeCosts(distance, "conduit"),
        };

        graph.edges.set(edgeId, bridgeEdge);

        // Update adjacency
        const fromAdj = graph.adjacency.get(ep1.nodeId) || [];
        fromAdj.push({
          nodeId: ep2.nodeId,
          edgeId,
          distance,
          undergroundCost: bridgeEdge.costs.underground,
          aerialCost: bridgeEdge.costs.aerial,
        });
        graph.adjacency.set(ep1.nodeId, fromAdj);

        const toAdj = graph.adjacency.get(ep2.nodeId) || [];
        toAdj.push({
          nodeId: ep1.nodeId,
          edgeId,
          distance,
          undergroundCost: bridgeEdge.costs.underground,
          aerialCost: bridgeEdge.costs.aerial,
        });
        graph.adjacency.set(ep2.nodeId, toAdj);

        bridgesAdded++;
        console.log(
          `[ConduitBridge] ✅ Bridged ${ep1.conduitId} → ${ep2.conduitId}: ${distance.toFixed(1)}m`,
        );
      }
    }
  }

  if (bridgesAdded > 0) {
    console.log(`[ConduitBridge] Added ${bridgesAdded} conduit bridge edges`);
  } else {
    console.log(`[ConduitBridge] No gaps found within ${maxGapDistance}m threshold`);
  }

  return graph;
}

/**
 * Bridge conduit nodes to the street network to ensure connectivity.
 * This allows Dijkstra to find paths that utilize imported underground infrastructure.
 *
 * THE PROBLEM:
 * - Conduits typically run 3-8m from road centerlines (under sidewalks, easements)
 * - Street nodes are offset 4m from centerline (sidewalk offset)
 * - The 15m merge threshold may not automatically merge conduit nodes with street nodes
 * - This creates DISCONNECTED graph components: one for streets, one for conduits
 * - Dijkstra can't find paths between components → falls back to OSRM → cables through buildings
 *
 * THE SOLUTION:
 * 1. Find conduit endpoints (first/last node of each conduit) and orphan conduit nodes
 * 2. For each, find the nearest street/intersection node within maxBridgeDistance
 * 3. Create bridge edges (road_crossing type, 3.0x cost) to connect them
 * 4. Skip bridges that would cross buildings
 *
 * @param graph - The routing graph with conduit and street nodes
 * @param maxBridgeDistance - Maximum distance for bridges (default: 30m)
 * @param buildingIndex - Optional spatial index for building crossing checks
 * @returns Updated graph with conduit-to-street bridge edges
 */
export function bridgeConduitToStreetNetwork(
  graph: RoutingGraph,
  maxBridgeDistance = 30,
  buildingIndex?: Map<string, BuildingPolygon[]>,
): RoutingGraph {
  // Find all conduit_access nodes
  const conduitNodes: RoutingNode[] = [];
  const streetNodes: RoutingNode[] = [];

  for (const node of graph.nodes.values()) {
    if (node.type === "conduit_access") {
      conduitNodes.push(node);
    } else if (node.type === "street" || node.type === "intersection") {
      streetNodes.push(node);
    }
  }

  if (conduitNodes.length === 0) {
    console.log("[ConduitToStreet] No conduit nodes found, skipping");
    return graph;
  }

  if (streetNodes.length === 0) {
    console.log("[ConduitToStreet] No street nodes found, skipping");
    return graph;
  }

  console.log(
    `[ConduitToStreet] Bridging ${conduitNodes.length} conduit nodes to ${streetNodes.length} street nodes (max ${maxBridgeDistance}m)`,
  );

  // Identify conduit endpoints and orphan nodes (low connectivity)
  const conduitEndpointsAndOrphans = new Set<string>();

  for (const conduitNode of conduitNodes) {
    const adjacency = graph.adjacency.get(conduitNode.id) || [];

    // Count how many adjacent nodes are conduit_access type
    let conduitNeighbors = 0;
    let streetNeighbors = 0;

    for (const adj of adjacency) {
      const neighborNode = graph.nodes.get(adj.nodeId);
      if (neighborNode?.type === "conduit_access") {
        conduitNeighbors++;
      } else if (neighborNode?.type === "street" || neighborNode?.type === "intersection") {
        streetNeighbors++;
      }
    }

    // A conduit node needs bridging if:
    // 1. It's an endpoint (only 1 conduit neighbor) OR
    // 2. It's an orphan (0 neighbors) OR
    // 3. It has no street neighbors yet
    if (conduitNeighbors <= 1 || streetNeighbors === 0) {
      conduitEndpointsAndOrphans.add(conduitNode.id);
    }
  }

  console.log(
    `[ConduitToStreet] Found ${conduitEndpointsAndOrphans.size} conduit endpoints/orphans to bridge`,
  );

  let bridgesAdded = 0;

  // For each conduit endpoint/orphan, find nearest street node and create bridge
  for (const conduitNodeId of conduitEndpointsAndOrphans) {
    const conduitNode = graph.nodes.get(conduitNodeId);
    if (!conduitNode) continue;

    // Check if this node already has a street connection
    const currentAdj = graph.adjacency.get(conduitNodeId) || [];
    const hasStreetConnection = currentAdj.some((adj) => {
      const neighbor = graph.nodes.get(adj.nodeId);
      return neighbor?.type === "street" || neighbor?.type === "intersection";
    });

    if (hasStreetConnection) {
      continue; // Already connected to street network
    }

    // Find nearest street node
    let nearestStreetNode: RoutingNode | null = null;
    let nearestDistance = maxBridgeDistance;

    for (const streetNode of streetNodes) {
      const distance = calculateDistance(conduitNode.position, streetNode.position);

      if (distance < nearestDistance) {
        // Check if bridge would cross a building
        if (
          buildingIndex &&
          edgeCrossesBuilding(conduitNode.position, streetNode.position, buildingIndex)
        ) {
          continue; // Skip - would cross building
        }

        nearestDistance = distance;
        nearestStreetNode = streetNode;
      }
    }

    if (!nearestStreetNode) {
      continue; // No valid street node within range
    }

    // Check if edge already exists
    const edgeId = `conduit_street_bridge_${conduitNodeId}_${nearestStreetNode.id}`;
    const reverseId = `conduit_street_bridge_${nearestStreetNode.id}_${conduitNodeId}`;

    if (graph.edges.has(edgeId) || graph.edges.has(reverseId)) {
      continue; // Bridge already exists
    }

    // Create bridge edge with road_crossing cost (3.0x - represents transition between infrastructure types)
    const bridgeEdge: RoutingEdge = {
      id: edgeId,
      fromNodeId: conduitNodeId,
      toNodeId: nearestStreetNode.id,
      distance: nearestDistance,
      geometry: [conduitNode.position, nearestStreetNode.position],
      pathType: "road_crossing", // Use road_crossing for infrastructure transition
      costs: calculateEdgeCosts(nearestDistance, "road_crossing"),
    };

    graph.edges.set(edgeId, bridgeEdge);

    // Update adjacency (bidirectional)
    const fromAdj = graph.adjacency.get(conduitNodeId) || [];
    fromAdj.push({
      nodeId: nearestStreetNode.id,
      edgeId,
      distance: nearestDistance,
      undergroundCost: bridgeEdge.costs.underground,
      aerialCost: bridgeEdge.costs.aerial,
    });
    graph.adjacency.set(conduitNodeId, fromAdj);

    const toAdj = graph.adjacency.get(nearestStreetNode.id) || [];
    toAdj.push({
      nodeId: conduitNodeId,
      edgeId,
      distance: nearestDistance,
      undergroundCost: bridgeEdge.costs.underground,
      aerialCost: bridgeEdge.costs.aerial,
    });
    graph.adjacency.set(nearestStreetNode.id, toAdj);

    bridgesAdded++;

    console.log(
      `[ConduitToStreet] ✅ Bridged conduit ${conduitNodeId.slice(0, 15)}... → street ${nearestStreetNode.id.slice(0, 15)}...: ${nearestDistance.toFixed(1)}m`,
    );
  }

  if (bridgesAdded > 0) {
    console.log(`[ConduitToStreet] Added ${bridgesAdded} conduit-to-street bridge edges`);
  } else {
    console.log(
      `[ConduitToStreet] No bridges needed (conduits already connected or no valid positions within ${maxBridgeDistance}m)`,
    );
  }

  return graph;
}

// =============================================================================
// JSON EXPORT/IMPORT FOR GEOCODEBASE
// =============================================================================

/**
 * JSON-serializable routing graph structure for DataStore
 * This enables AI agents to read/query routing options without Map structures
 */
export interface RoutingGraphJSON {
  version: "1.0";
  generated_at: string;
  metadata: {
    nodeCount: number;
    edgeCount: number;
    componentCount: number;
    totalStreetLength: number;
    boundingBox?: [number, number, number, number];
    useSidewalkOffset?: boolean;
  };
  costMultipliers: typeof EDGE_COST_MULTIPLIERS;
  nodes: Array<{
    id: string;
    position: [number, number];
    type: RoutingNode["type"];
    streetName?: string;
    streetIds?: string[];
    streetSide?: "left" | "right";
    centerlinePosition?: [number, number];
  }>;
  edges: Array<{
    id: string;
    fromNodeId: string;
    toNodeId: string;
    distance: number;
    geometry: Position[];
    pathType: RoutingEdge["pathType"];
    streetName?: string;
    streetSide?: "left" | "right";
    costs: {
      underground: number;
      aerial: number;
    };
  }>;
  adjacency: Record<
    string,
    Array<{
      nodeId: string;
      edgeId: string;
      distance: number;
      undergroundCost: number;
      aerialCost: number;
    }>
  >;
}

/**
 * Export a RoutingGraph to JSON-serializable format
 * Used for DataStore routing-graph.json generation
 */
export function exportRoutingGraphToJSON(graph: RoutingGraph): RoutingGraphJSON {
  // Convert Map<string, RoutingNode> to array
  const nodesArray = Array.from(graph.nodes.entries()).map(([id, node]) => ({
    id,
    position: node.position,
    type: node.type,
    streetName: node.streetName,
    streetIds: node.streetIds,
    streetSide: node.streetSide,
    centerlinePosition: node.centerlinePosition,
  }));

  // Convert Map<string, RoutingEdge> to array
  const edgesArray = Array.from(graph.edges.entries()).map(([id, edge]) => ({
    id,
    fromNodeId: edge.fromNodeId,
    toNodeId: edge.toNodeId,
    distance: edge.distance,
    geometry: edge.geometry,
    pathType: edge.pathType,
    streetName: edge.streetName,
    streetSide: edge.streetSide,
    costs: edge.costs,
  }));

  // Convert Map<string, AdjacencyEntry[]> to Record
  const adjacencyRecord: Record<
    string,
    Array<{
      nodeId: string;
      edgeId: string;
      distance: number;
      undergroundCost: number;
      aerialCost: number;
    }>
  > = {};

  for (const [nodeId, entries] of graph.adjacency) {
    adjacencyRecord[nodeId] = entries.map((e) => ({
      nodeId: e.nodeId,
      edgeId: e.edgeId,
      distance: e.distance,
      undergroundCost: e.undergroundCost,
      aerialCost: e.aerialCost,
    }));
  }

  return {
    version: "1.0",
    generated_at: new Date().toISOString(),
    metadata: {
      nodeCount: graph.metadata.nodeCount,
      edgeCount: graph.metadata.edgeCount,
      componentCount: graph.metadata.componentCount,
      totalStreetLength: graph.metadata.totalStreetLength,
      boundingBox: graph.metadata.boundingBox,
      useSidewalkOffset: graph.metadata.useSidewalkOffset,
    },
    costMultipliers: EDGE_COST_MULTIPLIERS,
    nodes: nodesArray,
    edges: edgesArray,
    adjacency: adjacencyRecord,
  };
}

/**
 * Import a RoutingGraph from JSON format
 * Reconstructs Map structures from JSON-serialized data
 */
export function importRoutingGraphFromJSON(json: RoutingGraphJSON): RoutingGraph {
  // Reconstruct Map<string, RoutingNode>
  const nodes = new Map<string, RoutingNode>();
  for (const node of json.nodes) {
    nodes.set(node.id, {
      id: node.id,
      position: node.position,
      type: node.type,
      streetName: node.streetName,
      streetIds: node.streetIds,
      streetSide: node.streetSide,
      centerlinePosition: node.centerlinePosition,
    });
  }

  // Reconstruct Map<string, RoutingEdge>
  const edges = new Map<string, RoutingEdge>();
  for (const edge of json.edges) {
    edges.set(edge.id, {
      id: edge.id,
      fromNodeId: edge.fromNodeId,
      toNodeId: edge.toNodeId,
      distance: edge.distance,
      geometry: edge.geometry,
      pathType: edge.pathType,
      streetName: edge.streetName,
      streetSide: edge.streetSide,
      costs: edge.costs,
    });
  }

  // Reconstruct Map<string, AdjacencyEntry[]>
  const adjacency = new Map<string, AdjacencyEntry[]>();
  for (const [nodeId, entries] of Object.entries(json.adjacency)) {
    adjacency.set(
      nodeId,
      entries.map((e) => ({
        nodeId: e.nodeId,
        edgeId: e.edgeId,
        distance: e.distance,
        undergroundCost: e.undergroundCost,
        aerialCost: e.aerialCost,
      })),
    );
  }

  return {
    nodes,
    edges,
    adjacency,
    metadata: {
      createdAt: new Date(json.generated_at),
      nodeCount: json.metadata.nodeCount,
      edgeCount: json.metadata.edgeCount,
      componentCount: json.metadata.componentCount,
      totalStreetLength: json.metadata.totalStreetLength,
      boundingBox: json.metadata.boundingBox ?? [0, 0, 0, 0],
      useSidewalkOffset: json.metadata.useSidewalkOffset ?? false,
    },
  };
}
