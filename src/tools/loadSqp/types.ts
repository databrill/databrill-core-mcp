/**
 * loadSqp — types. Generalized from the original `queries/sqp.ts` (US-pinned,
 * family-scoped) to multi-marketplace with an optional product filter.
 *
 * SQP is Amazon's Search Query Performance report: for each (search query, ASIN,
 * period) it gives our counts and the whole-market totals, so "share" = ours/market.
 * The whole-market totals are repeated identically on every ASIN row of a
 * (search query, marketplace, period) group and must never be summed across ASINs
 * — see the grain rule in `load.ts`.
 */

export const VALID_SQP_TIME_UNITS = ["WEEK", "MONTH"] as const;
export type SqpTimeUnit = typeof VALID_SQP_TIME_UNITS[number];

/** Our-vs-market totals for one marketplace in one SQP period. */
export interface SqpPeriodRow {
	readonly country: string;
	readonly marketplaceId: string;
	readonly period: string; // dateFirst of the SQP period (YYYY-MM-DD)
	readonly ourImpr: number;
	readonly marketImpr: number;
	readonly ourClicks: number;
	readonly marketClicks: number;
	readonly ourPurchases: number;
	readonly marketPurchases: number;
	readonly imprShare: number; // percent
	readonly clickShare: number; // percent
	readonly purchShare: number; // percent
}

/**
 * One search query aggregated across the scope, with our share of the market.
 *
 * All six counts are returned, not just the shares, so a caller can compute an
 * exact market CTR (`mktClicks / mktImpr`) and CVR (`mktPurch / mktClicks`).
 * Inverting a share instead (`ourClicks / (clickShare / 100)`) inherits the
 * `round3` error — severe at small shares — and is undefined when the share is 0.
 *
 * A market rate must be derived from these counts and NEVER from the report's
 * `clickData->totalClickRate` / `purchaseData->totalPurchaseRate` columns, which
 * are computed by Amazon against the query's search volume rather than its
 * impressions, so they do not combine with impression counts into a market CTR.
 * The `dbl-metrics-sqp` skill gives the same warning.
 */
export interface SqpKeywordRow {
	readonly q: string;
	readonly mktImpr: number;
	readonly ourImpr: number;
	readonly imprShare: number; // percent
	readonly mktClicks: number;
	readonly ourClicks: number;
	readonly clickShare: number; // percent
	readonly mktPurch: number;
	readonly ourPurch: number;
	readonly purchShare: number; // percent
}

export interface LoadSqpParams {
	readonly stores: string;
	readonly when: string;
	readonly products?: string | undefined; // optional family/parent/child ASIN filter
	readonly timeUnit?: string | undefined; // WEEK (default) | MONTH
	readonly keywordLimit?: number | undefined; // top-N keywords by market impressions (default 25)
}

export interface LoadSqpResult {
	readonly meta: {
		readonly dateFirst: string;
		readonly dateLast: string;
		readonly stores: readonly string[];
		readonly timeUnit: SqpTimeUnit;
		readonly periodCount: number;
		readonly keywordCount: number;
	};
	readonly periods: readonly SqpPeriodRow[];
	readonly keywords: readonly SqpKeywordRow[];
}
