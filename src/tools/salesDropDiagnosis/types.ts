/**
 * Sales-drop diagnosis — types. Ported from the agency repo
 * `lib/reports/salesDropDiagnosis/types.ts`; only `LoadConfig` changed: no
 * `clientAlias` (the `sql` is injected). The inventory signal is kept — a
 * diagnostic must integrate stockout causes, not omit them — and is sourced from
 * the same client-DB `loadLowInventory` the `inventoryPacing` tool uses.
 *
 * Core identity (per day, window totals): sales = sessions × unitConversion × ASP.
 * Logs make the three factors additive, so each factor's share of the total
 * log-change is a defensible attribution of the drop.
 */

/** A window of summed daily metrics plus its derived per-day factors. */
export interface WindowAgg {
	days: number;
	dateFirst: string;
	dateLast: string;
	sales: number;
	units: number;
	orders: number;
	sessions: number;
	sessionDays: number; // days in the window that Sales & Traffic reported
	sessionUnits: number; // units on those same days (aligned with sessions)
	spend: number;
	clicks: number;
	adOrders: number;
	adSales: number;
	salesPerDay: number;
	sessionsPerDay: number | null;
	unitConversion: number | null;
	asp: number | null;
	adSalesPerDay: number;
	organicSalesPerDay: number;
	adCr: number | null;
	cpc: number | null;
}

/** One candidate cause from the funnel decomposition. */
export interface DropCause {
	key: "traffic" | "conversion" | "price";
	label: string;
	contribution: number | null;
	approxPctEffect: number | null;
	share: number | null;
	direction: "fell" | "rose" | "flat" | "n/a";
	baseline: number | null;
	recent: number | null;
	evidence: string;
}

/** A supplementary, non-additive signal that contextualises the causes. */
export interface ContributingSignal {
	key: "ad-channel" | "organic-channel" | "ad-efficiency" | "inventory";
	label: string;
	severity: "high" | "medium" | "low" | "info";
	evidence: string;
}

/** A low-runway ASIN flagged as a possible cause of the drop. */
export interface InventoryFlag {
	asin: string;
	label: string;
	family: string;
	runway: number | null;
	runwayWithInbound: number | null;
	inventoryAvailable: number;
	inbound: number;
}

/** Full diagnosis for one store ({merchantId, site}). */
export interface StoreDiagnosis {
	store: string;
	merchantId: string;
	site: string;
	currency: string;
	asOf: string;
	baselineWindow: WindowAgg;
	recentWindow: WindowAgg;
	deltaPct: number | null;
	totalLogChange: number | null;
	isDrop: boolean;
	causes: DropCause[];
	signals: ContributingSignal[];
	inventoryFlags: InventoryFlag[];
	notes: string[];
}

export interface LoadConfig {
	readonly stores: string[] | null; // --stores filter tokens; null = configured countries
	readonly allStores: boolean;
	readonly recentDays: number; // default 7
	readonly baselineDays: number; // default 28
	readonly dropThreshold: number; // default 0.10 (10% fall flags a drop)
	readonly inventoryRunwayMax: number; // default 14 — flag ASINs at or below this runway
	readonly skipInventory: boolean; // skip the inventory join (faster)
}

export type OutputFormat = "console" | "markdown" | "json";
