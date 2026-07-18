/**
 * Profitability compute — ported verbatim (logic) from the original
 * `listingAnalysis/economics.ts`. Pure: no DB, no marketplace coupling.
 *
 * Needs per-ASIN cost inputs (price/COGS/fees) supplied by the caller — the
 * client DB does not hold COGS. When no economics input is given, margins are
 * zero and `source` is "missing".
 */

export interface PerAsinEconomics {
	asin: string;
	price: number;
	cogs: number;
	fbaPickPack: number;
	referralPct: number; // e.g. 0.15
	storage: number;
	source: "sheet" | "default" | "missing";
}

export interface EconomicsInput {
	perAsin: Record<string, PerAsinEconomics>;
	familyDefault?: PerAsinEconomics;
}

/** Ad totals per advertised ASIN — the rollup `computeEconomics` consumes. */
export interface AdvertisedAsinRollup {
	asin: string;
	totalSpend: number;
	totalDirectOrders: number;
	totalDirectRev: number;
	totalHaloRev: number;
	avgCpc: number;
	avgCr: number; // percent
	avgAcos: number; // percent
	avgRoas: number;
}

export interface PerSaleEconomics {
	asin: string;
	price: number;
	cogs: number;
	fbaPickPack: number;
	referralFee: number;
	storage: number;
	netBeforeAds: number;
	netMarginPct: number;
	avgAdCostPerSale: number;
	netPerAdSaleNoHalo: number;
	haloProfitPerAdSale: number;
	netPerAdSaleWithHalo: number;
	source: PerAsinEconomics["source"];
}

function round2(n: number): number {
	return Math.round(n * 100) / 100;
}

export function computeEconomics(
	advertisedAsins: AdvertisedAsinRollup[],
	economics: EconomicsInput | null,
	familyMarginOverridePct?: number,
): PerSaleEconomics[] {
	if (!economics) {
		return advertisedAsins.map((a) => ({
			asin: a.asin,
			price: 0,
			cogs: 0,
			fbaPickPack: 0,
			referralFee: 0,
			storage: 0,
			netBeforeAds: 0,
			netMarginPct: 0,
			avgAdCostPerSale: 0,
			netPerAdSaleNoHalo: 0,
			haloProfitPerAdSale: 0,
			netPerAdSaleWithHalo: 0,
			source: "missing",
		}));
	}

	return advertisedAsins.map((a) => {
		const e = economics.perAsin[a.asin] ?? economics.familyDefault ?? null;
		const source: PerAsinEconomics["source"] = economics.perAsin[a.asin] ? "sheet" : e ? "default" : "missing";
		const price = e?.price ?? 0;
		const cogs = e?.cogs ?? 0;
		const fbaPickPack = e?.fbaPickPack ?? 0;
		const referralPct = e?.referralPct ?? 0.15;
		const storage = e?.storage ?? 0;
		const referralFee = round2(price * referralPct);
		const netBeforeAds = round2(price - cogs - fbaPickPack - referralFee - storage);
		const netMarginPct = price > 0 ? round2((netBeforeAds / price) * 100) : 0;
		const avgAdCostPerSale = a.totalDirectOrders > 0 ? round2(a.totalSpend / a.totalDirectOrders) : 0;
		const netPerAdSaleNoHalo = round2(netBeforeAds - avgAdCostPerSale);
		const familyMarginPct = familyMarginOverridePct ?? netMarginPct;
		const haloRevPerAdSale = a.totalDirectOrders > 0 ? a.totalHaloRev / a.totalDirectOrders : 0;
		const haloProfitPerAdSale = round2(haloRevPerAdSale * (familyMarginPct / 100));
		const netPerAdSaleWithHalo = round2(netPerAdSaleNoHalo + haloProfitPerAdSale);
		return {
			asin: a.asin,
			price,
			cogs,
			fbaPickPack,
			referralFee,
			storage,
			netBeforeAds,
			netMarginPct,
			avgAdCostPerSale,
			netPerAdSaleNoHalo,
			haloProfitPerAdSale,
			netPerAdSaleWithHalo,
			source,
		};
	});
}
