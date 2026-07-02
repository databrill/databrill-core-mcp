/**
 * Per-family ad-spend / sales / TACoS over a window — portable port of the
 * digest `_shared.loadFamilyWindow`. Joins the placement ad report and ALL_ORDERS
 * to `brand_config_amazon_asin.family`. TACoS = family ad spend / family total sales.
 */

import type postgres from "postgres";
import { marketplaceIdToMarketplaceInfo } from "../../amazonConstants.ts";

export interface FamilyAgg {
	merchantId: string;
	site: string;
	family: string;
	spend: number;
	adSales: number;
	totalSales: number;
	tacos: number | null;
}

function siteOf(marketplaceId: string): string | null {
	return marketplaceIdToMarketplaceInfo[marketplaceId]?.countryCode ?? null;
}

export async function loadFamilyWindow(
	sql: postgres.Sql,
	merchantIds: string[],
	since: string,
): Promise<FamilyAgg[]> {
	const adRows = await sql`
		SELECT ad."merchantId", ad."marketplaceId",
			COALESCE(bca."family", '(unmapped)') AS "family",
			SUM(ad."totalCost")::numeric AS "spend",
			SUM(ad."sales")::numeric AS "adSales"
		FROM "amzadapi_reports_v1__search_asin_placement__byDay" ad
		LEFT JOIN "brand_config_amazon_asin" bca ON bca."asin" = ad."advertisedProductId"
		WHERE ad."merchantId" = ANY(${merchantIds}) AND ad."date" >= ${since}
		GROUP BY ad."merchantId", ad."marketplaceId", COALESCE(bca."family", '(unmapped)')
	`;
	const salesRows = await sql`
		SELECT ao."merchant_id" AS "merchantId", ao."marketplace_id" AS "marketplaceId",
			COALESCE(bca."family", '(unmapped)') AS "family",
			SUM(ao."item_price" - COALESCE(ao."item_promotion_discount", 0))::numeric AS "totalSales"
		FROM "amzreport_ALL_ORDERS" ao
		LEFT JOIN "brand_config_amazon_asin" bca ON bca."asin" = ao."asin"
		WHERE ao."merchant_id" = ANY(${merchantIds}) AND ao."localdate" >= ${since}
			AND ao."order_status" != 'Cancelled'
		GROUP BY ao."merchant_id", ao."marketplace_id", COALESCE(bca."family", '(unmapped)')
	`;

	const key = (m: string, mp: string, f: string) => `${m}|||${mp}|||${f}`;
	const map = new Map<string, FamilyAgg>();
	const ensure = (merchantId: string, mp: string, fam: string): FamilyAgg | null => {
		const site = siteOf(mp);
		if (!site) return null;
		const k = key(merchantId, mp, fam);
		let e = map.get(k);
		if (!e) {
			e = { merchantId, site, family: fam, spend: 0, adSales: 0, totalSales: 0, tacos: null };
			map.set(k, e);
		}
		return e;
	};

	for (const r of adRows) {
		const e = ensure(r.merchantId, r.marketplaceId, r.family);
		if (!e) continue;
		e.spend += Number(r.spend ?? 0);
		e.adSales += Number(r.adSales ?? 0);
	}
	for (const r of salesRows) {
		const e = ensure(r.merchantId, r.marketplaceId, r.family);
		if (!e) continue;
		e.totalSales += Number(r.totalSales ?? 0);
	}
	for (const e of map.values()) e.tacos = e.totalSales > 0 ? e.spend / e.totalSales : null;
	return [...map.values()];
}
