import { Result } from "effect";
import type { TruncationCap } from "../../sqlGuardrails.ts";

export const LEVELS = ["family", "parentAsin", "asin", "sku"] as const;
export type ProductLevel = typeof LEVELS[number];

export const COLUMNS_AVAILABLE = {
	family: ["family", "label", "description", "category", "asinCount", "parentAsinCount", "skuCount"],
	parentAsin: ["parentAsin", "title", "brand", "families", "asinCount", "skuCount"],
	asin: ["asin", "parentAsin", "family", "labelInFamily", "title", "brand", "productType", "countries", "skuCount"],
	sku: [
		"sku",
		"country",
		"merchantId",
		"asin",
		"parentAsin",
		"family",
		"title",
		"fulfillmentChannel",
		"price",
		"quantity",
	],
} as const;

export const DEFAULT_COLUMNS: Readonly<Record<ProductLevel, readonly string[]>> = {
	family: ["family", "label", "asinCount"],
	parentAsin: ["parentAsin", "title", "asinCount"],
	asin: ["asin", "parentAsin", "family", "title"],
	sku: ["sku", "country", "asin", "family"],
};

export interface LoadProductsParams {
	readonly level?: ProductLevel | undefined;
	readonly stores?: string | undefined;
	readonly products?: string | undefined;
	readonly search?: string | undefined;
	readonly columns?: readonly string[] | undefined;
	readonly includeUnassigned?: boolean | undefined;
	readonly limit?: number | undefined;
	readonly offset?: number | undefined;
}

export interface LoadProductsResult {
	readonly meta: {
		readonly level: ProductLevel;
		readonly stores: readonly string[];
		/** Priority for localized titles and the ASIN row's parent; first available country wins. */
		readonly titleCountryPriority: readonly string[];
		readonly totalCount: number;
		readonly rowCount: number;
		readonly limit: number;
		readonly offset: number;
		readonly isTruncated: boolean;
		readonly truncatedBy: TruncationCap | null;
		readonly columns: readonly string[];
		readonly columnsAvailable: readonly string[];
		/** Matching ASINs (SKUs at sku grain) without a family, before includeUnassigned. */
		readonly unassignedCount: number;
		readonly ontologyPopulated: boolean;
		readonly missingTables: readonly string[];
	};
	/** Projected rows contain only the validated columns requested for this grain. */
	readonly data: readonly Readonly<Record<string, unknown>>[];
}

/** Validate a projection, refusing unknown or wrong-grain columns rather than dropping them. */
export function parseColumns(
	value: string | readonly string[] | undefined,
	level: ProductLevel,
): Result.Result<readonly string[], Error> {
	const columns = typeof value === "string"
		? value.split(",").map((column) => column.trim())
		: value ?? DEFAULT_COLUMNS[level];
	const available: readonly string[] = COLUMNS_AVAILABLE[level];
	for (const column of columns) {
		if (!available.includes(column)) {
			return Result.fail(
				new Error(`Unknown column '${column}' for ${level}. Available: ${available.join(", ")}`),
			);
		}
	}
	if (columns.length === 0) {
		return Result.fail(new Error("columns must contain at least one column"));
	}
	return Result.succeed([...new Set(columns)]);
}
