/**
 * OSM Building Lookup Service
 *
 * Loads pre-downloaded OSM building data for cities and provides
 * fast local building lookup for service area analysis.
 *
 * Usage:
 *   const service = new OSMBuildingLookupService();
 *   await service.loadCity("tel-aviv");
 *   const buildings = service.getBuildingsInPolygon(polygon);
 */

import * as turf from "@turf/turf";
import type { Feature, Polygon } from "geojson";

export interface BuildingEntry {
  id: string;
  center: [number, number]; // [lon, lat]
  polygon: [number, number][]; // Array of [lon, lat] points
  type: string;
  levels?: number;
  units?: number;
  address?: {
    street?: string;
    number?: string;
  };
}

export interface CityBuildingData {
  city: string;
  displayName: string;
  updated: string;
  bbox: {
    south: number;
    west: number;
    north: number;
    east: number;
  };
  count: number;
  buildings: BuildingEntry[];
}

export interface BuildingLookupResult {
  id: string;
  position: [number, number];
  type: string;
  levels?: number;
  units?: number;
  address?: string;
  polygon?: [number, number][];
}

// Simple grid-based spatial index
interface SpatialIndex {
  cellSize: number;
  cells: Map<string, BuildingEntry[]>;
}

export class OSMBuildingLookupService {
  private loadedCities: Map<string, CityBuildingData> = new Map();
  private spatialIndexes: Map<string, SpatialIndex> = new Map();

  /**
   * Load city building data from JSON file
   */
  async loadCity(cityKey: string): Promise<boolean> {
    if (this.loadedCities.has(cityKey)) {
      console.log(`[OSM Buildings] City ${cityKey} already loaded`);
      return true;
    }

    try {
      let data: CityBuildingData;

      if (typeof window !== "undefined") {
        // Browser context - fetch via the R2-backed proxy route (public/ is
        // excluded from the serverless bundle, so we never serve from /data).
        const response = await fetch(`/api/osm/buildings/${cityKey}`);
        if (!response.ok) {
          console.error(`[OSM Buildings] Failed to load ${cityKey}: ${response.status}`);
          return false;
        }
        data = await response.json();
      } else {
        // Server context - read the city extract from object storage (R2).
        const { getObjectText } = await import("@/lib/datastore/r2-upload");
        const content = await getObjectText(`osm/buildings/${cityKey}.json`);
        data = JSON.parse(content);
      }

      this.loadedCities.set(cityKey, data);
      this.buildSpatialIndex(cityKey, data.buildings);

      console.log(`[OSM Buildings] Loaded ${data.count} buildings for ${data.displayName}`);
      return true;
    } catch (error) {
      console.error(`[OSM Buildings] Error loading ${cityKey}:`, error);
      return false;
    }
  }

  /**
   * Build spatial index for faster polygon lookups
   */
  private buildSpatialIndex(cityKey: string, buildings: BuildingEntry[]): void {
    const cellSize = 0.002; // ~200m cells
    const cells = new Map<string, BuildingEntry[]>();

    for (const building of buildings) {
      const cellKey = this.getCellKey(building.center[0], building.center[1], cellSize);
      if (!cells.has(cellKey)) {
        cells.set(cellKey, []);
      }
      cells.get(cellKey)!.push(building);
    }

    this.spatialIndexes.set(cityKey, { cellSize, cells });
    console.log(`[OSM Buildings] Built spatial index with ${cells.size} cells for ${cityKey}`);
  }

  private getCellKey(lon: number, lat: number, cellSize: number): string {
    const cellX = Math.floor(lon / cellSize);
    const cellY = Math.floor(lat / cellSize);
    return `${cellX},${cellY}`;
  }

  /**
   * Get all cell keys that intersect with a bounding box
   */
  private getCellKeysForBbox(
    minLon: number,
    minLat: number,
    maxLon: number,
    maxLat: number,
    cellSize: number,
  ): string[] {
    const minCellX = Math.floor(minLon / cellSize);
    const maxCellX = Math.floor(maxLon / cellSize);
    const minCellY = Math.floor(minLat / cellSize);
    const maxCellY = Math.floor(maxLat / cellSize);

    const keys: string[] = [];
    for (let x = minCellX; x <= maxCellX; x++) {
      for (let y = minCellY; y <= maxCellY; y++) {
        keys.push(`${x},${y}`);
      }
    }
    return keys;
  }

  /**
   * Check if a coordinate is within any loaded city's bounding box
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
   * Get buildings within a polygon using spatial index
   */
  getBuildingsInPolygon(polygon: Feature<Polygon>): BuildingLookupResult[] {
    const bbox = turf.bbox(polygon);
    const [minLon, minLat, maxLon, maxLat] = bbox;

    // Find which city this polygon is in
    const centerLon = (minLon + maxLon) / 2;
    const centerLat = (minLat + maxLat) / 2;
    const cityKey = this.isInLoadedCity([centerLon, centerLat]);

    if (!cityKey) {
      console.log(`[OSM Buildings] Polygon center not in any loaded city`);
      return [];
    }

    const cityData = this.loadedCities.get(cityKey);
    const index = this.spatialIndexes.get(cityKey);

    if (!cityData || !index) {
      return [];
    }

    // Get candidate buildings from spatial index
    const cellKeys = this.getCellKeysForBbox(minLon, minLat, maxLon, maxLat, index.cellSize);
    const candidates: BuildingEntry[] = [];

    for (const key of cellKeys) {
      const cellBuildings = index.cells.get(key);
      if (cellBuildings) {
        candidates.push(...cellBuildings);
      }
    }

    // Filter candidates that are actually inside the polygon
    const results: BuildingLookupResult[] = [];

    for (const building of candidates) {
      const point = turf.point(building.center);

      if (turf.booleanPointInPolygon(point, polygon)) {
        results.push({
          id: building.id,
          position: building.center,
          type: building.type,
          levels: building.levels,
          units: building.units,
          address: building.address
            ? `${building.address.number || ""} ${building.address.street || ""}`.trim()
            : undefined,
          polygon: building.polygon.length > 0 ? building.polygon : undefined,
        });
      }
    }

    console.log(
      `[OSM Buildings] Found ${results.length} buildings in polygon (from ${candidates.length} candidates)`,
    );

    return results;
  }

  /**
   * Get buildings within a bounding box (faster than polygon)
   */
  getBuildingsInBbox(
    minLon: number,
    minLat: number,
    maxLon: number,
    maxLat: number,
  ): BuildingLookupResult[] {
    const centerLon = (minLon + maxLon) / 2;
    const centerLat = (minLat + maxLat) / 2;
    const cityKey = this.isInLoadedCity([centerLon, centerLat]);

    if (!cityKey) {
      return [];
    }

    const index = this.spatialIndexes.get(cityKey);
    if (!index) {
      return [];
    }

    const cellKeys = this.getCellKeysForBbox(minLon, minLat, maxLon, maxLat, index.cellSize);
    const results: BuildingLookupResult[] = [];

    for (const key of cellKeys) {
      const cellBuildings = index.cells.get(key);
      if (cellBuildings) {
        for (const building of cellBuildings) {
          const [lon, lat] = building.center;
          if (lon >= minLon && lon <= maxLon && lat >= minLat && lat <= maxLat) {
            results.push({
              id: building.id,
              position: building.center,
              type: building.type,
              levels: building.levels,
              units: building.units,
              address: building.address
                ? `${building.address.number || ""} ${building.address.street || ""}`.trim()
                : undefined,
              polygon: building.polygon.length > 0 ? building.polygon : undefined,
            });
          }
        }
      }
    }

    return results;
  }

  /**
   * Get statistics about loaded cities
   */
  getStats(): {
    loadedCities: string[];
    totalBuildings: number;
    citySizes: Record<string, number>;
  } {
    const citySizes: Record<string, number> = {};
    let totalBuildings = 0;

    for (const [key, data] of this.loadedCities) {
      citySizes[key] = data.count;
      totalBuildings += data.count;
    }

    return {
      loadedCities: [...this.loadedCities.keys()],
      totalBuildings,
      citySizes,
    };
  }

  /**
   * Clear all loaded data
   */
  clear(): void {
    this.loadedCities.clear();
    this.spatialIndexes.clear();
  }
}

// Singleton instance
export const osmBuildingLookup = new OSMBuildingLookupService();
