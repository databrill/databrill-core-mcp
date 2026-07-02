/**
 * loadSqp — types. Generalized from the original `queries/sqp.ts` (US-pinned,
 * family-scoped) to multi-marketplace with an optional product filter.
 *
 * SQP is Amazon's Search Query Performance report: for each (search query, ASIN,
 * period) it gives our counts and the whole-market totals, so "share" = ours/market.
 */

export const VALID_SQP_TIME_UNITS = ["WEEK", "MONTH"] as const;
export type SqpTimeUnit = typeof VALID_SQP_TIME_UNITS[number];

/** Our-vs-market totals for one marketplace in one SQP period. */
export interface SqpPeriodRow {
	country: string;
	marketplaceId: string;
	period: string; // dateFirst of the SQP period (YYYY-MM-DD)
	ourImpr: number;
	marketImpr: number;
	ourClicks: number;
	marketClicks: number;
	ourPurchases: number;
	marketPurchases: number;
	imprShare: number; // percent
	clickShare: number; // percent
	purchShare: number; // percent
}

/** One search query aggregated across the scope, with our share of the market. */
export interface SqpKeywordRow {
	q: string;
	mktImpr: number;
	ourImpr: number;
	imprShare: number; // percent
	ourClicks: number;
	clickShare: number; // percent
	ourPurch: number;
	purchShare: number; // percent
}

export interface LoadSqpParams {
	stores: string;
	when: string;
	products?: string | undefined; // optional family/parent/child ASIN filter
	timeUnit?: string | undefined; // WEEK (default) | MONTH
	keywordLimit?: number | undefined; // top-N keywords by market impressions (default 25)
}

export interface LoadSqpResult {
	meta: {
		dateFirst: string;
		dateLast: string;
		stores: string[];
		timeUnit: SqpTimeUnit;
		periodCount: number;
		keywordCount: number;
	};
	periods: SqpPeriodRow[];
	keywords: SqpKeywordRow[];
}
