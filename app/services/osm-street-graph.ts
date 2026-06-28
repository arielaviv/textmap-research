/**
 * OSM Street Graph Service
 *
 * Loads pre-downloaded OSM street network data for cities and provides
 * local graph-based routing for cable path planning.
 *
 * Usage:
 *   const service = new OSMStreetGraphService();
 *   await service.loadCity("tel-aviv");
 *   const path = service.findPath(startPos, endPos);
 */

import * as turf from "@turf/turf";
import type { Feature, Polygon } from "geojson";

// Graph node (intersection or endpoint)
export interface GraphNode {
  id: string;
  position: [number, number]; // [lon, lat]
  connections: string[]; // IDs of connected edges
}

// Graph edge (street segment between nodes)
export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  name?: string;
  type: string;
  distance: number;
  coordinates: [number, number][];
  oneway: boolean;
}

// Street segment for visualization
export interface StreetSegment {
  id: string;
  name?: string;
  type: string;
  coordinates: [number, number][];
  oneway: boolean;
  lanes?: number;
  surface?: string;
}

export interface CityStreetData {
  city: string;
  displayName: string;
  updated: string;
  bbox: {
    south: number;
    west: number;
    north: number;
    east: number;
  };
  stats: {
    segments: number;
    nodes: number;
    edges: number;
    totalLength: number;
  };
  segments: StreetSegment[];
  graph: {
    nodes: Record<string, GraphNode>;
    edges: GraphEdge[];
  };
}

export interface PathResult {
  found: boolean;
  distance: number;
  coordinates: [number, number][];
  edges: string[];
}

// Spatial index for nodes
interface NodeSpatialIndex {
  cellSize: number;
  cells: Map<string, string[]>; // Cell key -> node IDs
}

export class OSMStreetGraphService {
  private loadedCities: Map<string, CityStreetData> = new Map();
  private nodeIndexes: Map<string, NodeSpatialIndex> = new Map();
  private edgesByNode: Map<string, Map<string, GraphEdge[]>> = new Map(); // city -> nodeId -> edges

  /**
   * Load city street data from JSON file
   */
  async loadCity(cityKey: string): Promise<boolean> {
    if (this.loadedCities.has(cityKey)) {
      console.log(`[OSM Streets] City ${cityKey} already loaded`);
      return true;
    }

    try {
      let data: CityStreetData;

      if (typeof window !== "undefined") {
        // Browser context - fetch via the R2-backed proxy route.
        const response = await fetch(`/api/osm/streets/${cityKey}`);
        if (!response.ok) {
          console.error(`[OSM Streets] Failed to load ${cityKey}: ${response.status}`);
          return false;
        }
        data = await response.json();
      } else {
        // Server context - read the city extract from object storage (R2).
        const { getObjectText } = await import("@/lib/datastore/r2-upload");
        const content = await getObjectText(`osm/streets/${cityKey}.json`);
        data = JSON.parse(content);
      }

      this.loadedCities.set(cityKey, data);
      this.buildNodeIndex(cityKey, data.graph.nodes);
      this.buildEdgeIndex(cityKey, data.graph);

      console.log(
        `[OSM Streets] Loaded ${data.stats.nodes} nodes, ${data.stats.edges} edges for ${data.displayName}`,
      );
      return true;
    } catch (error) {
      console.error(`[OSM Streets] Error loading ${cityKey}:`, error);
      return false;
    }
  }

  /**
   * Build spatial index for graph nodes
   */
  private buildNodeIndex(cityKey: string, nodes: Record<string, GraphNode>): void {
    const cellSize = 0.001; // ~100m cells
    const cells = new Map<string, string[]>();

    for (const [nodeId, node] of Object.entries(nodes)) {
      const cellKey = this.getCellKey(node.position[0], node.position[1], cellSize);
      if (!cells.has(cellKey)) {
        cells.set(cellKey, []);
      }
      cells.get(cellKey)!.push(nodeId);
    }

    this.nodeIndexes.set(cityKey, { cellSize, cells });
  }

  /**
   * Build edge lookup by node
   */
  private buildEdgeIndex(
    cityKey: string,
    graph: { nodes: Record<string, GraphNode>; edges: GraphEdge[] },
  ): void {
    const edgeMap = new Map<string, GraphEdge[]>();

    for (const edge of graph.edges) {
      // Add edge to source node
      if (!edgeMap.has(edge.source)) {
        edgeMap.set(edge.source, []);
      }
      edgeMap.get(edge.source)!.push(edge);

      // Add edge to target node (for bidirectional traversal)
      if (!edge.oneway) {
        if (!edgeMap.has(edge.target)) {
          edgeMap.set(edge.target, []);
        }
        edgeMap.get(edge.target)!.push(edge);
      }
    }

    this.edgesByNode.set(cityKey, edgeMap);
  }

  private getCellKey(lon: number, lat: number, cellSize: number): string {
    return `${Math.floor(lon / cellSize)},${Math.floor(lat / cellSize)}`;
  }

  /**
   * Find which city a position is in
   */
  isInLoadedCity(position: [number, number]): string | null {
    const [lon, lat] = position;

    for (const [key, data] of this.loadedCities) {
      if (
        lat >= data.bbox.south &&
        lat <= data.bbox.north &&
        lon >= data.bbox.west &&
        lon <= data.bbox.east
      ) {
        return key;
      }
    }
    return null;
  }

  /**
   * Find nearest graph node to a position
   */
  findNearestNode(position: [number, number], maxRadius: number = 100): string | null {
    const cityKey = this.isInLoadedCity(position);
    if (!cityKey) return null;

    const cityData = this.loadedCities.get(cityKey);
    const index = this.nodeIndexes.get(cityKey);
    if (!cityData || !index) return null;

    const [lon, lat] = position;

    // Search in expanding radius
    let nearestId: string | null = null;
    let nearestDist = Infinity;

    // Get cells in search radius
    const radiusDegrees = maxRadius / 111000; // ~111km per degree
    const minCellX = Math.floor((lon - radiusDegrees) / index.cellSize);
    const maxCellX = Math.floor((lon + radiusDegrees) / index.cellSize);
    const minCellY = Math.floor((lat - radiusDegrees) / index.cellSize);
    const maxCellY = Math.floor((lat + radiusDegrees) / index.cellSize);

    for (let x = minCellX; x <= maxCellX; x++) {
      for (let y = minCellY; y <= maxCellY; y++) {
        const cellKey = `${x},${y}`;
        const nodeIds = index.cells.get(cellKey);
        if (!nodeIds) continue;

        for (const nodeId of nodeIds) {
          const node = cityData.graph.nodes[nodeId];
          if (!node) continue;

          const dist = this.calculateDistance(lon, lat, node.position[0], node.position[1]);
          if (dist < nearestDist && dist <= maxRadius) {
            nearestDist = dist;
            nearestId = nodeId;
          }
        }
      }
    }

    return nearestId;
  }

  /**
   * Find shortest path between two positions using Dijkstra's algorithm
   */
  findPath(start: [number, number], end: [number, number]): PathResult {
    const cityKey = this.isInLoadedCity(start);
    if (!cityKey || this.isInLoadedCity(end) !== cityKey) {
      return { found: false, distance: 0, coordinates: [], edges: [] };
    }

    const cityData = this.loadedCities.get(cityKey);
    const edgeMap = this.edgesByNode.get(cityKey);
    if (!cityData || !edgeMap) {
      return { found: false, distance: 0, coordinates: [], edges: [] };
    }

    // Find nearest nodes to start and end
    const startNode = this.findNearestNode(start, 200);
    const endNode = this.findNearestNode(end, 200);

    if (!startNode || !endNode) {
      console.log(`[OSM Streets] Could not find nodes near start or end`);
      return { found: false, distance: 0, coordinates: [], edges: [] };
    }

    if (startNode === endNode) {
      return {
        found: true,
        distance: 0,
        coordinates: [start, end],
        edges: [],
      };
    }

    // Dijkstra's algorithm
    const distances = new Map<string, number>();
    const previous = new Map<string, { nodeId: string; edge: GraphEdge }>();
    const unvisited = new Set<string>();

    // Initialize
    for (const nodeId of Object.keys(cityData.graph.nodes)) {
      distances.set(nodeId, Infinity);
      unvisited.add(nodeId);
    }
    distances.set(startNode, 0);

    while (unvisited.size > 0) {
      // Find unvisited node with smallest distance
      let currentNode: string | null = null;
      let currentDist = Infinity;

      for (const nodeId of unvisited) {
        const dist = distances.get(nodeId) || Infinity;
        if (dist < currentDist) {
          currentDist = dist;
          currentNode = nodeId;
        }
      }

      if (!currentNode || currentDist === Infinity) break;
      if (currentNode === endNode) break;

      unvisited.delete(currentNode);

      // Update distances to neighbors
      const edges = edgeMap.get(currentNode) || [];
      for (const edge of edges) {
        const neighborId = edge.source === currentNode ? edge.target : edge.source;

        // Skip if wrong direction on one-way
        if (edge.oneway && edge.target === currentNode) continue;

        if (!unvisited.has(neighborId)) continue;

        const newDist = currentDist + edge.distance;
        if (newDist < (distances.get(neighborId) || Infinity)) {
          distances.set(neighborId, newDist);
          previous.set(neighborId, { nodeId: currentNode, edge });
        }
      }
    }

    // Reconstruct path
    if (!previous.has(endNode) && startNode !== endNode) {
      console.log(`[OSM Streets] No path found from ${startNode} to ${endNode}`);
      return { found: false, distance: 0, coordinates: [], edges: [] };
    }

    const pathEdges: GraphEdge[] = [];
    let current = endNode;

    while (previous.has(current)) {
      const prev = previous.get(current)!;
      pathEdges.unshift(prev.edge);
      current = prev.nodeId;
    }

    // Build coordinate path
    const coordinates: [number, number][] = [start];

    for (const edge of pathEdges) {
      // Add edge coordinates (handle direction)
      const edgeCoords = [...edge.coordinates];
      const firstCoord = edgeCoords[0];
      const lastCoord = edgeCoords[edgeCoords.length - 1];

      // Check if we need to reverse
      if (coordinates.length > 0) {
        const lastPoint = coordinates[coordinates.length - 1];
        const distToFirst = this.calculateDistance(
          lastPoint[0],
          lastPoint[1],
          firstCoord[0],
          firstCoord[1],
        );
        const distToLast = this.calculateDistance(
          lastPoint[0],
          lastPoint[1],
          lastCoord[0],
          lastCoord[1],
        );

        if (distToLast < distToFirst) {
          edgeCoords.reverse();
        }
      }

      // Skip first point if it's too close to last added
      const startIdx =
        coordinates.length > 0 &&
        this.calculateDistance(
          coordinates[coordinates.length - 1][0],
          coordinates[coordinates.length - 1][1],
          edgeCoords[0][0],
          edgeCoords[0][1],
        ) < 5
          ? 1
          : 0;

      for (let i = startIdx; i < edgeCoords.length; i++) {
        coordinates.push(edgeCoords[i]);
      }
    }

    coordinates.push(end);

    const totalDistance = distances.get(endNode) || 0;

    console.log(
      `[OSM Streets] Found path: ${pathEdges.length} edges, ${totalDistance.toFixed(0)}m`,
    );

    return {
      found: true,
      distance: totalDistance,
      coordinates,
      edges: pathEdges.map((e) => e.id),
    };
  }

  /**
   * Get street segments within a polygon for visualization
   */
  getStreetsInPolygon(polygon: Feature<Polygon>): StreetSegment[] {
    const bbox = turf.bbox(polygon);
    const [minLon, minLat, maxLon, maxLat] = bbox;

    const centerLon = (minLon + maxLon) / 2;
    const centerLat = (minLat + maxLat) / 2;
    const cityKey = this.isInLoadedCity([centerLon, centerLat]);

    if (!cityKey) return [];

    const cityData = this.loadedCities.get(cityKey);
    if (!cityData) return [];

    // Street types to exclude — service roads (parking lots, driveways) and
    // unclassified roads (minor unnamed paths) inflate counts significantly.
    const EXCLUDED_TYPES = new Set(["service", "unclassified"]);

    const results: StreetSegment[] = [];

    for (const segment of cityData.segments) {
      // Skip service/unclassified roads
      if (EXCLUDED_TYPES.has(segment.type)) continue;

      // Quick bbox rejection first
      let inBbox = false;
      for (const coord of segment.coordinates) {
        if (coord[0] >= minLon && coord[0] <= maxLon && coord[1] >= minLat && coord[1] <= maxLat) {
          inBbox = true;
          break;
        }
      }
      if (!inBbox) continue;

      // Actual polygon containment check — require at least one coordinate
      // to be inside the polygon (not just inside the bounding box)
      let insidePolygon = false;
      for (const coord of segment.coordinates) {
        if (turf.booleanPointInPolygon(turf.point(coord), polygon)) {
          insidePolygon = true;
          break;
        }
      }

      if (insidePolygon) {
        results.push(segment);
      }
    }

    return results;
  }

  /**
   * Calculate distance between two points in meters
   */
  private calculateDistance(lon1: number, lat1: number, lon2: number, lat2: number): number {
    const R = 6371000;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos((lat1 * Math.PI) / 180) *
        Math.cos((lat2 * Math.PI) / 180) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  /**
   * Get all street segments from all loaded cities.
   * Returns segments with 'geometry' property for compatibility with Explore agent.
   * Filters by highway types suitable for equipment placement.
   */
  getAllStreetSegments(): Array<{ id: string; name?: string; geometry: [number, number][] }> {
    // Only include street types suitable for FTTH equipment placement
    const SUITABLE_HIGHWAY_TYPES = new Set([
      "primary",
      "secondary",
      "tertiary",
      "residential",
      "living_street",
      "service",
      "unclassified",
    ]);

    const allSegments: Array<{ id: string; name?: string; geometry: [number, number][] }> = [];
    let skippedCount = 0;

    for (const cityData of this.loadedCities.values()) {
      for (const segment of cityData.segments) {
        // Filter out footways, pedestrian paths, cycleways, motorways
        if (!SUITABLE_HIGHWAY_TYPES.has(segment.type)) {
          skippedCount++;
          continue;
        }

        allSegments.push({
          id: segment.id,
          name: segment.name,
          geometry: segment.coordinates,
        });
      }
    }

    console.log(
      `[OSM Streets] getAllStreetSegments() returning ${allSegments.length} segments (filtered ${skippedCount} unsuitable types)`,
    );
    return allSegments;
  }

  /**
   * Get statistics
   */
  getStats(): {
    loadedCities: string[];
    totalNodes: number;
    totalEdges: number;
    totalLengthKm: number;
  } {
    let totalNodes = 0;
    let totalEdges = 0;
    let totalLengthKm = 0;

    for (const data of this.loadedCities.values()) {
      totalNodes += data.stats.nodes;
      totalEdges += data.stats.edges;
      totalLengthKm += data.stats.totalLength;
    }

    return {
      loadedCities: [...this.loadedCities.keys()],
      totalNodes,
      totalEdges,
      totalLengthKm,
    };
  }

  /**
   * Clear all loaded data
   */
  clear(): void {
    this.loadedCities.clear();
    this.nodeIndexes.clear();
    this.edgesByNode.clear();
  }
}

// Singleton instance
export const osmStreetGraph = new OSMStreetGraphService();
