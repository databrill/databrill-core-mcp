/**
 * Product discovery, authored here like listTables/describeTable: this computes
 * no business metric. Counts are cardinalities of the selected identifiers;
 * correctness is checked against Postgres fixtures, rather than metric parity.
 * The catalog/listing column joins also occur in the agency productInfo loader.
 * Ontology views require a separate naming pipeline, so discovery reads the
 * canonical brand configuration directly and preserves missing labels as null.
 */
import { Effect } from "effect";
import type { Sql } from "postgres";
import { tryPromiseOrOperationError } from "../../effectErrors.ts";
import { resolveProducts, resolveStores } from "../loadAds/loadAds.ts";
import { createRowAccumulator, envelopeByteLength, MAX_RESULT_BYTES } from "../../sqlGuardrails.ts";
import {
	COLUMNS_AVAILABLE,
	type LoadProductsParams,
	type LoadProductsResult,
	parseColumns,
	type ProductLevel,
} from "./types.ts";

const TABLES = [
	"brand_config_amazon_asin",
	"brand_config_amazon_family",
	"amzspapi_catalog_items_v20220401__catalogitem",
	"amzreport_MERCHANT_LISTINGS_ALL",
	"amzreport_SALES_AND_TRAFFIC__skuByDay",
	"brand_config_ontology_category",
	"brand_config_ontology_variant",
] as const;

/** List the catalogue at a chosen grain using an injected workspace connection. */
export function loadProducts(params: LoadProductsParams, sql: Sql): Effect.Effect<LoadProductsResult, Error> {
	return Effect.gen(function* () {
		const level = params.level ?? "family";
		const columns = yield* Effect.fromResult(parseColumns(params.columns, level));
		const limit = params.limit ?? 200;
		const offset = params.offset ?? 0;
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 2000) {
			return yield* Effect.fail(new Error("limit must be an integer from 1 to 2000"));
		}
		if (!Number.isSafeInteger(offset) || offset < 0) {
			return yield* Effect.fail(new Error("offset must be a non-negative safe integer"));
		}
		const relations = yield* tryPromiseOrOperationError(() =>
			sql<{ name: string; present: boolean }[]>`
			SELECT name, to_regclass(quote_ident(name)) IS NOT NULL AS present FROM unnest(${[
				...TABLES,
			]}::text[]) AS name
		`
		);
		const present = new Set(relations.filter((row) => row.present).map((row) => row.name));
		const missingTables = TABLES.filter((table) => !present.has(table));
		const meta: LoadProductsResult["meta"] = {
			level,
			stores: [],
			titleCountryPriority: [],
			totalCount: 0,
			rowCount: 0,
			limit,
			offset,
			isTruncated: false,
			truncatedBy: null,
			columns,
			columnsAvailable: COLUMNS_AVAILABLE[level],
			unassignedCount: 0,
			ontologyPopulated: false,
			missingTables,
		};
		// As in loadTflInventory, absent source tables produce an explicit empty result.
		// The traffic fallback and ontology checks are optional even on older schemas.
		if (TABLES.slice(0, 4).some((table) => !present.has(table))) {
			return { meta, data: [] };
		}
		const storeSpec = level === "family" ? "*" : params.stores ?? "*";
		const stores = yield* resolveStores(storeSpec, sql).pipe(
			Effect.catch((error) =>
				storeSpec === "*" &&
					error.message === "No stores resolved (no active merchant sells in the requested marketplace[s])"
					? Effect.succeed([])
					: Effect.fail(error)
			),
		);
		const countries = [...new Set(stores.map((store) => store.countryCode))];
		const scope = stores.map((store, rank) => ({
			merchant: store.merchantId,
			marketplace: store.marketplaceId,
			country: store.countryCode,
			rank,
		}));
		const products = params.products ? yield* resolveProducts(params.products, sql) : null;
		const search = params.search?.toLowerCase() ?? "";
		const ontology = present.has("brand_config_ontology_category") && present.has("brand_config_ontology_variant")
			? yield* tryPromiseOrOperationError(() =>
				sql<{ populated: boolean }[]>`
				SELECT EXISTS(SELECT 1 FROM brand_config_ontology_category) AND
				EXISTS(SELECT 1 FROM brand_config_ontology_variant) AS populated`
			)
			: [];
		const query = buildRows(level, sql, products !== null);
		// Look up only the current ASIN/country when its catalog parent is missing.
		const fallback = present.has("amzreport_SALES_AND_TRAFFIC__skuByDay")
			? sql`SELECT t."parentAsin" AS parent
				FROM "amzreport_SALES_AND_TRAFFIC__skuByDay" t JOIN scope s
				ON s.merchant = t."merchantId" AND s.marketplace = t."marketplaceId"
				WHERE c.parent IS NULL AND i.country IS NOT NULL
					AND t."childAsin" = i.asin AND s.country = i.country
					AND t."parentAsin" <> ''
				ORDER BY t.date DESC, s.merchant COLLATE "C", t.sku COLLATE "C" LIMIT 1`
			: sql`SELECT NULL::text AS parent WHERE false`;
		const [result] = yield* tryPromiseOrOperationError(() =>
			sql<{
				total: number;
				unassigned: number;
				data: Record<string, unknown>[];
			}[]>`
			WITH scope AS (SELECT * FROM jsonb_to_recordset(${sql.json(scope)})
				AS s(merchant text, marketplace text, country text, rank int)),
			catalog AS (
				SELECT DISTINCT ON (c.asin, s.country) c.asin, s.country, s.rank,
					c.parent_asin AS parent, c.summaries->>'itemName' AS title,
					c.summaries->>'brand' AS brand, c.product_type AS "productType"
				FROM "amzspapi_catalog_items_v20220401__catalogitem" c JOIN scope s
				ON s.country = CASE WHEN c.marketplace_code = 'UK' THEN 'GB' ELSE c.marketplace_code END
				ORDER BY c.asin, s.country, s.rank, c.marketplace_code
			),
			listings AS (
				SELECT l."sellerSku" AS sku, s.country, s.merchant AS "merchantId", s.marketplace,
					nullif(l.doc->>'asin1', '') AS asin, l.doc->>'item-name' AS title,
					l.doc->>'fulfillment-channel' AS "fulfillmentChannel",
					CASE WHEN l.doc->>'price' ~ '^[0-9]+([.][0-9]+)?$' THEN (l.doc->>'price')::float8 END AS price,
					CASE WHEN l.doc->>'quantity' ~ '^[0-9]+$' THEN (l.doc->>'quantity')::float8 END AS quantity
				FROM "amzreport_MERCHANT_LISTINGS_ALL" l JOIN scope s
				ON l."merchantId" = s.merchant AND l."marketplaceId" = s.marketplace
				WHERE l."deletedAt" IS NULL
			),
			identifiers AS (
				SELECT asin, country FROM catalog UNION SELECT asin, country FROM listings WHERE asin IS NOT NULL
				UNION SELECT a.asin, NULL::text FROM brand_config_amazon_asin a WHERE ${level === "family"}
			),
			children AS (
				SELECT i.asin, i.country, coalesce(c.parent, f.parent) AS parent, c.title, c.brand, c."productType",
					a.family, a."labelInFamily", coalesce(c.rank, 2147483647) AS rank
				FROM identifiers i LEFT JOIN catalog c ON c.asin = i.asin AND c.country = i.country
				LEFT JOIN LATERAL (${fallback}) f ON true
				LEFT JOIN brand_config_amazon_asin a ON a.asin = i.asin
				WHERE (${products === null} OR i.asin = ANY(${products ?? []}::text[]))
			),
			visible_children AS (SELECT * FROM children WHERE ${
				params.includeUnassigned !== false
			} OR family IS NOT NULL),
			rows AS (${query}),
			matched AS (SELECT * FROM rows r WHERE ${search} = '' OR
				strpos(lower(coalesce(r.title, '')), ${search}) > 0 OR
				strpos(lower(coalesce(r."searchFamily", '')), ${search}) > 0),
			included AS (SELECT * FROM matched WHERE ${params.includeUnassigned !== false} OR NOT "isUnassigned"),
			page AS (SELECT * FROM included ORDER BY key1 COLLATE "C", key2 COLLATE "C", key3 COLLATE "C" LIMIT ${limit} OFFSET ${offset})
			SELECT (SELECT count(*)::int FROM included) AS total,
				${
				(level === "sku" || level === "asin")
					? sql`(SELECT count(*)::int FROM matched WHERE "isUnassigned")`
					: sql`(
					SELECT count(DISTINCT asin)::int FROM children WHERE family IS NULL AND
					(${search} = '' OR strpos(lower(coalesce(title, '')), ${search}) > 0))`
			} AS unassigned,
				coalesce((SELECT jsonb_agg(to_jsonb(page) ORDER BY key1 COLLATE "C", key2 COLLATE "C", key3 COLLATE "C") FROM page), '[]'::jsonb) AS data
		`
		);
		const fullMeta = {
			...meta,
			stores: level === "family" ? [] : stores.map((store) => `${store.merchantId}-${store.countryCode}`),
			titleCountryPriority: countries,
			totalCount: result?.total ?? 0,
			unassignedCount: result?.unassigned ?? 0,
			ontologyPopulated: ontology[0]?.populated ?? false,
		};
		// Reserve using maximum row-count digits and the longer truncation spelling.
		const reserve = yield* Effect.fromResult(
			envelopeByteLength({ ...fullMeta, rowCount: limit, isTruncated: false, truncatedBy: "bytes" }),
		);
		const accumulator = createRowAccumulator({
			rowLimit: limit,
			byteLimit: MAX_RESULT_BYTES,
			envelopeReserveBytes: reserve,
		});
		const projected = (result?.data ?? []).map((row) =>
			Object.fromEntries(columns.map((column) => [column, row[column] ?? null]))
		);
		yield* Effect.fromResult(accumulator.add(projected));
		const data = accumulator.rows();
		const truncatedBy = accumulator.truncatedBy() ?? (offset + data.length < fullMeta.totalCount ? "rows" : null);
		return { meta: { ...fullMeta, rowCount: data.length, isTruncated: truncatedBy !== null, truncatedBy }, data };
	});
}

function buildRows(level: ProductLevel, sql: Sql, hasProducts: boolean) {
	// summaries is an object in stored catalog rows, not the SP-API array.
	switch (level) {
		case "family":
			return sql`
				SELECT f.family, f.label, f.description, f.category, f.label AS title, f.family || ' ' || coalesce(f.label, '') AS "searchFamily",
					count(DISTINCT c.asin)::int AS "asinCount", count(DISTINCT c.parent)::int AS "parentAsinCount",
					count(DISTINCT (l."merchantId", l.marketplace, l.sku)) FILTER (WHERE l.sku IS NOT NULL)::int AS "skuCount",
					false AS "isUnassigned", f.family AS key1, ''::text AS key2, ''::text AS key3
				FROM brand_config_amazon_family f LEFT JOIN children c ON c.family = f.family
				LEFT JOIN listings l ON l.asin = c.asin AND l.country = c.country
				GROUP BY f.family, f.label, f.description, f.category
				HAVING ${!hasProducts} OR count(c.asin) > 0`;
		case "parentAsin":
			return sql`
				SELECT c.parent AS "parentAsin", (SELECT p.title FROM catalog p WHERE p.asin = c.parent ORDER BY p.rank LIMIT 1) AS title,
					(SELECT p.brand FROM catalog p WHERE p.asin = c.parent ORDER BY p.rank LIMIT 1) AS brand,
					coalesce(array_agg(DISTINCT c.family ORDER BY c.family) FILTER (WHERE c.family IS NOT NULL), ARRAY[]::text[]) AS families,
					string_agg(DISTINCT c.family, ' ') AS "searchFamily", count(DISTINCT c.asin)::int AS "asinCount",
					count(DISTINCT (l."merchantId", l.marketplace, l.sku)) FILTER (WHERE l.sku IS NOT NULL)::int AS "skuCount",
					bool_and(c.family IS NULL) AS "isUnassigned", c.parent AS key1, ''::text AS key2, ''::text AS key3
				FROM visible_children c LEFT JOIN listings l ON l.asin = c.asin AND l.country = c.country
				WHERE c.parent IS NOT NULL GROUP BY c.parent`;
		case "asin":
			return sql`
				SELECT DISTINCT ON (c.asin) c.asin, c.parent AS "parentAsin", c.family, c."labelInFamily", c.title, c.brand, c."productType",
					c.family AS "searchFamily", (c.family IS NULL) AS "isUnassigned",
					ARRAY(SELECT DISTINCT a.country FROM catalog a WHERE a.asin = c.asin AND a.country IS NOT NULL ORDER BY a.country) AS countries,
					(SELECT count(*)::int FROM listings l WHERE l.asin = c.asin) AS "skuCount",
					c.asin AS key1, ''::text AS key2, ''::text AS key3 FROM children c ORDER BY c.asin, c.rank, c.country`;
		case "sku":
			return sql`
				SELECT l.sku, l.country, l."merchantId", l.asin, c.parent AS "parentAsin", c.family,
					l.title, l."fulfillmentChannel", l.price, l.quantity, c.family AS "searchFamily", (c.family IS NULL) AS "isUnassigned",
					l.sku AS key1, l.country AS key2, l."merchantId" AS key3
				FROM listings l LEFT JOIN children c ON c.asin = l.asin AND c.country = l.country
				WHERE (${!hasProducts} AND l.asin IS NULL) OR c.asin IS NOT NULL`;
	}
}
