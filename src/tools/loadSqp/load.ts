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
 * Rows with an empty `searchQuery` are excluded inside the CTE, so both
 * statements leave them out. Amazon's report leaves the term empty on some
 * rows, and the empty term stands for a different search in each period and
 * marketplace: its market figures are not one search's, and summing it across
 * periods would produce a keyword row made of unrelated searches that also
 * takes a top-N slot.
 *
 * Verifying the repeated-constant assumption on a workspace that looks off:
 *   SELECT count(*) FROM (
 *     SELECT 1 FROM "amzreport_SEARCH_QUERY_PERFORMANCE"
 *     WHERE "timeUnit" = 'WEEK' AND "dateFirst" = '<week>'
 *     GROUP BY "searchQuery", "marketplaceId", "dateFirst"
 *     HAVING count(DISTINCT "totalQueryImpressionCount") > 1
 *   ) t;
 * Zero is the expected answer. A non-zero count means two report vintages are in
 * the table — fix the data, do not switch to `AVG`, which would hide it.
 */
import { sql as ksql } from "kysely";
import { type ProductSelection, productSelectionPredicate, resolveProductsForStores } from "../../productSelection.ts";
import { Effect, Result } from "effect";
import type postgres from "postgres";
import { createCanonicalQueryBuilder } from "@jsr/databrill__core-pg-kysely/canonical";
import { marketplaceIdToMarketplaceInfo } from "../../amazonConstants.ts";
import { isoDateParam, runCompiled } from "../../runCompiled.ts";
import { resolveStores, resolveWhen } from "../loadAds/loadAds.ts";
import {
	DEFAULT_KEYWORD_LIMIT,
	type LoadSqpParams,
	type LoadSqpResult,
	MAX_KEYWORD_LIMIT,
	type SqpKeywordRow,
	type SqpPeriodRow,
	type SqpTimeUnit,
	VALID_SQP_TIME_UNITS,
} from "./types.ts";

function fail(msg: string): Result.Result<never, Error> {
	return Result.fail(new Error(msg));
}

function round3(n: number): number {
	return Math.round(n * 1000) / 1000;
}

function share(part: number, whole: number): number {
	return whole > 0 ? round3((part / whole) * 100) : 0;
}

/** Validate keywordLimit: a whole number from 1 to MAX_KEYWORD_LIMIT; above the maximum is rejected, not clamped. */
export function parseKeywordLimit(value: number | undefined): Result.Result<number, Error> {
	return Result.gen(function* () {
		if (value === undefined) {
			return DEFAULT_KEYWORD_LIMIT;
		}
		if (!Number.isInteger(value) || value < 1) {
			return yield* fail(`keywordLimit must be a whole number from 1 to ${MAX_KEYWORD_LIMIT}`);
		}
		if (value > MAX_KEYWORD_LIMIT) {
			return yield* fail(
				`keywordLimit ${value} exceeds the maximum of ${MAX_KEYWORD_LIMIT}; request ${MAX_KEYWORD_LIMIT} or fewer`,
			);
		}
		return value;
	});
}

export function loadSqp(params: LoadSqpParams, sql: postgres.Sql): Effect.Effect<LoadSqpResult, Error> {
	return Effect.gen(function* () {
		if (!params.stores) return yield* Effect.fromResult(fail("stores is required"));
		if (!params.when) return yield* Effect.fromResult(fail("when is required"));

		const timeUnit = (params.timeUnit ? params.timeUnit.toUpperCase() : "WEEK") as SqpTimeUnit;
		if (!VALID_SQP_TIME_UNITS.includes(timeUnit)) {
			return yield* Effect.fromResult(
				fail(`Unknown timeUnit '${params.timeUnit}'. Valid: ${VALID_SQP_TIME_UNITS.join(", ")}`),
			);
		}
		const keywordLimit = yield* Effect.fromResult(parseKeywordLimit(params.keywordLimit));

		const stores = yield* resolveStores(params.stores, sql);
		const range = yield* resolveWhen(params.when, sql);

		let asins: ProductSelection | null = null;
		if (params.products) {
			asins = yield* resolveProductsForStores(params.products, sql, stores);
			if (asins.size === 0) return yield* Effect.fromResult(fail("products resolved to zero ASINs"));
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
				eb.fn.sum<string | null>(eb.ref("asinImpressionCount")).as("our_impr"),
				eb.fn.sum<string | null>(eb.ref("asinClickCount")).as("our_clicks"),
				eb.fn.sum<string | null>(eb.ref("asinPurchaseCount")).as("our_purch"),
				// MAX, not SUM: the total* columns are whole-market figures that the
				// report repeats identically on every ASIN row of a (searchQuery,
				// marketplaceId, dateFirst) group. MAX reads that single value; SUM
				// would multiply it by the number of our ASINs that happen to rank for
				// the term.
				eb.fn.max<number | null>(eb.ref("totalQueryImpressionCount")).as("market_impr"),
				eb.fn.max<number | null>(eb.ref("totalClickCount")).as("market_clicks"),
				eb.fn.max<number | null>(eb.ref("totalPurchaseCount")).as("market_purch"),
			])
			.where("timeUnit", "=", timeUnit)
			// Keep exact pairs: separate IN lists would include unrequested stores
			// when different merchants are selected in different marketplaces.
			.where((eb) =>
				eb(
					eb.refTuple("merchantId", "marketplaceId"),
					"in",
					stores.map((s) => eb.tuple(s.merchantId, s.marketplaceId)),
				)
			)
			.where("dateFirst", ">=", isoDateParam(range.dateFirst))
			.where("dateFirst", "<=", isoDateParam(range.dateLast))
			// The empty search term is excluded here, so both statements leave it out — see the module doc.
			.where("searchQuery", "<>", "")
			.groupBy(["marketplaceId", "dateFirst", "searchQuery"]);
		// The products filter stays INSIDE the CTE — see the module doc.
		if (asins !== null) {
			perQuery = perQuery.where(productSelectionPredicate(asins, ksql.ref("asin"), ksql.ref("marketplaceId")));
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
