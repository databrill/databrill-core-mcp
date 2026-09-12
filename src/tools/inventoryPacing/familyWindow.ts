/**
 * Per-family ad spend and sales over a window.
 *
 * Rows with a real advertised ASIN carry Amazon's definitive attribution. The
 * signed reconciliation residual of each Sponsored Brands ad is emitted
 * separately and attributed to the first creative ASIN's family with an
 * explicit source.
 */

import { Effect } from "effect";
import type postgres from "postgres";
import { createCanonicalQueryBuilder } from "@jsr/databrill__core-pg-kysely/canonical";
import { sql as ksql } from "kysely";
import { marketplaceIdToMarketplaceInfo } from "../../amazonConstants.ts";
import { groupByWith } from "../../groupByWith.ts";
import { isoDateParam, runCompiled } from "../../runCompiled.ts";
import { jsonbText } from "../../sqlJson.ts";
import { summarizeAdMetrics } from "../../summarizeAdMetrics.ts";

export const SB_RESIDUAL_FIRST_ASIN = "SB_RESIDUAL_FIRST_ASIN";

export interface FamilyAgg {
	readonly merchantId: string;
	readonly site: string;
	readonly family: string;
	readonly source?: string;
	readonly adImpressions: number;
	readonly adClicks: number;
	readonly adOrders: number;
	readonly adUnits: number;
	readonly adSpend: number;
	readonly adSales: number;
	readonly totalSales: number;
}

function siteOf(marketplaceId: string): string | null {
	return marketplaceIdToMarketplaceInfo[marketplaceId]?.countryCode ?? null;
}

function familyKey(row: FamilyAgg): string {
	return `${row.merchantId}|||${row.site}|||${row.family}`;
}

export function loadFamilyWindow(
	sql: postgres.Sql,
	merchantIds: string[],
	since: string,
): Effect.Effect<FamilyAgg[], Error> {
	return Effect.gen(function* () {
		// One builder per invocation; it is where a future `.withSchema(workspaceSchema)` would attach.
		const db = createCanonicalQueryBuilder();

		const adRows = yield* runCompiled(
			sql,
			() =>
				db
					.with("sb_asin_lookup", (qb) =>
						qb
							.selectFrom("amzadapi_exports_v1__ad")
							.select((eb) => [
								"merchantId",
								"marketplaceId",
								"adId",
								eb.fn.coalesce(
									jsonbText(eb.ref("creative"), "products", 0, "productId"),
									jsonbText(eb.ref("creative"), "asins", 0),
								).as("first_asin"),
							])
							.where((eb) => eb("merchantId", "=", eb.fn.any(ksql.val(merchantIds))))
							.where("adProduct", "in", ["SPONSORED_BRANDS", "SPONSORED_BRANDS_VIDEO"]))
					.with("certain", (qb) =>
						qb
							.selectFrom("amzadapi_reports_v1__search_asin_placement__byDay as ad")
							.leftJoin("brand_config_amazon_asin as bca", "bca.asin", "ad.advertisedProductId")
							.select((eb) => [
								"ad.merchantId",
								"ad.marketplaceId",
								// `sql.lit`, not `eb.val`: this COALESCE is in both the SELECT list and
								// the GROUP BY, and Postgres matches those by parse-tree equality, so two
								// placeholders for the same literal would be rejected at runtime.
								eb.fn.coalesce("bca.family", ksql.lit("(unmapped)")).as("family"),
								eb.cast<string | null>(eb.val<string | null>(null), "text").as("source"),
								eb.cast<string | null>(eb.fn.sum<string | null>("ad.impressions"), "numeric").as(
									"adImpressions",
								),
								eb.cast<string | null>(eb.fn.sum<string | null>("ad.clicks"), "numeric").as(
									"adClicks",
								),
								eb.cast<string | null>(eb.fn.sum<string | null>("ad.purchases"), "numeric").as(
									"adOrders",
								),
								eb.cast<string | null>(eb.fn.sum<string | null>("ad.unitsSold"), "numeric").as(
									"adUnits",
								),
								eb.cast<string | null>(eb.fn.sum<string | null>("ad.totalCost"), "numeric").as(
									"adSpend",
								),
								eb.cast<string | null>(eb.fn.sum<string | null>("ad.sales"), "numeric").as(
									"adSales",
								),
							])
							.where((eb) => eb("ad.merchantId", "=", eb.fn.any(ksql.val(merchantIds))))
							.where("ad.date", ">=", isoDateParam(since))
							.where("ad.advertisedProductId", "<>", "")
							.groupBy((eb) => [
								"ad.merchantId",
								"ad.marketplaceId",
								eb.fn.coalesce("bca.family", ksql.lit("(unmapped)")),
							]))
					.with("sb_by_ad", (qb) =>
						qb
							.selectFrom("amzadapi_reports_v1__search_asin_placement__byDay as ad")
							.select((eb) => {
								function residual(
									column:
										| "impressions"
										| "clicks"
										| "purchases"
										| "unitsSold"
										| "totalCost"
										| "sales",
								) {
									return eb.cast<string>(
										eb(
											eb.fn.coalesce(
												eb.fn.sum<string>(`ad.${column}`).filterWhere(
													"ad.advertisedProductId",
													"=",
													"",
												),
												ksql.lit(0),
											),
											"-",
											eb.fn.coalesce(
												eb.fn.sum<string>(`ad.${column}`).filterWhere(
													"ad.advertisedProductId",
													"<>",
													"",
												),
												ksql.lit(0),
											),
										),
										"numeric",
									);
								}
								return [
									"ad.merchantId",
									"ad.marketplaceId",
									"ad.adId",
									residual("impressions").as("residual_impressions"),
									residual("clicks").as("residual_clicks"),
									residual("purchases").as("residual_orders"),
									residual("unitsSold").as("residual_units"),
									residual("totalCost").as("residual_spend"),
									residual("sales").as("residual_sales"),
								];
							})
							.where((eb) => eb("ad.merchantId", "=", eb.fn.any(ksql.val(merchantIds))))
							.where("ad.date", ">=", isoDateParam(since))
							.where("ad.adProduct", "=", "Sponsored Brands")
							.groupBy(["ad.merchantId", "ad.marketplaceId", "ad.adId"]))
					.with("guessed", (qb) =>
						qb
							.selectFrom("sb_by_ad as sb")
							.leftJoin("sb_asin_lookup as lookup", (join) =>
								join
									.onRef("lookup.merchantId", "=", "sb.merchantId")
									.onRef("lookup.marketplaceId", "=", "sb.marketplaceId")
									.onRef("lookup.adId", "=", "sb.adId"))
							.leftJoin("brand_config_amazon_asin as bca", "bca.asin", "lookup.first_asin")
							.select((eb) => [
								"sb.merchantId",
								"sb.marketplaceId",
								eb.fn.coalesce("bca.family", ksql.lit("(unmapped)")).as("family"),
								eb.cast<string>(eb.val(SB_RESIDUAL_FIRST_ASIN), "text").as("source"),
								eb.cast<string | null>(
									eb.fn.sum<string | null>("sb.residual_impressions"),
									"numeric",
								)
									.as("adImpressions"),
								eb.cast<string | null>(eb.fn.sum<string | null>("sb.residual_clicks"), "numeric")
									.as(
										"adClicks",
									),
								eb.cast<string | null>(eb.fn.sum<string | null>("sb.residual_orders"), "numeric")
									.as(
										"adOrders",
									),
								eb.cast<string | null>(eb.fn.sum<string | null>("sb.residual_units"), "numeric").as(
									"adUnits",
								),
								eb.cast<string | null>(eb.fn.sum<string | null>("sb.residual_spend"), "numeric").as(
									"adSpend",
								),
								eb.cast<string | null>(eb.fn.sum<string | null>("sb.residual_sales"), "numeric").as(
									"adSales",
								),
							])
							.where((eb) =>
								eb.or([
									// The CTE columns are `numeric` (typed `string`), so `sql.lit(0)` — a
									// `RawBuilder<number>` — is rejected. `sql.raw` emits the bare `0` the
									// original has; it receives a source-code literal, never caller data.
									eb("sb.residual_impressions", "<>", ksql.raw<string>("0")),
									eb("sb.residual_clicks", "<>", ksql.raw<string>("0")),
									eb("sb.residual_orders", "<>", ksql.raw<string>("0")),
									eb("sb.residual_units", "<>", ksql.raw<string>("0")),
									eb("sb.residual_spend", "<>", ksql.raw<string>("0")),
									eb("sb.residual_sales", "<>", ksql.raw<string>("0")),
								])
							)
							.groupBy((eb) => [
								"sb.merchantId",
								"sb.marketplaceId",
								eb.fn.coalesce("bca.family", ksql.lit("(unmapped)")),
							]))
					.selectFrom("certain")
					.select([
						"merchantId",
						"marketplaceId",
						"family",
						"source",
						"adImpressions",
						"adClicks",
						"adOrders",
						"adUnits",
						"adSpend",
						"adSales",
					])
					.unionAll((eb) =>
						eb.selectFrom("guessed").select([
							"merchantId",
							"marketplaceId",
							"family",
							"source",
							"adImpressions",
							"adClicks",
							"adOrders",
							"adUnits",
							"adSpend",
							"adSales",
						])
					)
					.compile(),
		);
		const salesRows = yield* runCompiled(
			sql,
			() =>
				db
					.selectFrom("amzreport_ALL_ORDERS as ao")
					.leftJoin("brand_config_amazon_asin as bca", "bca.asin", "ao.asin")
					.select((eb) => [
						eb.ref("ao.merchant_id").as("merchantId"),
						eb.ref("ao.marketplace_id").as("marketplaceId"),
						eb.fn.coalesce("bca.family", ksql.lit("(unmapped)")).as("family"),
						// An aggregate over an arithmetic expression has no builder form:
						// `eb.fn.sum(eb("item_price", "-", eb.fn.coalesce(...)))` fails with
						// "Property 'isSelectQueryBuilder' is missing in type 'ExpressionWrapper<…>'".
						eb.cast<string | null>(
							eb.fn.sum<string | null>(
								ksql<number>`${eb.ref("ao.item_price")} - COALESCE(${
									eb.ref("ao.item_promotion_discount")
								}, 0)`,
							),
							"numeric",
						).as("totalSales"),
					])
					.where((eb) => eb("ao.merchant_id", "=", eb.fn.any(ksql.val(merchantIds))))
					.where("ao.localdate", ">=", isoDateParam(since))
					.where("ao.order_status", "!=", "Cancelled")
					.groupBy((eb) => [
						"ao.merchant_id",
						"ao.marketplace_id",
						eb.fn.coalesce("bca.family", ksql.lit("(unmapped)")),
					])
					.compile(),
		);

		const definitiveContributions: FamilyAgg[] = [];
		const guessed: FamilyAgg[] = [];
		for (const row of adRows) {
			const site = siteOf(row.marketplaceId);
			if (!site) {
				continue;
			}
			const contribution: FamilyAgg = {
				merchantId: row.merchantId,
				site,
				family: row.family,
				...(row.source ? { source: row.source } : {}),
				adImpressions: Number(row.adImpressions ?? 0),
				adClicks: Number(row.adClicks ?? 0),
				adOrders: Number(row.adOrders ?? 0),
				adUnits: Number(row.adUnits ?? 0),
				adSpend: Number(row.adSpend ?? 0),
				adSales: Number(row.adSales ?? 0),
				totalSales: 0,
			};
			if (row.source) {
				guessed.push(contribution);
			} else {
				definitiveContributions.push(contribution);
			}
		}
		for (const row of salesRows) {
			const site = siteOf(row.marketplaceId);
			if (!site) {
				continue;
			}
			definitiveContributions.push({
				merchantId: row.merchantId,
				site,
				family: row.family,
				adImpressions: 0,
				adClicks: 0,
				adOrders: 0,
				adUnits: 0,
				adSpend: 0,
				adSales: 0,
				totalSales: Number(row.totalSales ?? 0),
			});
		}

		const definitiveByKey = groupByWith(
			definitiveContributions,
			familyKey,
			(rows): FamilyAgg | undefined => {
				const first = rows[0];
				if (!first) {
					return undefined;
				}
				const adMetrics = summarizeAdMetrics(rows);
				return {
					merchantId: first.merchantId,
					site: first.site,
					family: first.family,
					...adMetrics,
					totalSales: rows.reduce((sum, row) => sum + row.totalSales, 0),
				};
			},
		);

		return [...Object.values(definitiveByKey), ...guessed];
	});
}
