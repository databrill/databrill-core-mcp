/**
 * loadTraffic — per-ASIN (or family) Sales & Traffic metrics over a window:
 * sessions, units, sales, and conversion rate, from `amzreport_SALES_AND_TRAFFIC__skuByDay`.
 *
 * Generalized from the original `queryFamilySessions`:
 *   • marketplace(s) come from store resolution, not a hardcoded US id;
 *   • the family/ASIN filter uses the generic `brand_config_amazon_asin` (via
 *     loadAds's `resolveProducts`), not a client-specific ASIN table;
 *   • the bucket is a configurable timeUnit (DAY/WEEK/MONTH), not week-only.
 *
 * Reuses loadAds's `resolveStores` / `resolveWhen` / `resolveProducts` so every
 * metric tool shares one store/when/product resolution surface.
 */

import postgres from "postgres";
import { marketplaceIdToMarketplaceInfo } from "../../amazonConstants.ts";
import { type DateRange, type ResolvedStore, resolveProducts, resolveStores, resolveWhen } from "../loadAds/loadAds.ts";
import {
	type LoadTrafficParams,
	type LoadTrafficResult,
	type TrafficGroupBy,
	type TrafficRow,
	type TrafficTimeUnit,
	VALID_TRAFFIC_GROUP_BY,
	VALID_TRAFFIC_TIME_UNITS,
} from "./types.ts";

function fail(msg: string): never {
	throw new Error(msg);
}

/** `(merchantId, marketplaceId) IN ((..),(..))` over the distinct resolved store pairs. */
function storePairsClause(stores: ResolvedStore[], alias: string): string {
	const seen = new Set<string>();
	const pairs: string[] = [];
	for (const s of stores) {
		const k = `${s.merchantId}\x00${s.marketplaceId}`;
		if (seen.has(k)) continue;
		seen.add(k);
		pairs.push(`('${s.merchantId}', '${s.marketplaceId}')`);
	}
	return `(${alias}."merchantId", ${alias}."marketplaceId") IN (${pairs.join(", ")})`;
}

/** Grouping + select label for the time bucket (column `date`). */
function bucketExprs(tu: TrafficTimeUnit): { groupBy: string; label: string } {
	switch (tu) {
		case "DAY":
			return { groupBy: `r.date`, label: `r.date::text` };
		case "WEEK":
			return {
				groupBy: `date_trunc('week', r.date)`,
				label: `(date_trunc('week', r.date)::date + 6)::text`,
			};
		case "MONTH":
			return {
				groupBy: `date_trunc('month', r.date)`,
				label: `(date_trunc('month', r.date) + INTERVAL '1 month' - INTERVAL '1 day')::date::text`,
			};
	}
}

function round2(n: number): number {
	return Math.round(n * 100) / 100;
}

export async function loadTraffic(params: LoadTrafficParams, sql: postgres.Sql): Promise<LoadTrafficResult> {
	if (!params.stores) fail("stores is required");
	if (!params.when) fail("when is required");

	const groupBy = (params.groupBy ?? "asin") as TrafficGroupBy;
	if (!VALID_TRAFFIC_GROUP_BY.includes(groupBy)) {
		fail(`Unknown groupBy '${params.groupBy}'. Valid: ${VALID_TRAFFIC_GROUP_BY.join(", ")}`);
	}
	const timeUnit = (params.timeUnit ? params.timeUnit.toUpperCase() : "WEEK") as TrafficTimeUnit;
	if (!VALID_TRAFFIC_TIME_UNITS.includes(timeUnit)) {
		fail(`Unknown timeUnit '${params.timeUnit}'. Valid: ${VALID_TRAFFIC_TIME_UNITS.join(", ")}`);
	}

	const stores = await resolveStores(params.stores, sql);
	const range: DateRange = await resolveWhen(params.when, sql);

	let productAsins: string[] | null = null;
	if (params.products) {
		productAsins = await resolveProducts(params.products, sql);
		if (productAsins.length === 0) fail("products resolved to zero ASINs");
	}

	const bucket = bucketExprs(timeUnit);
	const groupCol = groupBy === "family" ? `COALESCE(fam.family, '(unmapped)')` : `r."childAsin"`;
	const groupAlias = groupBy === "family" ? "family" : "asin";

	const selectCols = [
		`r."marketplaceId" AS "marketplaceId"`,
		`${bucket.label} AS "period"`,
		`${groupCol} AS "${groupAlias}"`,
		`SUM(CAST(r.traffic->>'sessions' AS int)) AS "sessions"`,
		`SUM(CAST(r.sales->>'unitsOrdered' AS int)) AS "units"`,
		`SUM(CAST(r.sales->'orderedProductSales'->>'amount' AS numeric)) AS "sales"`,
	];

	let from = `FROM "amzreport_SALES_AND_TRAFFIC__skuByDay" r`;
	if (groupBy === "family") {
		from += `\nLEFT JOIN "brand_config_amazon_asin" fam ON fam.asin = r."childAsin"`;
	}

	const wheres = [
		storePairsClause(stores, "r"),
		`r.date >= '${range.dateFirst}'`,
		`r.date <= '${range.dateLast}'`,
	];
	if (productAsins) {
		wheres.push(`r."childAsin" IN (${productAsins.map((a) => `'${a}'`).join(",")})`);
	}

	const groupByCols = [`r."marketplaceId"`, bucket.groupBy, groupCol];
	const query = `SELECT\n  ${selectCols.join(",\n  ")}\n${from}\nWHERE ${wheres.join("\n  AND ")}\nGROUP BY ${
		groupByCols.join(", ")
	}\nORDER BY ${bucket.groupBy}, ${groupCol}`;

	const rows = await sql.unsafe(query) as Array<Record<string, unknown>>;

	const data: TrafficRow[] = rows.map((r) => {
		const sessions = Number(r.sessions ?? 0);
		const units = Number(r.units ?? 0);
		const marketplaceId = String(r.marketplaceId);
		const out: TrafficRow = {
			country: marketplaceIdToMarketplaceInfo[marketplaceId]?.countryCode ?? marketplaceId,
			marketplaceId,
			period: String(r.period),
			sessions,
			units,
			sales: round2(Number(r.sales ?? 0)),
			cr: sessions > 0 ? round2((units / sessions) * 100) : 0,
		};
		if (groupBy === "family") out.family = String(r.family ?? "(unmapped)");
		else out.asin = String(r.asin ?? "");
		return out;
	});

	return {
		meta: {
			dateFirst: range.dateFirst,
			dateLast: range.dateLast,
			stores: [...new Set(stores.map((s) => s.countryCode))],
			rowCount: data.length,
			groupBy,
			timeUnit,
		},
		data,
	};
}
