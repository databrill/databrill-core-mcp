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
import { createCanonicalQueryBuilder } from "@jsr/databrill__core-pg-kysely/canonical";
import { sql as ksql, type SqlBool } from "kysely";
import { runCompiled } from "../../runCompiled.ts";
import type { LoadTflInventoryParams, LoadTflInventoryResult, TflInventoryRow, TflSkuMapping } from "./types.ts";

const REQUIRED_TABLES = [
	"tfl_products_v1__Inventory",
	"tfl_products_v1__WarehouseInventory",
	"tfl_products_v1__SkuProduct",
] as const;
const DEFAULT_LIMIT = 250;
const MAX_LIMIT = 1000;

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

	// One builder for the whole invocation, and where a future
	// `.withSchema(workspaceSchema)` would attach.
	const db = createCanonicalQueryBuilder();

	let query = db
		.with("selectedSnapshot", (qb) =>
			qb
				.selectFrom("tfl_products_v1__WarehouseInventory")
				.select((eb) => ["connectorId", eb.fn.max("localdate").as("snapshotDate")])
				// The same JS value is interpolated twice and binds twice, exactly as
				// the tagged template did. `asOf` is null when the caller gave no date,
				// and the two `::DATE` casts are what give the parameter a type. These
				// two parameters are also what keeps the statement off postgres.js's
				// SIMPLE protocol when the caller passes no filters at all.
				.where((eb) => ksql<SqlBool>`(${asOf}::DATE IS NULL OR ${eb.ref("localdate")} <= ${asOf}::DATE)`)
				.groupBy("connectorId"))
		.with("skuMap", (qb) =>
			qb
				.selectFrom("tfl_products_v1__SkuProduct")
				.select((eb) => [
					"connectorId",
					"productId",
					eb.fn.agg("jsonb_agg", [
						eb.fn("jsonb_build_object", [
							ksql.lit("sku"),
							eb.ref("sku"),
							ksql.lit("qtyMultiplier"),
							eb.ref("qtyMultiplier"),
						]),
					]).orderBy("sku").as("skus"),
				])
				.groupBy(["connectorId", "productId"]))
		.selectFrom("tfl_products_v1__WarehouseInventory as warehouse")
		.innerJoin("selectedSnapshot", (join) =>
			join
				.onRef("selectedSnapshot.connectorId", "=", "warehouse.connectorId")
				.onRef("selectedSnapshot.snapshotDate", "=", "warehouse.localdate"))
		.leftJoin("tfl_products_v1__Inventory as product", (join) =>
			join
				.onRef("product.connectorId", "=", "warehouse.connectorId")
				.onRef("product.productId", "=", "warehouse.productId"))
		.leftJoin("skuMap", (join) =>
			join
				.onRef("skuMap.connectorId", "=", "warehouse.connectorId")
				.onRef("skuMap.productId", "=", "warehouse.productId"))
		.select((eb) => [
			eb.cast<string>(eb.ref("warehouse.localdate"), "text").as("snapshotDate"),
			"warehouse.connectorId",
			"warehouse.warehouseId",
			"warehouse.warehouseName",
			"warehouse.productId",
			"product.productName",
			"warehouse.quantity",
			"warehouse.allocated",
			"warehouse.available",
			eb.fn.coalesce("skuMap.skus", ksql`'[]'::JSONB`).as("skus"),
		]);

	if (products !== null) {
		const lowered = products.map((value) => value.toLowerCase());
		query = query.where((eb) =>
			eb.or([
				eb(eb.cast<string>(eb.ref("warehouse.productId"), "text"), "=", eb.fn.any(ksql.val(products))),
				eb(
					ksql<string>`LOWER(${eb.fn.coalesce("product.productName", ksql.lit(""))})`,
					"=",
					eb.fn.any(ksql.val(lowered)),
				),
				eb.exists(
					eb
						.selectFrom("tfl_products_v1__SkuProduct as filterSku")
						.select((eb2) => eb2.lit(1).as("one"))
						.whereRef("filterSku.connectorId", "=", "warehouse.connectorId")
						.whereRef("filterSku.productId", "=", "warehouse.productId")
						// The correlated subquery has its own expression builder; the
						// outer `eb` cannot name "filterSku.sku".
						.where((eb3) =>
							eb3(ksql<string>`LOWER(${eb3.ref("filterSku.sku")})`, "=", eb3.fn.any(ksql.val(lowered)))
						),
				),
			])
		);
	}
	if (warehouses !== null) {
		const lowered = warehouses.map((value) => value.toLowerCase());
		query = query.where((eb) =>
			eb.or([
				eb(eb.cast<string>(eb.ref("warehouse.warehouseId"), "text"), "=", eb.fn.any(ksql.val(warehouses))),
				eb(
					ksql<string>`LOWER(${eb.fn.coalesce("warehouse.warehouseName", ksql.lit(""))})`,
					"=",
					eb.fn.any(ksql.val(lowered)),
				),
			])
		);
	}
	if (maxAvailable !== null) {
		query = query.where("warehouse.available", "<=", maxAvailable);
	}

	const rows = await runCompiled(
		sql,
		query
			.orderBy("warehouse.available", "asc")
			.orderBy("product.productName", (ob) => ob.asc().nullsLast())
			.orderBy("warehouse.warehouseName", (ob) => ob.asc().nullsLast())
			// `limit + 1` is the truncation probe `isTruncated` below reads. Not `limit`.
			.limit(limit + 1)
			.compile(),
	);

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
