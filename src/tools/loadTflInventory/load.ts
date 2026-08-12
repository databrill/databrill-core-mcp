/**
 * Current The Fulfillment Lab inventory, ported from the client plugin's
 * `scripts/examples/tfl-inventory.sql` reference workflow.
 *
 * The warehouse endpoint has no source timestamp, so ingestion records one
 * America/New_York `localdate` snapshot per day. This loader selects the latest
 * snapshot on or before `asOf` independently for each connector, then joins the
 * durable product dimension and product-id-based SKU mappings.
 */

import type { Sql } from "postgres";
import type { LoadTflInventoryParams, LoadTflInventoryResult, TflInventoryRow, TflSkuMapping } from "./types.ts";

const REQUIRED_TABLES = [
	"tfl_products_v1__Inventory",
	"tfl_products_v1__WarehouseInventory",
	"tfl_products_v1__SkuProduct",
] as const;
const DEFAULT_LIMIT = 250;
const MAX_LIMIT = 1000;

interface DbInventoryRow {
	readonly snapshotDate: string;
	readonly connectorId: string;
	readonly warehouseId: number;
	readonly warehouseName: string | null;
	readonly productId: number;
	readonly productName: string | null;
	readonly quantity: number;
	readonly allocated: number;
	readonly available: number;
	readonly skus: unknown;
}

function fail(message: string): never {
	throw new Error(message);
}

function optionalTokens(value: string | undefined): readonly string[] | null {
	if (value === undefined) {
		return null;
	}
	const tokens = value.split(",").map((token) => token.trim()).filter((token) => token !== "");
	return tokens.length > 0 ? tokens : null;
}

function parseDate(value: string | undefined): string | null {
	if (value === undefined || value === "") {
		return null;
	}
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
		fail("asOf must be a calendar date in YYYY-MM-DD format");
	}
	return value;
}

function parseLimit(value: number | undefined): number {
	const limit = value ?? DEFAULT_LIMIT;
	if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
		fail(`limit must be an integer from 1 to ${MAX_LIMIT}`);
	}
	return limit;
}

function parseMaxAvailable(value: number | undefined): number | null {
	if (value === undefined) {
		return null;
	}
	if (!Number.isFinite(value)) {
		fail("maxAvailable must be a finite number");
	}
	return value;
}

function parseSkus(value: unknown): readonly TflSkuMapping[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const skus: TflSkuMapping[] = [];
	for (const item of value) {
		if (typeof item !== "object" || item === null) {
			continue;
		}
		const entries = Object.fromEntries(Object.entries(item));
		if (typeof entries["sku"] !== "string") {
			continue;
		}
		const qtyMultiplier = Number(entries["qtyMultiplier"]);
		if (!Number.isFinite(qtyMultiplier)) {
			continue;
		}
		skus.push({ sku: entries["sku"], qtyMultiplier });
	}
	return skus;
}

function emptyResult(asOf: string | null, limit: number, missingTables: readonly string[]): LoadTflInventoryResult {
	return {
		meta: {
			source: "The Fulfillment Lab",
			requestedAsOf: asOf,
			dateDataLatest: null,
			snapshotDates: [],
			rowCount: 0,
			limit,
			isTruncated: false,
			quantityTotal: 0,
			allocatedTotal: 0,
			availableTotal: 0,
			missingTables,
		},
		data: [],
	};
}

export async function loadTflInventory(
	params: LoadTflInventoryParams,
	sql: Sql,
): Promise<LoadTflInventoryResult> {
	const asOf = parseDate(params.asOf);
	const products = optionalTokens(params.products);
	const warehouses = optionalTokens(params.warehouses);
	const maxAvailable = parseMaxAvailable(params.maxAvailable);
	const limit = parseLimit(params.limit);

	const presentRows = await sql<Array<{ readonly tableName: string }>>`
		SELECT "table_name" AS "tableName"
		FROM "information_schema"."tables"
		WHERE "table_schema" = ANY(current_schemas(false))
			AND "table_name" IN ${sql([...REQUIRED_TABLES])}
	`;
	const present = new Set(presentRows.map((row) => row.tableName));
	const missingTables = REQUIRED_TABLES.filter((table) => !present.has(table));
	if (missingTables.length > 0) {
		return emptyResult(asOf, limit, missingTables);
	}

	const productFilter = products === null ? sql`` : sql`
			AND (
				"warehouse"."productId"::TEXT = ANY(${products})
				OR LOWER(COALESCE("product"."productName", '')) = ANY(${products.map((value) => value.toLowerCase())})
				OR EXISTS (
					SELECT 1
					FROM "tfl_products_v1__SkuProduct" AS "filterSku"
					WHERE "filterSku"."connectorId" = "warehouse"."connectorId"
						AND "filterSku"."productId" = "warehouse"."productId"
						AND LOWER("filterSku"."sku") = ANY(${products.map((value) => value.toLowerCase())})
				)
			)
		`;
	const warehouseFilter = warehouses === null ? sql`` : sql`
			AND (
				"warehouse"."warehouseId"::TEXT = ANY(${warehouses})
				OR LOWER(COALESCE("warehouse"."warehouseName", '')) = ANY(${
		warehouses.map((value) => value.toLowerCase())
	})
			)
		`;
	const availableFilter = maxAvailable === null ? sql`` : sql`AND "warehouse"."available" <= ${maxAvailable}`;

	const rows = await sql<DbInventoryRow[]>`
		WITH "selectedSnapshot" AS (
			SELECT
				"connectorId",
				MAX("localdate") AS "snapshotDate"
			FROM "tfl_products_v1__WarehouseInventory"
			WHERE (${asOf}::DATE IS NULL OR "localdate" <= ${asOf}::DATE)
			GROUP BY "connectorId"
		),
		"skuMap" AS (
			SELECT
				"connectorId",
				"productId",
				JSONB_AGG(
					JSONB_BUILD_OBJECT('sku', "sku", 'qtyMultiplier', "qtyMultiplier")
					ORDER BY "sku"
				) AS "skus"
			FROM "tfl_products_v1__SkuProduct"
			GROUP BY "connectorId", "productId"
		)
		SELECT
			"warehouse"."localdate"::TEXT AS "snapshotDate",
			"warehouse"."connectorId",
			"warehouse"."warehouseId",
			"warehouse"."warehouseName",
			"warehouse"."productId",
			"product"."productName",
			"warehouse"."quantity",
			"warehouse"."allocated",
			"warehouse"."available",
			COALESCE("skuMap"."skus", '[]'::JSONB) AS "skus"
		FROM "tfl_products_v1__WarehouseInventory" AS "warehouse"
		INNER JOIN "selectedSnapshot"
			ON "selectedSnapshot"."connectorId" = "warehouse"."connectorId"
			AND "selectedSnapshot"."snapshotDate" = "warehouse"."localdate"
		LEFT JOIN "tfl_products_v1__Inventory" AS "product"
			ON "product"."connectorId" = "warehouse"."connectorId"
			AND "product"."productId" = "warehouse"."productId"
		LEFT JOIN "skuMap"
			ON "skuMap"."connectorId" = "warehouse"."connectorId"
			AND "skuMap"."productId" = "warehouse"."productId"
		WHERE TRUE
			${productFilter}
			${warehouseFilter}
			${availableFilter}
		ORDER BY
			"warehouse"."available" ASC,
			"product"."productName" ASC NULLS LAST,
			"warehouse"."warehouseName" ASC NULLS LAST
		LIMIT ${limit + 1}
	`;

	const isTruncated = rows.length > limit;
	const data: TflInventoryRow[] = rows.slice(0, limit).map((row) => ({
		snapshotDate: row.snapshotDate,
		connectorId: row.connectorId,
		warehouseId: Number(row.warehouseId),
		warehouseName: row.warehouseName,
		productId: Number(row.productId),
		productName: row.productName,
		quantity: Number(row.quantity),
		allocated: Number(row.allocated),
		available: Number(row.available),
		skus: parseSkus(row.skus),
	}));

	const snapshotDates = [...new Map(
		data.map((row) => [row.connectorId, { connectorId: row.connectorId, snapshotDate: row.snapshotDate }]),
	).values()].sort((left, right) => left.connectorId.localeCompare(right.connectorId));
	const dates = snapshotDates.map((snapshot) => snapshot.snapshotDate);
	return {
		meta: {
			source: "The Fulfillment Lab",
			requestedAsOf: asOf,
			dateDataLatest: dates.length === 0 ? null : dates.toSorted().at(-1) ?? null,
			snapshotDates,
			rowCount: data.length,
			limit,
			isTruncated,
			quantityTotal: data.reduce((sum, row) => sum + row.quantity, 0),
			allocatedTotal: data.reduce((sum, row) => sum + row.allocated, 0),
			availableTotal: data.reduce((sum, row) => sum + row.available, 0),
			missingTables: [],
		},
		data,
	};
}
