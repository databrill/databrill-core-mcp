/**
 * loadTraffic — types. Generalized from the original `listingAnalysis/queries/sessions.ts`
 * (which was US-pinned and single-client family-scoped) into a multi-marketplace,
 * any-client loader over the Sales & Traffic report.
 */

export const VALID_TRAFFIC_GROUP_BY = ["asin", "family"] as const;
export type TrafficGroupBy = typeof VALID_TRAFFIC_GROUP_BY[number];

export const VALID_TRAFFIC_TIME_UNITS = ["DAY", "WEEK", "MONTH"] as const;
export type TrafficTimeUnit = typeof VALID_TRAFFIC_TIME_UNITS[number];

/** One bucket of Sales & Traffic metrics for one ASIN (or family) in one marketplace. */
export interface TrafficRow {
	country: string; // marketplace country code (DE, US, …)
	marketplaceId: string;
	period: string; // bucket label: the day (DAY) or week/month end date (YYYY-MM-DD)
	asin?: string; // present when groupBy = asin
	family?: string; // present when groupBy = family
	sessions: number;
	units: number; // unitsOrdered
	sales: number; // orderedProductSales amount
	cr: number; // units / sessions, percent
}

export interface LoadTrafficParams {
	stores: string; // same spec as loadAds: country/region/marketplaceId/'*'/{merchantId}-{scope}
	when: string; // ISO interval or duration
	groupBy?: string | undefined; // asin (default) | family
	timeUnit?: string | undefined; // WEEK (default) | DAY | MONTH
	products?: string | undefined; // optional family names / parent / child ASIN filter
}

export interface LoadTrafficResult {
	meta: {
		dateFirst: string;
		dateLast: string;
		stores: string[];
		rowCount: number;
		groupBy: TrafficGroupBy;
		timeUnit: TrafficTimeUnit;
	};
	data: TrafficRow[];
}
