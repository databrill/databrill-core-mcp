/**
 * loadEconomics — per-advertised-ASIN profitability. Fetches the ad rollup via
 * `loadAds` (groupBy=asin, with halo) and applies `computeEconomics`. The
 * cost inputs (price/COGS/fees) are NOT in the client DB, so the caller supplies
 * them in `economics`; without them, margins are zero and source="missing"
 * (the rollup — spend, ad cost per sale, halo revenue — still comes back).
 */

import postgres from "postgres";
import { loadAds } from "../loadAds/loadAds.ts";
import { type AdvertisedAsinRollup, computeEconomics, type EconomicsInput, type PerSaleEconomics } from "./economics.ts";

function fail(msg: string): never {
	throw new Error(msg);
}

function round2(n: number): number {
	return Math.round(n * 100) / 100;
}

export interface LoadEconomicsParams {
	stores: string;
	when: string;
	products?: string | undefined;
	economics?: EconomicsInput | null;
}

export interface LoadEconomicsResult {
	meta: { dateFirst: string; dateLast: string; stores: string[]; rowCount: number; hasCostInputs: boolean };
	rollup: AdvertisedAsinRollup[];
	economics: PerSaleEconomics[];
}

export async function loadEconomics(params: LoadEconomicsParams, sql: postgres.Sql): Promise<LoadEconomicsResult> {
	if (!params.stores) fail("stores is required");
	if (!params.when) fail("when is required");

	const ads = await loadAds(
		{ stores: params.stores, when: params.when, groupBy: "asin", products: params.products, derived: false },
		sql,
	);

	const rollup: AdvertisedAsinRollup[] = ads.data.map((r) => {
		const spend = Number(r.spend ?? 0);
		const clicks = Number(r.clicks ?? 0);
		const units = Number(r.units ?? 0);
		const revenue = Number(r.revenue ?? 0);
		const haloRev = Number(r.revenueHaloIn ?? 0);
		return {
			asin: String(r.asin ?? ""),
			totalSpend: round2(spend),
			totalDirectOrders: units,
			totalDirectRev: round2(revenue),
			totalHaloRev: round2(haloRev),
			avgCpc: clicks > 0 ? round2(spend / clicks) : 0,
			avgCr: clicks > 0 ? round2((units / clicks) * 100) : 0,
			avgAcos: revenue > 0 ? round2((spend / revenue) * 100) : 0,
			avgRoas: spend > 0 ? round2(revenue / spend) : 0,
		};
	}).sort((a, b) => b.totalSpend - a.totalSpend);

	const economics = computeEconomics(rollup, params.economics ?? null);

	return {
		meta: {
			dateFirst: ads.meta.dateFirst,
			dateLast: ads.meta.dateLast,
			stores: ads.meta.stores,
			rowCount: rollup.length,
			hasCostInputs: !!params.economics,
		},
		rollup,
		economics,
	};
}
