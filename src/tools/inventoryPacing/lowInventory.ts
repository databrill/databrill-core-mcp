/**
 * Per-ASIN inventory + runway — portable port of the agency
 * `lib/reports/lowInventory/load.ts`. Identity comes from the already-resolved
 * stores (merchant × marketplace) instead of `clients/{alias}/client.json`; the
 * connection is injected. FBM, family/label, and catalog parentAsin lookups are
 * best-effort (a missing table degrades to a fallback, never throws).
 *
 * Reads: amzreport_SALES_AND_TRAFFIC__skuByDay, amzreport_ALL_ORDERS,
 * amzspapi_catalog_items_v20220401__catalogitem, amzspapi_fbaInventory_v1__InventorySummary,
 * amzreport_MERCHANT_LISTINGS_ALL, brand_config_amazon_asin/_family.
 */

import type postgres from "postgres";
import { DateTime } from "luxon";
import { marketplaceIdToMarketplaceInfo } from "../../amazonConstants.ts";
import type { ResolvedStore } from "../loadAds/loadAds.ts";
import type { LowInventoryRow } from "./types.ts";

export async function loadLowInventory(
	sql: postgres.Sql,
	stores: ResolvedStore[],
	velocityDaysRaw: number,
): Promise<LowInventoryRow[]> {
	const velocityDays = Math.min(velocityDaysRaw, 28);
	const allRows: LowInventoryRow[] = [];

	for (const store of stores) {
		const marketplaceId = store.marketplaceId;
		const merchantId = store.merchantId;
		const mpInfo = marketplaceIdToMarketplaceInfo[marketplaceId];
		if (!mpInfo) continue;
		const site = mpInfo.countryCode.toUpperCase();
		const tz = mpInfo.timeZone;
		const yesterday = DateTime.now().setZone(tz).minus({ days: 1 }).toISODate()!;
		const day28start = DateTime.fromISO(yesterday).minus({ days: 27 }).toISODate()!;
		const day7start = DateTime.fromISO(yesterday).minus({ days: 6 }).toISODate()!;

		const [stMaxRow] = await sql`
			SELECT MAX("date")::text AS "maxDate"
			FROM "amzreport_SALES_AND_TRAFFIC__skuByDay"
			WHERE "marketplaceId" = ${marketplaceId} AND "merchantId" = ${merchantId}
		`;
		const maxSTDate: string | null = stMaxRow?.maxDate ?? null;
		const yesterdayMinus1 = DateTime.fromISO(yesterday).minus({ days: 1 }).toISODate()!;
		const stEnd = maxSTDate && maxSTDate < yesterdayMinus1 ? maxSTDate : yesterdayMinus1;
		const aoStart = DateTime.fromISO(stEnd).plus({ days: 1 }).toISODate()!;

		// Q1 — S&T units (7d / 28d)
		type UnitsAcc = { units1d: number; units7d: number; units28d: number };
		const unitsByAsin = new Map<string, UnitsAcc>();
		if (stEnd >= day28start) {
			const stRows = await sql`
				SELECT "childAsin" AS "asin",
					SUM(CASE WHEN "date" >= ${day7start} THEN ("sales"->>'unitsOrdered')::int ELSE 0 END)::int AS "units7d",
					SUM(("sales"->>'unitsOrdered')::int)::int AS "units28d"
				FROM "amzreport_SALES_AND_TRAFFIC__skuByDay"
				WHERE "marketplaceId" = ${marketplaceId} AND "merchantId" = ${merchantId}
					AND "date" >= ${day28start} AND "date" <= ${stEnd}
				GROUP BY "childAsin"
			`;
			for (const r of stRows) {
				unitsByAsin.set(r.asin, {
					units1d: 0,
					units7d: Number(r.units7d) || 0,
					units28d: Number(r.units28d) || 0,
				});
			}
		}

		// Q2 — ALL_ORDERS units (the recent tail S&T hasn't caught up to)
		if (aoStart <= yesterday) {
			const aoRows = await sql`
				SELECT "asin",
					SUM(CASE WHEN "localdate" = ${yesterday} THEN "quantity" ELSE 0 END)::int AS "units1d",
					SUM(CASE WHEN "localdate" >= ${day7start} THEN "quantity" ELSE 0 END)::int AS "units7d",
					SUM("quantity")::int AS "units28d"
				FROM "amzreport_ALL_ORDERS"
				WHERE "marketplace_id" = ${marketplaceId} AND "merchant_id" = ${merchantId}
					AND "localdate" >= ${aoStart} AND "localdate" <= ${yesterday}
					AND "order_status" != 'Cancelled' AND "asin" IS NOT NULL
				GROUP BY "asin"
			`;
			for (const r of aoRows) {
				const e = unitsByAsin.get(r.asin);
				if (e) {
					e.units1d += Number(r.units1d) || 0;
					e.units7d += Number(r.units7d) || 0;
					e.units28d += Number(r.units28d) || 0;
				} else {
					unitsByAsin.set(r.asin, {
						units1d: Number(r.units1d) || 0,
						units7d: Number(r.units7d) || 0,
						units28d: Number(r.units28d) || 0,
					});
				}
			}
		}

		for (const [asin, u] of unitsByAsin) {
			if (u.units1d === 0 && u.units7d === 0 && u.units28d === 0) unitsByAsin.delete(asin);
		}
		if (unitsByAsin.size === 0) continue;

		const topAsins = [...unitsByAsin.keys()];

		// Q3 — parentAsin (best-effort: catalog, then S&T fallback)
		const parentAsinMap = new Map<string, string | null>();
		try {
			const catalogRows = await sql`
				SELECT "asin", "parent_asin" AS "parentAsin"
				FROM "amzspapi_catalog_items_v20220401__catalogitem"
				WHERE "asin" = ANY(${topAsins})
			`;
			for (const r of catalogRows) if (r.asin) parentAsinMap.set(r.asin, r.parentAsin ?? null);
		} catch { /* best-effort */ }
		const missingParent = topAsins.filter((a) => !parentAsinMap.has(a));
		if (missingParent.length > 0) {
			try {
				const stParentRows = await sql`
					SELECT DISTINCT ON ("childAsin") "childAsin" AS "asin", "parentAsin"
					FROM "amzreport_SALES_AND_TRAFFIC__skuByDay"
					WHERE "marketplaceId" = ${marketplaceId} AND "merchantId" = ${merchantId}
						AND "childAsin" = ANY(${missingParent})
					ORDER BY "childAsin", "date" DESC
				`;
				for (const r of stParentRows) parentAsinMap.set(r.asin, r.parentAsin ?? null);
			} catch { /* best-effort */ }
		}

		// Q4 — FBA inventory (the runway driver)
		const fbaMap = new Map<string, { inventoryFba: number; inbound: number }>();
		const fbaRows = await sql`
			SELECT "doc"->>'asin' AS "asin",
				SUM(COALESCE(("doc"->'inventoryDetails'->>'fulfillableQuantity')::int, 0))::int AS "inventoryFba",
				SUM(COALESCE(("doc"->'inventoryDetails'->>'inboundReceivingQuantity')::int, 0)
					+ COALESCE(("doc"->'inventoryDetails'->>'inboundShippedQuantity')::int, 0))::int AS "inbound"
			FROM "amzspapi_fbaInventory_v1__InventorySummary"
			WHERE "marketplaceId" = ${marketplaceId} AND "doc"->>'asin' = ANY(${topAsins})
			GROUP BY "doc"->>'asin'
		`;
		for (const r of fbaRows) {
			fbaMap.set(r.asin, { inventoryFba: Number(r.inventoryFba) || 0, inbound: Number(r.inbound) || 0 });
		}

		// Q5 — FBM inventory (best-effort)
		const fbmMap = new Map<string, number>();
		try {
			const fbmRows = await sql`
				SELECT "asin", SUM("skuQty")::int AS "inventoryFbm" FROM (
					SELECT "doc"->>'asin1' AS "asin", "sellerSku",
						MAX(COALESCE(("doc"->>'quantity')::int, 0))::int AS "skuQty"
					FROM "amzreport_MERCHANT_LISTINGS_ALL"
					WHERE "deletedAt" IS NULL AND "doc"->>'fulfillment-channel' = 'DEFAULT'
						AND "marketplaceId" = ${marketplaceId} AND "doc"->>'asin1' = ANY(${topAsins})
					GROUP BY "doc"->>'asin1', "sellerSku"
				) t
				GROUP BY "asin"
			`;
			for (const r of fbmRows) fbmMap.set(r.asin, Number(r.inventoryFbm) || 0);
		} catch { /* best-effort */ }

		// Q6 — family / label (best-effort)
		const familyMap = new Map<string, { family: string; label: string }>();
		try {
			const familyRows = await sql`
				SELECT aa."asin", aa."family", aa."labelInFamily", aa."countryToLabelInFamily",
					aa."labelStandalone", aa."msku", af."label" AS "familyLabel"
				FROM "brand_config_amazon_asin" aa
				LEFT JOIN "brand_config_amazon_family" af ON af."family" = aa."family"
				WHERE aa."asin" = ANY(${topAsins})
			`;
			for (const r of familyRows) {
				const ctlif = r.countryToLabelInFamily as Record<string, string> | null;
				const label = (ctlif && ctlif[site]) ?? r.labelInFamily ?? r.labelStandalone ?? r.msku ?? r.asin;
				familyMap.set(r.asin, { family: r.family ?? "**UNKNOWN**", label });
			}
		} catch {
			for (const a of topAsins) familyMap.set(a, { family: "**ERROR**", label: a });
		}

		// Compute velocity & runway per ASIN
		for (const asin of topAsins) {
			const units = unitsByAsin.get(asin)!;
			const fba = fbaMap.get(asin) ?? { inventoryFba: 0, inbound: 0 };
			const inventoryFbm = fbmMap.get(asin) ?? 0;
			const fam = familyMap.get(asin) ?? { family: "**UNKNOWN**", label: asin };
			const pAsin = parentAsinMap.get(asin) ?? null;

			let unitsDaily: number;
			if (velocityDays <= 1) unitsDaily = units.units1d;
			else if (velocityDays <= 7) unitsDaily = units.units7d / velocityDays;
			else unitsDaily = units.units28d / velocityDays;

			const totalInventory = fba.inventoryFba + inventoryFbm;
			const runway = unitsDaily > 0 ? Math.min(9999, Math.round(totalInventory / unitsDaily)) : null;
			const runwayWithInbound = unitsDaily > 0
				? Math.min(9999, Math.round((totalInventory + fba.inbound) / unitsDaily))
				: null;

			allRows.push({
				merchantId,
				country: site,
				asin,
				parentAsin: pAsin,
				family: fam.family,
				label: fam.label,
				units1d: units.units1d,
				units7d: units.units7d,
				units28d: units.units28d,
				inventoryFba: fba.inventoryFba,
				inventoryFbm,
				inbound: fba.inbound,
				runway,
				runwayWithInbound,
			});
		}
	}

	return allRows;
}
