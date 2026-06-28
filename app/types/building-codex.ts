/**
 * Building DataStore Types
 *
 * Per-building riser diagram data stored in DataStore.geo at:
 *   details/buildings/{buildingId}/riser.json
 *   details/buildings/_index.json
 *
 * The RiserDiagramsView derives its data from addressesData at render time.
 * These DataStore files exist for AI/agent queryability via:
 *   read_geocodebase_file("details/buildings/{id}/riser.json")
 */

// ============================================================================
// Per-Building Riser Data (riser.json)
// ============================================================================

/** Apartment-level fiber assignment */
export interface BuildingApartmentData {
  unit: string;
  fiberNumber: number;
  tubeColor: string;
  fiberColor: string;
  status: "active" | "reserved" | "spare" | "inactive";
}

/** Floor-level distribution point */
export interface BuildingFloorData {
  floorNumber: number;
  fdpId: string;
  apartments: BuildingApartmentData[];
}

/** Building Distribution Frame — entry point for riser cable */
export interface BuildingBDFData {
  id: string;
  fiberCount: number;
  sourceClosureId: string;
}

/**
 * BuildingRiserDataStoreData — Full riser data for a single building.
 * Stored at details/buildings/{buildingId}/riser.json
 */
export interface BuildingRiserDataStoreData {
  buildingId: string;
  buildingName: string;
  address?: string;
  bdf: BuildingBDFData;
  floors: BuildingFloorData[];
  riserCableType: string;
  /** Total fiber demand (floors × units_per_floor) */
  totalFibers: number;
  /** Number of floors */
  floorCount: number;
  /** Units per floor */
  unitsPerFloor: number;
  /** Serving closure ID from addressesData */
  servingClosureId?: string;
  /** Generated timestamp */
  generatedAt: string;
}

// ============================================================================
// Building Index (_index.json)
// ============================================================================

/** Summary entry per building in the index */
export interface BuildingIndexEntry {
  buildingId: string;
  buildingName: string;
  address?: string;
  floorCount: number;
  unitsPerFloor: number;
  totalUnits: number;
  totalFibers: number;
  riserCableType: string;
  servingClosureId?: string;
}

/**
 * BuildingIndexData — Summary of all buildings with riser data.
 * Stored at details/buildings/_index.json
 */
export interface BuildingIndexData {
  version: "1.0";
  generatedAt: string;
  totalBuildings: number;
  totalUnits: number;
  totalFibers: number;
  buildings: BuildingIndexEntry[];
}
