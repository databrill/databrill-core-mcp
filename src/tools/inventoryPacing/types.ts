/**
 * inventoryPacing — types. Ported from the agency repo
 * `lib/reports/inventoryPacing/types.ts` + `lib/reports/lowInventory/types.ts`.
 * Identity comes from resolved stores (not client.json); `sql` is injected.
 */

export type PacingAction = "pause" | "throttle" | "hold" | "ramp";

/** Per-ASIN inventory + runway (the lowInventory row). */
export interface LowInventoryRow {
	merchantId: string;
	country: string;
	asin: string;
	parentAsin: string | null;
	family: string;
	label: string;
	units1d: number;
	units7d: number;
	units28d: number;
	inventoryFba: number;
	inventoryFbm: number;
	inbound: number;
	runway: number | null;
	runwayWithInbound: number | null;
}

/** Per-family pacing recommendation. */
export interface PacingRow {
	merchantId: string;
	site: string;
	family: string;
	available: number; // FBA + FBM fulfillable
	inbound: number;
	velocityPerDay: number;
	runwayDays: number | null;
	runwayWithInboundDays: number | null;
	worstAsin: string | null;
	worstAsinLabel: string | null;
	worstAsinRunway: number | null;
	adSpendPerDay: number;
	adSalesPerDay: number;
	tacos: number | null;
	action: PacingAction;
	severity: "high" | "medium" | "low";
	rationale: string;
}

export interface LoadInventoryPacingParams {
	stores: string; // country/region/marketplaceId/'*'/{merchantId}-{scope}
	velocityDays?: number | undefined; // units/day window (default 7)
	spendWindowDays?: number | undefined; // ad spend/day window (default 7)
	criticalDays?: number | undefined; // runway ≤ → pause (default 7)
	lowDays?: number | undefined; // runway ≤ → throttle (default 21)
	overstockDays?: number | undefined; // runway ≥ → ramp (default 90)
	minSpendPerDay?: number | undefined; // ignore ad spend below this when deciding to cut (default 1)
	minVelocity?: number | undefined; // ignore families selling less than this/day (default 0.2)
}

export interface PacingConfig {
	velocityDays: number;
	spendWindowDays: number;
	criticalDays: number;
	lowDays: number;
	overstockDays: number;
	minSpendPerDay: number;
	minVelocity: number;
}

export interface LoadInventoryPacingResult {
	meta: { stores: string[]; familyCount: number; config: PacingConfig };
	data: PacingRow[];
}
