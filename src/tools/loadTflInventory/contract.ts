import type { Sql } from "postgres";
import { TFL_INVENTORY_FEATURE } from "../../config.ts";
import { loadTflInventory } from "./load.ts";
import type { LoadTflInventoryParams } from "./types.ts";

const inputSchema = {
	type: "object",
	properties: {
		products: {
			type: "string",
			description:
				"Optional comma-separated exact product ids, product names, or SKUs. Product-name and SKU matching is case-insensitive.",
		},
		warehouses: {
			type: "string",
			description: "Optional comma-separated exact warehouse ids or names. Name matching is case-insensitive.",
		},
		asOf: {
			type: "string",
			pattern: "^\\d{4}-\\d{2}-\\d{2}$",
			description:
				"Optional YYYY-MM-DD. Selects each connector's latest daily snapshot on or before this date; default is latest available.",
		},
		maxAvailable: {
			type: "number",
			description: "Optional maximum sellable units, useful for low-stock lists.",
		},
		limit: {
			type: "integer",
			minimum: 1,
			maximum: 1000,
			default: 250,
			description: "Maximum product-by-warehouse rows to return.",
		},
	},
	additionalProperties: false,
} as const;

function optionalNumber(value: unknown): number | undefined {
	return typeof value === "number" ? value : undefined;
}

function parseParams(args: Record<string, unknown>): LoadTflInventoryParams {
	return {
		products: typeof args["products"] === "string" ? args["products"] : undefined,
		warehouses: typeof args["warehouses"] === "string" ? args["warehouses"] : undefined,
		asOf: typeof args["asOf"] === "string" ? args["asOf"] : undefined,
		maxAvailable: optionalNumber(args["maxAvailable"]),
		limit: optionalNumber(args["limit"]),
	};
}

export const loadTflInventoryTool = {
	name: "loadTflInventory",
	feature: TFL_INVENTORY_FEATURE,
	description:
		"Fetch The Fulfillment Lab (GFS) product inventory at each connector's latest daily warehouse snapshot, " +
		"or the latest snapshot on/before a requested date. Returns product names, product ids, warehouse, on-hand, " +
		"allocated, available, and product-id-based SKU mappings. Filters by exact product id/name/SKU, warehouse, " +
		"or maximum available units. Reads the client DB tfl_products_v1 inventory tables.",
	inputSchema,
	run: (args: Record<string, unknown>, sql: Sql) => loadTflInventory(parseParams(args), sql),
};
