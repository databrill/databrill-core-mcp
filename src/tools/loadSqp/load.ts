/**
 * loadSqp — Search Query Performance: our-vs-market impressions/clicks/purchases
 * per period, plus the top search queries by market impressions. Generalized
 * from the original `querySqpWeekly` / `querySqpKeywords` (which were US-only).
 *
 * Reads `amzreport_SEARCH_QUERY_PERFORMANCE`, which is pre-aggregated by the
 * report's own timeUnit (WEEK or MONTH) — so `timeUnit` selects rows, it is not
 * a re-bucketing.
 */

import postgres from "postgres";
import { marketplaceIdToMarketplaceInfo } from "../../amazonConstants.ts";
import { resolveProducts, resolveStores, resolveWhen } from "../loadAds/loadAds.ts";
import {
	type LoadSqpParams,
	type LoadSqpResult,
	type SqpKeywordRow,
	type SqpPeriodRow,
	type SqpTimeUnit,
	VALID_SQP_TIME_UNITS,
} from "./types.ts";

function fail(msg: string): never {
	throw new Error(msg);
}

function round3(n: number): number {
	return Math.round(n * 1000) / 1000;
}

function share(part: number, whole: number): number {
	return whole > 0 ? round3((part / whole) * 100) : 0;
}

export async function loadSqp(params: LoadSqpParams, sql: postgres.Sql): Promise<LoadSqpResult> {
	if (!params.stores) fail("stores is required");
	if (!params.when) fail("when is required");

	const timeUnit = (params.timeUnit ? params.timeUnit.toUpperCase() : "WEEK") as SqpTimeUnit;
	if (!VALID_SQP_TIME_UNITS.includes(timeUnit)) {
		fail(`Unknown timeUnit '${params.timeUnit}'. Valid: ${VALID_SQP_TIME_UNITS.join(", ")}`);
	}
	const keywordLimit = params.keywordLimit ?? 25;

	const stores = await resolveStores(params.stores, sql);
	const marketplaceIds = [...new Set(stores.map((s) => s.marketplaceId))];
	const range = await resolveWhen(params.when, sql);

	let asins: string[] | null = null;
	if (params.products) {
		asins = await resolveProducts(params.products, sql);
		if (asins.length === 0) fail("products resolved to zero ASINs");
	}
	const asinFilter = asins ? sql`AND asin IN ${sql(asins)}` : sql``;

	const periodRows = await sql<Array<Record<string, string | null>>>`
		SELECT
			"marketplaceId",
			"dateFirst"::date::text AS period,
			SUM(("impressionData"->>'asinImpressionCount')::int) AS our_impr,
			SUM(("impressionData"->>'totalQueryImpressionCount')::int) AS market_impr,
			SUM(("clickData"->>'asinClickCount')::int) AS our_clicks,
			SUM(("clickData"->>'totalClickCount')::int) AS market_clicks,
			SUM(("purchaseData"->>'asinPurchaseCount')::int) AS our_purch,
			SUM(("purchaseData"->>'totalPurchaseCount')::int) AS market_purch
		FROM "amzreport_SEARCH_QUERY_PERFORMANCE"
		WHERE "timeUnit" = ${timeUnit}
			AND "marketplaceId" IN ${sql(marketplaceIds)}
			${asinFilter}
			AND "dateFirst"::date >= ${range.dateFirst}::date
			AND "dateFirst"::date <= ${range.dateLast}::date
		GROUP BY "marketplaceId", "dateFirst"
		ORDER BY "dateFirst", "marketplaceId"
	`;

	const periods: SqpPeriodRow[] = periodRows.map((r) => {
		const marketplaceId = String(r.marketplaceId);
		const ourImpr = Number(r.our_impr ?? 0);
		const marketImpr = Number(r.market_impr ?? 0);
		const ourClicks = Number(r.our_clicks ?? 0);
		const marketClicks = Number(r.market_clicks ?? 0);
		const ourPurchases = Number(r.our_purch ?? 0);
		const marketPurchases = Number(r.market_purch ?? 0);
		return {
			country: marketplaceIdToMarketplaceInfo[marketplaceId]?.countryCode ?? marketplaceId,
			marketplaceId,
			period: String(r.period),
			ourImpr,
			marketImpr,
			ourClicks,
			marketClicks,
			ourPurchases,
			marketPurchases,
			imprShare: share(ourImpr, marketImpr),
			clickShare: share(ourClicks, marketClicks),
			purchShare: share(ourPurchases, marketPurchases),
		};
	});

	const keywordRows = await sql<Array<Record<string, string | null>>>`
		SELECT
			"searchQuery" AS q,
			SUM(("impressionData"->>'totalQueryImpressionCount')::int) AS mkt_impr,
			SUM(("impressionData"->>'asinImpressionCount')::int) AS our_impr,
			SUM(("clickData"->>'asinClickCount')::int) AS our_clicks,
			SUM(("clickData"->>'totalClickCount')::int) AS mkt_clicks,
			SUM(("purchaseData"->>'asinPurchaseCount')::int) AS our_purch,
			SUM(("purchaseData"->>'totalPurchaseCount')::int) AS mkt_purch
		FROM "amzreport_SEARCH_QUERY_PERFORMANCE"
		WHERE "timeUnit" = ${timeUnit}
			AND "marketplaceId" IN ${sql(marketplaceIds)}
			${asinFilter}
			AND "dateFirst"::date >= ${range.dateFirst}::date
			AND "dateFirst"::date <= ${range.dateLast}::date
		GROUP BY "searchQuery"
		ORDER BY mkt_impr DESC NULLS LAST
		LIMIT ${keywordLimit}
	`;

	const keywords: SqpKeywordRow[] = keywordRows.map((r) => {
		const mktImpr = Number(r.mkt_impr ?? 0);
		const ourImpr = Number(r.our_impr ?? 0);
		const mktClicks = Number(r.mkt_clicks ?? 0);
		const ourClicks = Number(r.our_clicks ?? 0);
		const mktPurch = Number(r.mkt_purch ?? 0);
		const ourPurch = Number(r.our_purch ?? 0);
		return {
			q: String(r.q ?? ""),
			mktImpr,
			ourImpr,
			imprShare: share(ourImpr, mktImpr),
			ourClicks,
			clickShare: share(ourClicks, mktClicks),
			ourPurch,
			purchShare: share(ourPurch, mktPurch),
		};
	});

	return {
		meta: {
			dateFirst: range.dateFirst,
			dateLast: range.dateLast,
			stores: [...new Set(stores.map((s) => s.countryCode))],
			timeUnit,
			periodCount: periods.length,
			keywordCount: keywords.length,
		},
		periods,
		keywords,
	};
}
