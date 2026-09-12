/**
 * loadSqp — Search Query Performance: our-vs-market impressions/clicks/purchases
 * per period, plus the top search queries by market impressions. Generalized
 * from the original `querySqpWeekly` / `querySqpKeywords` (which were US-only).
 *
 * Reads `amzreport_SEARCH_QUERY_PERFORMANCE`, which is pre-aggregated by the
 * report's own timeUnit (WEEK or MONTH) — so `timeUnit` selects rows, it is not
 * a re-bucketing.
 *
 * Grain rule, and the one thing to get right here: a row is one (search query,
 * ASIN, marketplace, period). The `asin*` counts are ours and add up across
 * rows; the `total*` counts are whole-market figures that the report repeats
 * identically on every ASIN row of a (searchQuery, marketplaceId, dateFirst)
 * group, and must NEVER be summed across ASINs. Both queries below therefore
 * aggregate in two levels: a CTE at the market grain (`MAX` on the `total*`
 * columns, `SUM` on the `asin*` ones), then an outer roll-up that sums both
 * across search queries, periods and marketplaces as the output grain requires.
 * Summing the `total*` columns directly multiplies the market denominator by the
 * number of our ASINs ranking for each term, so every share this tool reports
 * comes out smaller than the truth by that same factor.
 *
 * The `products` filter stays inside the CTE, so a term the filtered ASIN set
 * does not appear on drops out of the denominator too: the market total means
 * "market impressions for the terms this product set appears on", which is the
 * right denominator for a scoped share. Do not move it outside.
 *
 * Verifying the repeated-constant assumption on a workspace that looks off:
 *   SELECT count(*) FROM (
 *     SELECT 1 FROM "amzreport_SEARCH_QUERY_PERFORMANCE"
 *     WHERE "timeUnit" = 'WEEK' AND "dateFirst" = '<week>'
 *     GROUP BY "searchQuery", "marketplaceId", "dateFirst"
 *     HAVING count(DISTINCT ("impressionData"->>'totalQueryImpressionCount')) > 1
 *   ) t;
 * Zero is the expected answer. A non-zero count means two report vintages are in
 * the table — fix the data, do not switch to `AVG`, which would hide it.
 */

import { Effect, Either } from "effect";
import type postgres from "postgres";
import { createCanonicalQueryBuilder } from "@jsr/databrill__core-pg-kysely/canonical";
import { marketplaceIdToMarketplaceInfo } from "../../amazonConstants.ts";
import { isoDateParam, runCompiled } from "../../runCompiled.ts";
import { jsonbInt } from "../../sqlJson.ts";
import { resolveProducts, resolveStores, resolveWhen } from "../loadAds/loadAds.ts";
import {
	type LoadSqpParams,
	type LoadSqpResult,
	type SqpKeywordRow,
	type SqpPeriodRow,
	type SqpTimeUnit,
	VALID_SQP_TIME_UNITS,
} from "./types.ts";

function fail(msg: string): Either.Either<never, Error> {
	return Either.left(new Error(msg));
}

function round3(n: number): number {
	return Math.round(n * 1000) / 1000;
}

function share(part: number, whole: number): number {
	return whole > 0 ? round3((part / whole) * 100) : 0;
}

export function loadSqp(params: LoadSqpParams, sql: postgres.Sql): Effect.Effect<LoadSqpResult, Error> {
	return Effect.gen(function* () {
		if (!params.stores) return yield* fail("stores is required");
		if (!params.when) return yield* fail("when is required");

		const timeUnit = (params.timeUnit ? params.timeUnit.toUpperCase() : "WEEK") as SqpTimeUnit;
		if (!VALID_SQP_TIME_UNITS.includes(timeUnit)) {
			return yield* fail(`Unknown timeUnit '${params.timeUnit}'. Valid: ${VALID_SQP_TIME_UNITS.join(", ")}`);
		}
		const keywordLimit = params.keywordLimit ?? 25;

		const stores = yield* resolveStores(params.stores, sql);
		const marketplaceIds = [...new Set(stores.map((s) => s.marketplaceId))];
		const range = yield* resolveWhen(params.when, sql);

		let asins: string[] | null = null;
		if (params.products) {
			asins = yield* resolveProducts(params.products, sql);
			if (asins.length === 0) return yield* fail("products resolved to zero ASINs");
		}
		// One builder for the whole invocation, built before the CTE: it is where a
		// future `.withSchema(workspaceSchema)` would attach.
		const db = createCanonicalQueryBuilder();

		// The market-grain CTE, shared by both statements below. The two original
		// templates spelled its GROUP BY in a different column ORDER, which does not
		// affect the result, so one builder serves both; each statement compiles its
		// own copy of the CTE text with its own placeholder numbering.
		let perQuery = db
			.selectFrom("amzreport_SEARCH_QUERY_PERFORMANCE")
			.select((eb) => [
				"marketplaceId",
				"dateFirst",
				"searchQuery",
				eb.fn.sum<string | null>(jsonbInt(eb.ref("impressionData"), "asinImpressionCount")).as("our_impr"),
				eb.fn.sum<string | null>(jsonbInt(eb.ref("clickData"), "asinClickCount")).as("our_clicks"),
				eb.fn.sum<string | null>(jsonbInt(eb.ref("purchaseData"), "asinPurchaseCount")).as("our_purch"),
				// MAX, not SUM: the total* columns are whole-market figures that the
				// report repeats identically on every ASIN row of a (searchQuery,
				// marketplaceId, dateFirst) group. MAX reads that single value; SUM
				// would multiply it by the number of our ASINs that happen to rank for
				// the term.
				eb.fn.max<number | null>(jsonbInt(eb.ref("impressionData"), "totalQueryImpressionCount")).as(
					"market_impr",
				),
				eb.fn.max<number | null>(jsonbInt(eb.ref("clickData"), "totalClickCount")).as("market_clicks"),
				eb.fn.max<number | null>(jsonbInt(eb.ref("purchaseData"), "totalPurchaseCount")).as("market_purch"),
			])
			.where("timeUnit", "=", timeUnit)
			.where("marketplaceId", "in", marketplaceIds)
			.where("dateFirst", ">=", isoDateParam(range.dateFirst))
			.where("dateFirst", "<=", isoDateParam(range.dateLast))
			.groupBy(["marketplaceId", "dateFirst", "searchQuery"]);
		// The products filter stays INSIDE the CTE — see the module doc.
		if (asins !== null) {
			perQuery = perQuery.where("asin", "in", asins);
		}

		const periodRows = yield* runCompiled(
			sql,
			() =>
				db
					.with("per_query", () => perQuery)
					.selectFrom("per_query")
					.select((eb) => [
						"marketplaceId",
						eb.cast<string>(eb.ref("dateFirst"), "text").as("period"),
						eb.fn.sum<string | null>("our_impr").as("our_impr"),
						eb.fn.sum<string | null>("market_impr").as("market_impr"),
						eb.fn.sum<string | null>("our_clicks").as("our_clicks"),
						eb.fn.sum<string | null>("market_clicks").as("market_clicks"),
						eb.fn.sum<string | null>("our_purch").as("our_purch"),
						eb.fn.sum<string | null>("market_purch").as("market_purch"),
					])
					.groupBy(["marketplaceId", "dateFirst"])
					.orderBy("dateFirst")
					.orderBy("marketplaceId")
					.compile(),
		);

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

		const keywordRows = yield* runCompiled(
			sql,
			() =>
				db
					.with("per_query", () => perQuery)
					.selectFrom("per_query")
					.select((eb) => [
						eb.ref("searchQuery").as("q"),
						eb.fn.sum<string | null>("market_impr").as("mkt_impr"),
						eb.fn.sum<string | null>("our_impr").as("our_impr"),
						eb.fn.sum<string | null>("our_clicks").as("our_clicks"),
						eb.fn.sum<string | null>("market_clicks").as("mkt_clicks"),
						eb.fn.sum<string | null>("our_purch").as("our_purch"),
						eb.fn.sum<string | null>("market_purch").as("mkt_purch"),
					])
					.groupBy("searchQuery")
					.orderBy("mkt_impr", (ob) => ob.desc().nullsLast())
					.limit(keywordLimit)
					.compile(),
		);

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
				mktClicks,
				ourClicks,
				clickShare: share(ourClicks, mktClicks),
				mktPurch,
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
	});
}
