/**
 * Per-family ad spend and sales over a window.
 *
 * Rows with a real advertised ASIN carry Amazon's definitive attribution. The
 * signed reconciliation residual of each Sponsored Brands ad is emitted
 * separately and attributed to the first creative ASIN's family with an
 * explicit source.
 */

import type postgres from "postgres";
import { marketplaceIdToMarketplaceInfo } from "../../amazonConstants.ts";
import { groupByWith } from "../../groupByWith.ts";
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

interface AdRow {
	readonly merchantId: string;
	readonly marketplaceId: string;
	readonly family: string;
	readonly source: string | null;
	readonly adImpressions: string | number | null;
	readonly adClicks: string | number | null;
	readonly adOrders: string | number | null;
	readonly adUnits: string | number | null;
	readonly adSpend: string | number | null;
	readonly adSales: string | number | null;
}

interface SalesRow {
	readonly merchantId: string;
	readonly marketplaceId: string;
	readonly family: string;
	readonly totalSales: string | number | null;
}

function siteOf(marketplaceId: string): string | null {
	return marketplaceIdToMarketplaceInfo[marketplaceId]?.countryCode ?? null;
}

function familyKey(row: FamilyAgg): string {
	return `${row.merchantId}|||${row.site}|||${row.family}`;
}

export async function loadFamilyWindow(
	sql: postgres.Sql,
	merchantIds: string[],
	since: string,
): Promise<FamilyAgg[]> {
	const adRows = await sql<AdRow[]>`
		WITH sb_asin_lookup AS (
			SELECT "merchantId", "marketplaceId", "adId",
				COALESCE(
					"creative"->'products'->0->>'productId',
					"creative"->'asins'->>0
				) AS first_asin
			FROM "amzadapi_exports_v1__ad"
			WHERE "merchantId" = ANY(${merchantIds})
				AND "adProduct" IN ('SPONSORED_BRANDS', 'SPONSORED_BRANDS_VIDEO')
		),
		certain AS (
			SELECT ad."merchantId", ad."marketplaceId",
				COALESCE(bca."family", '(unmapped)') AS family,
				NULL::text AS source,
				SUM(ad."impressions")::numeric AS "adImpressions",
				SUM(ad."clicks")::numeric AS "adClicks",
				SUM(ad."purchases")::numeric AS "adOrders",
				SUM(ad."unitsSold")::numeric AS "adUnits",
				SUM(ad."totalCost")::numeric AS "adSpend",
				SUM(ad."sales")::numeric AS "adSales"
			FROM "amzadapi_reports_v1__search_asin_placement__byDay" ad
			LEFT JOIN "brand_config_amazon_asin" bca
				ON bca."asin" = ad."advertisedProductId"
			WHERE ad."merchantId" = ANY(${merchantIds})
				AND ad."date" >= ${since}
				AND ad."advertisedProductId" <> ''
			GROUP BY ad."merchantId", ad."marketplaceId",
				COALESCE(bca."family", '(unmapped)')
		),
		sb_by_ad AS (
			SELECT ad."merchantId", ad."marketplaceId", ad."adId",
				(
					COALESCE(SUM(ad."impressions") FILTER (WHERE ad."advertisedProductId" = ''), 0)
						- COALESCE(SUM(ad."impressions") FILTER (WHERE ad."advertisedProductId" <> ''), 0)
				)::numeric AS residual_impressions,
				(
					COALESCE(SUM(ad."clicks") FILTER (WHERE ad."advertisedProductId" = ''), 0)
						- COALESCE(SUM(ad."clicks") FILTER (WHERE ad."advertisedProductId" <> ''), 0)
				)::numeric AS residual_clicks,
				(
					COALESCE(SUM(ad."purchases") FILTER (WHERE ad."advertisedProductId" = ''), 0)
						- COALESCE(SUM(ad."purchases") FILTER (WHERE ad."advertisedProductId" <> ''), 0)
				)::numeric AS residual_orders,
				(
					COALESCE(SUM(ad."unitsSold") FILTER (WHERE ad."advertisedProductId" = ''), 0)
						- COALESCE(SUM(ad."unitsSold") FILTER (WHERE ad."advertisedProductId" <> ''), 0)
				)::numeric AS residual_units,
				(
					COALESCE(SUM(ad."totalCost") FILTER (WHERE ad."advertisedProductId" = ''), 0)
						- COALESCE(SUM(ad."totalCost") FILTER (WHERE ad."advertisedProductId" <> ''), 0)
				)::numeric AS residual_spend,
				(
					COALESCE(SUM(ad."sales") FILTER (WHERE ad."advertisedProductId" = ''), 0)
						- COALESCE(SUM(ad."sales") FILTER (WHERE ad."advertisedProductId" <> ''), 0)
				)::numeric AS residual_sales
			FROM "amzadapi_reports_v1__search_asin_placement__byDay" ad
			WHERE ad."merchantId" = ANY(${merchantIds})
				AND ad."date" >= ${since}
				AND ad."adProduct" = 'Sponsored Brands'
			GROUP BY ad."merchantId", ad."marketplaceId", ad."adId"
		),
		guessed AS (
			SELECT sb."merchantId", sb."marketplaceId",
				COALESCE(bca."family", '(unmapped)') AS family,
				${SB_RESIDUAL_FIRST_ASIN}::text AS source,
				SUM(sb.residual_impressions)::numeric AS "adImpressions",
				SUM(sb.residual_clicks)::numeric AS "adClicks",
				SUM(sb.residual_orders)::numeric AS "adOrders",
				SUM(sb.residual_units)::numeric AS "adUnits",
				SUM(sb.residual_spend)::numeric AS "adSpend",
				SUM(sb.residual_sales)::numeric AS "adSales"
			FROM sb_by_ad sb
			LEFT JOIN sb_asin_lookup lookup
				ON lookup."merchantId" = sb."merchantId"
				AND lookup."marketplaceId" = sb."marketplaceId"
				AND lookup."adId" = sb."adId"
			LEFT JOIN "brand_config_amazon_asin" bca
				ON bca."asin" = lookup.first_asin
			WHERE sb.residual_impressions <> 0
				OR sb.residual_clicks <> 0
				OR sb.residual_orders <> 0
				OR sb.residual_units <> 0
				OR sb.residual_spend <> 0
				OR sb.residual_sales <> 0
			GROUP BY sb."merchantId", sb."marketplaceId",
				COALESCE(bca."family", '(unmapped)')
		)
		SELECT "merchantId", "marketplaceId", family, source,
			"adImpressions", "adClicks", "adOrders", "adUnits", "adSpend", "adSales"
		FROM certain
		UNION ALL
		SELECT "merchantId", "marketplaceId", family, source,
			"adImpressions", "adClicks", "adOrders", "adUnits", "adSpend", "adSales"
		FROM guessed
	`;
	const salesRows = await sql<SalesRow[]>`
		SELECT ao."merchant_id" AS "merchantId", ao."marketplace_id" AS "marketplaceId",
			COALESCE(bca."family", '(unmapped)') AS "family",
			SUM(ao."item_price" - COALESCE(ao."item_promotion_discount", 0))::numeric AS "totalSales"
		FROM "amzreport_ALL_ORDERS" ao
		LEFT JOIN "brand_config_amazon_asin" bca ON bca."asin" = ao."asin"
		WHERE ao."merchant_id" = ANY(${merchantIds}) AND ao."localdate" >= ${since}
			AND ao."order_status" != 'Cancelled'
		GROUP BY ao."merchant_id", ao."marketplace_id", COALESCE(bca."family", '(unmapped)')
	`;

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
}
