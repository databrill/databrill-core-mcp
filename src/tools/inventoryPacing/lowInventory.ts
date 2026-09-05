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
import { createCanonicalQueryBuilder } from "@jsr/databrill__core-pg-kysely/canonical";
import { sql as ksql } from "kysely";
import { marketplaceIdToMarketplaceInfo } from "../../amazonConstants.ts";
import { isoDateParam, runCompiled } from "../../runCompiled.ts";
import { jsonbInt, jsonbText } from "../../sqlJson.ts";
import type { ResolvedStore } from "../loadAds/loadAds.ts";
import type { LowInventoryRow } from "./types.ts";

export async function loadLowInventory(
	sql: postgres.Sql,
	stores: ResolvedStore[],
	velocityDaysRaw: number,
): Promise<LowInventoryRow[]> {
	const velocityDays = Math.min(velocityDaysRaw, 28);
	const allRows: LowInventoryRow[] = [];
	// One builder for the whole invocation: it carries no per-store state (every
	// per-store value is a bind parameter), and it is where a future
	// `.withSchema(workspaceSchema)` would attach.
	const db = createCanonicalQueryBuilder();

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

		const [stMaxRow] = await runCompiled(
			sql,
			db
				.selectFrom("amzreport_SALES_AND_TRAFFIC__skuByDay")
				.select((eb) => eb.cast<string | null>(eb.fn.max("date"), "text").as("maxDate"))
				.where("marketplaceId", "=", marketplaceId)
				.where("merchantId", "=", merchantId)
				.compile(),
		);
		const maxSTDate: string | null = stMaxRow?.maxDate ?? null;
		const yesterdayMinus1 = DateTime.fromISO(yesterday).minus({ days: 1 }).toISODate()!;
		const stEnd = maxSTDate && maxSTDate < yesterdayMinus1 ? maxSTDate : yesterdayMinus1;
		const aoStart = DateTime.fromISO(stEnd).plus({ days: 1 }).toISODate()!;

		// Q1 — S&T units (7d / 28d)
		type UnitsAcc = { units1d: number; units7d: number; units28d: number };
		const unitsByAsin = new Map<string, UnitsAcc>();
		if (stEnd >= day28start) {
			const stRows = await runCompiled(
				sql,
				db
					.selectFrom("amzreport_SALES_AND_TRAFFIC__skuByDay")
					.select((eb) => [
						eb.ref("childAsin").as("asin"),
						eb.cast<number | null>(
							eb.fn.sum<number | null>(
								eb.case().when("date", ">=", isoDateParam(day7start))
									.then(jsonbInt(eb.ref("sales"), "unitsOrdered"))
									.else(ksql.lit(0))
									.end(),
							),
							"integer",
						).as("units7d"),
						eb.cast<number | null>(
							eb.fn.sum<number | null>(jsonbInt(eb.ref("sales"), "unitsOrdered")),
							"integer",
						).as("units28d"),
					])
					.where("marketplaceId", "=", marketplaceId)
					.where("merchantId", "=", merchantId)
					.where("date", ">=", isoDateParam(day28start))
					.where("date", "<=", isoDateParam(stEnd))
					.groupBy("childAsin")
					.compile(),
			);
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
			const aoRows = await runCompiled(
				sql,
				db
					.selectFrom("amzreport_ALL_ORDERS")
					.select((eb) => [
						"asin",
						eb.cast<number | null>(
							eb.fn.sum<number | null>(
								eb.case().when("localdate", "=", isoDateParam(yesterday)).then(eb.ref("quantity"))
									.else(ksql.lit(0)).end(),
							),
							"integer",
						).as("units1d"),
						eb.cast<number | null>(
							eb.fn.sum<number | null>(
								eb.case().when("localdate", ">=", isoDateParam(day7start)).then(eb.ref("quantity"))
									.else(ksql.lit(0)).end(),
							),
							"integer",
						).as("units7d"),
						eb.cast<number | null>(eb.fn.sum<number | null>("quantity"), "integer").as("units28d"),
					])
					.where("marketplace_id", "=", marketplaceId)
					.where("merchant_id", "=", merchantId)
					.where("localdate", ">=", isoDateParam(aoStart))
					.where("localdate", "<=", isoDateParam(yesterday))
					.where("order_status", "!=", "Cancelled")
					.where("asin", "is not", null)
					.groupBy("asin")
					.compile(),
			);
			for (const r of aoRows) {
				// Unreachable: the WHERE excludes a null "asin". The column is nullable in
				// the schema, so the inferred row type keeps the null the predicate removed.
				if (r.asin === null) continue;
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
			const catalogRows = await runCompiled(
				sql,
				db
					.selectFrom("amzspapi_catalog_items_v20220401__catalogitem")
					.select(["asin", "parent_asin as parentAsin"])
					.where((eb) => eb("asin", "=", eb.fn.any(ksql.val(topAsins))))
					.compile(),
			);
			for (const r of catalogRows) if (r.asin) parentAsinMap.set(r.asin, r.parentAsin ?? null);
		} catch { /* best-effort */ }
		const missingParent = topAsins.filter((a) => !parentAsinMap.has(a));
		if (missingParent.length > 0) {
			try {
				const stParentRows = await runCompiled(
					sql,
					db
						.selectFrom("amzreport_SALES_AND_TRAFFIC__skuByDay")
						.distinctOn("childAsin")
						.select(["childAsin as asin", "parentAsin"])
						.where("marketplaceId", "=", marketplaceId)
						.where("merchantId", "=", merchantId)
						.where((eb) => eb("childAsin", "=", eb.fn.any(ksql.val(missingParent))))
						// DISTINCT ON keeps the first row of each group in ORDER BY order, so
						// these two must stay in this order and "date" must stay desc.
						.orderBy("childAsin")
						.orderBy("date", "desc")
						.compile(),
				);
				for (const r of stParentRows) parentAsinMap.set(r.asin, r.parentAsin ?? null);
			} catch { /* best-effort */ }
		}

		// Q4 — FBA inventory (the runway driver)
		const fbaMap = new Map<string, { inventoryFba: number; inbound: number }>();
		const fbaRows = await runCompiled(
			sql,
			db
				.selectFrom("amzspapi_fbaInventory_v1__InventorySummary")
				.select((eb) => [
					jsonbText(eb.ref("doc"), "asin").as("asin"),
					eb.cast<number | null>(
						eb.fn.sum<number | null>(
							eb.fn.coalesce(
								jsonbInt(eb.ref("doc"), "inventoryDetails", "fulfillableQuantity"),
								ksql.lit(0),
							),
						),
						"integer",
					).as("inventoryFba"),
					eb.cast<number | null>(
						eb.fn.sum<number | null>(
							eb(
								eb.fn.coalesce(
									jsonbInt(eb.ref("doc"), "inventoryDetails", "inboundReceivingQuantity"),
									ksql.lit(0),
								),
								"+",
								eb.fn.coalesce(
									jsonbInt(eb.ref("doc"), "inventoryDetails", "inboundShippedQuantity"),
									ksql.lit(0),
								),
							),
						),
						"integer",
					).as("inbound"),
				])
				.where("marketplaceId", "=", marketplaceId)
				.where((eb) => eb(jsonbText(eb.ref("doc"), "asin"), "=", eb.fn.any(ksql.val(topAsins))))
				// `"doc"->>'asin'` is in the SELECT list, the WHERE and the GROUP BY, and
				// Postgres matches GROUP BY to SELECT by parse-tree equality — jsonbText
				// keeps the key a literal so all three emit the same text.
				.groupBy((eb) => jsonbText(eb.ref("doc"), "asin"))
				.compile(),
		);
		for (const r of fbaRows) {
			// Unreachable: `"doc"->>'asin' = ANY(...)` is never true for a null.
			if (r.asin === null) continue;
			fbaMap.set(r.asin, { inventoryFba: Number(r.inventoryFba) || 0, inbound: Number(r.inbound) || 0 });
		}

		// Q5 — FBM inventory (best-effort)
		const fbmMap = new Map<string, number>();
		try {
			const fbmRows = await runCompiled(
				sql,
				db
					.selectFrom((eb) =>
						eb
							.selectFrom("amzreport_MERCHANT_LISTINGS_ALL")
							.select((eb2) => [
								jsonbText(eb2.ref("doc"), "asin1").as("asin"),
								"sellerSku",
								eb2.cast<number | null>(
									eb2.fn.max<number | null>(
										eb2.fn.coalesce(jsonbInt(eb2.ref("doc"), "quantity"), ksql.lit(0)),
									),
									"integer",
								).as("skuQty"),
							])
							.where("deletedAt", "is", null)
							.where((eb2) => eb2(jsonbText(eb2.ref("doc"), "fulfillment-channel"), "=", "DEFAULT"))
							.where("marketplaceId", "=", marketplaceId)
							.where((eb2) =>
								eb2(jsonbText(eb2.ref("doc"), "asin1"), "=", eb2.fn.any(ksql.val(topAsins)))
							)
							.groupBy((eb2) => [jsonbText(eb2.ref("doc"), "asin1"), eb2.ref("sellerSku")])
							.as("t")
					)
					.select((eb) => [
						"asin",
						eb.cast<number | null>(eb.fn.sum<number | null>("skuQty"), "integer").as("inventoryFbm"),
					])
					.groupBy("asin")
					.compile(),
			);
			for (const r of fbmRows) {
				// Unreachable: the inner query's `"doc"->>'asin1' = ANY(...)` excludes nulls.
				if (r.asin === null) continue;
				fbmMap.set(r.asin, Number(r.inventoryFbm) || 0);
			}
		} catch { /* best-effort */ }

		// Q6 — family / label (best-effort)
		const familyMap = new Map<string, { family: string; label: string }>();
		try {
			const familyRows = await runCompiled(
				sql,
				db
					.selectFrom("brand_config_amazon_asin as aa")
					.leftJoin("brand_config_amazon_family as af", "af.family", "aa.family")
					.select([
						"aa.asin",
						"aa.family",
						"aa.labelInFamily",
						"aa.countryToLabelInFamily",
						"aa.labelStandalone",
						"aa.msku",
						"af.label as familyLabel",
					])
					.where((eb) => eb("aa.asin", "=", eb.fn.any(ksql.val(topAsins))))
					.compile(),
			);
			for (const r of familyRows) {
				// `countryToLabelInFamily` is `jsonb`, so the inferred type is `JsonValue`
				// — narrow it rather than assert. `amzlibraryapp`'s reader of the same
				// column does the same (`asRecord` then `strOrNull`, see
				// `amzlibraryapp/src/lib/queries/family.ts:91`).
				const ctlif = r.countryToLabelInFamily;
				const override = typeof ctlif === "object" && ctlif !== null && !Array.isArray(ctlif)
					? ctlif[site]
					: undefined;
				const label = (typeof override === "string" ? override : null) ?? r.labelInFamily ??
					r.labelStandalone ?? r.msku ?? r.asin;
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
