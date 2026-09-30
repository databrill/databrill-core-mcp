/**
 * loadRank — types. Generalized from the original `queries/bsr.ts` (US-only,
 * single `amazon_sales_rank__us`) to any marketplace by selecting the
 * per-marketplace `amazon_sales_rank__{cc}` table(s) in scope.
 */

/** A numeric browse-node key is a subcategory; any other key is a top-level department. */
export type RankCategoryKind = "subcategory" | "department";

export interface RankPoint {
	country: string;
	asin: string;
	date: string; // YYYY-MM-DD, the marketplace's local calendar day
	observedAt: string; // ISO 8601 UTC time of the snapshot kept for that day
	rank: number;
	category: string; // raw code (numeric id or label)
	categoryKind: RankCategoryKind;
	categoryName: string;
}

export interface LoadRankParams {
	stores: string;
	when: string;
	products?: string | undefined;
}

export interface LoadRankResult {
	meta: {
		dateFirst: string;
		dateLast: string;
		stores: string[]; // marketplaces that actually have a rank table
		missingRankTables: string[]; // requested countries with no amazon_sales_rank__{cc}
		rowCount: number;
	};
	data: RankPoint[];
}
