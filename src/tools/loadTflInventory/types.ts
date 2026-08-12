export interface TflSkuMapping {
	readonly sku: string;
	readonly qtyMultiplier: number;
}

export interface TflInventoryRow {
	readonly snapshotDate: string;
	readonly connectorId: string;
	readonly warehouseId: number;
	readonly warehouseName: string | null;
	readonly productId: number;
	readonly productName: string | null;
	readonly quantity: number;
	readonly allocated: number;
	readonly available: number;
	readonly skus: readonly TflSkuMapping[];
}

export interface TflSnapshotDate {
	readonly connectorId: string;
	readonly snapshotDate: string;
}

export interface LoadTflInventoryParams {
	readonly products?: string | undefined;
	readonly warehouses?: string | undefined;
	readonly asOf?: string | undefined;
	readonly maxAvailable?: number | undefined;
	readonly limit?: number | undefined;
}

export interface LoadTflInventoryResult {
	readonly meta: {
		readonly source: "The Fulfillment Lab";
		readonly requestedAsOf: string | null;
		readonly dateDataLatest: string | null;
		readonly snapshotDates: readonly TflSnapshotDate[];
		readonly rowCount: number;
		readonly limit: number;
		readonly isTruncated: boolean;
		readonly quantityTotal: number;
		readonly allocatedTotal: number;
		readonly availableTotal: number;
		readonly missingTables: readonly string[];
	};
	readonly data: readonly TflInventoryRow[];
}
