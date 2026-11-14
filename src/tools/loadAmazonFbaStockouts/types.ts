export interface LoadAmazonFbaStockoutsParams {
	readonly stores: string;
	readonly when?: string | undefined;
	readonly products?: string | undefined;
	readonly limit?: number | undefined;
}

/** `CLOSED_OUT`: fulfillable closed at zero for one or more days. `INTRADAY_DIP`: a day that reached zero and closed in stock. */
export type AmazonFbaStockoutEpisodeType = "CLOSED_OUT" | "INTRADAY_DIP";

/** Which source dated an end of an episode: FBA inventory history's fulfillable quantity, or the ledger's SELLABLE balance. */
export type AmazonFbaStockoutBasis = "FULFILLABLE" | "LEDGER_SELLABLE";

export interface AmazonFbaStockoutEpisode {
	readonly merchantId: string;
	readonly marketplaceId: string;
	readonly countryCode: string;
	readonly fnsku: string;
	/** From `amzfact_fnsku_fbaInventory_latest`; null when that table has no row for the FNSKU in the store. */
	readonly asin: string | null;
	/** Every `amzfact_sku_identity` seller SKU pointing at the FNSKU, sorted. */
	readonly sellerSkus: readonly string[];
	readonly episodeType: AmazonFbaStockoutEpisodeType;
	/** First day out; null when the FNSKU was already out where its source starts being read. */
	readonly stockoutDate: string | null;
	/** Null exactly when `stockoutDate` is null. */
	readonly stockoutBasis: AmazonFbaStockoutBasis | null;
	/** Set exactly when `stockoutDate` is null: a day on which the FNSKU was already out. */
	readonly outOnOrBefore: string | null;
	/** First later day closing in stock. */
	readonly backInStockDate: string | null;
	/** Null exactly when `backInStockDate` is null. */
	readonly backInStockBasis: AmazonFbaStockoutBasis | null;
	readonly isStillOut: boolean;
	readonly daysOut: number | null;
	/** Highest whole-day buyable future supply on the episode's history days; null when no history day is part of it. */
	readonly futureSupplyBuyableMax: number | null;
}

export interface AmazonFbaStockoutsStoreMeta {
	readonly merchantId: string;
	readonly marketplaceId: string;
	readonly countryCode: string;
	/** Local date in the marketplace's time zone. */
	readonly today: string;
	readonly historyStartsBeforeDateFirst: boolean;
	readonly historyStartsAt: string | null;
	/** The days of the range this store reads from the ledger; null when none. */
	readonly ledgerDateFirst: string | null;
	readonly ledgerDateLast: string | null;
	/** The merchant's newest ledger summary day; null when the ledger is not read or has no summary rows. */
	readonly ledgerSummaryDateLast: string | null;
	readonly ledgerDaysWithoutReport: readonly string[];
	readonly ledgerCenterCountryCodes: readonly string[];
}

export interface LoadAmazonFbaStockoutsResult {
	readonly meta: {
		readonly source: "Amazon FBA inventory history; Amazon FBA inventory ledger";
		readonly criterion: string;
		readonly grain: string;
		readonly dateFirst: string;
		readonly dateLast: string;
		readonly stores: readonly AmazonFbaStockoutsStoreMeta[];
		readonly ledgerCentersWithoutCountry: readonly string[];
		readonly rowCount: number;
		readonly limit: number;
		readonly isTruncated: boolean;
		readonly missingTables: readonly string[];
		readonly notes: readonly string[];
	};
	readonly data: readonly AmazonFbaStockoutEpisode[];
}

/** An episode as one source reports it, before `load.ts` merges the sources and adds labels. */
export interface AmazonFbaStockoutEpisodeDraft {
	readonly merchantId: string;
	readonly marketplaceId: string;
	readonly fnsku: string;
	readonly episodeType: AmazonFbaStockoutEpisodeType;
	readonly stockoutDate: string | null;
	readonly stockoutBasis: AmazonFbaStockoutBasis | null;
	readonly outOnOrBefore: string | null;
	readonly backInStockDate: string | null;
	readonly backInStockBasis: AmazonFbaStockoutBasis | null;
	readonly futureSupplyBuyableMax: number | null;
	/** History: the episode begins on the FNSKU's first history row, which has no earlier row. */
	readonly isOutOnFirstHistoryRow: boolean;
	/** Ledger: still out on the store's last ledger day, the day before its history starts. */
	readonly isOpenAtLedgerEnd: boolean;
}
