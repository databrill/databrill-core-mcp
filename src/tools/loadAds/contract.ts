/**
 * loadAds — MCP tool contract. The primary metric-fetch tool (the `dbl-metrics-ads`
 * loader): Amazon advertising performance aggregated by configurable dimensions,
 * with halo (cross-product) metrics and optional derived ratios. Migrated from
 * core-agent-docs `src/amazonMetrics`.
 */

import { stringArgument } from "../../toolParams.ts";
import { Effect, Result } from "effect";
import type { Sql } from "postgres";
import { loadAds, type LoadAdsParams, VALID_GROUP_BY, VALID_TIME_UNITS } from "./loadAds.ts";

const inputSchema = {
	type: "object",
	properties: {
		stores: {
			type: "string",
			description:
				"Comma-separated stores: country code (US, DE), region (na, eu, fe), marketplaceId, '*', or '{merchantId}-{scope}'. Required.",
		},
		when: {
			type: "string",
			description: "ISO 8601 interval or duration: '2026-04-13/2026-04-19', 'P7D', 'P4W/2026-04-19'. Both ends " +
				"are inclusive. A bare duration ends at the latest date with advertising data in the database. " +
				"Required.",
		},
		groupBy: {
			type: "string",
			description: `Comma-separated dimensions: ${
				VALID_GROUP_BY.join(", ")
			}. Required. Use 'store' for no specific breakdown. 'target' also returns targetMatchType and requires a products or campaignName filter.`,
		},
		timeUnit: {
			type: "string",
			enum: [...VALID_TIME_UNITS],
			description: "Optional time bucket: DAY, WEEK (Monday to Sunday), MONTH, QUARTER or YEAR. Each row then " +
				"carries its bucket's calendar dateFirst and dateLast, so the first and last buckets can name dates " +
				"outside the window when it does not align to the bucket. Omit for one row per group over the whole " +
				"window.",
		},
		products: {
			type: "string",
			description:
				"Optional comma-separated filter: family names, parent ASINs (auto-expanded), or child ASINs. " +
				"A family name that maps to no ASIN is dropped without an error; the call fails only when no token " +
				"resolves to any ASIN.",
		},
		filter: {
			type: "string",
			description: "Optional exact campaign-name filter, written 'campaignName:=:<name>'. campaignName is the " +
				"only field and '=' the only operator; the name must match exactly, including letter case, and may " +
				"itself contain ':'. Any other field or operator is rejected.",
		},
		derived: {
			type: "boolean",
			description: "Include derived ratios (ctr, cr, cpc, acos, roas). Default false.",
		},
		nested: {
			type: "boolean",
			description: "Nest halo metrics into adStats/adStatsHaloIn/adStatsHaloOut. Default false.",
		},
	},
	required: ["stores", "when", "groupBy"],
	additionalProperties: false,
} as const;

function parseParams(args: Record<string, unknown>): Result.Result<LoadAdsParams, Error> {
	return Result.gen(function* () {
		return {
			stores: yield* stringArgument(args["stores"], "stores"),
			when: yield* stringArgument(args["when"], "when"),
			groupBy: yield* stringArgument(args["groupBy"], "groupBy"),
			timeUnit: typeof args["timeUnit"] === "string" ? args["timeUnit"] : undefined,
			products: typeof args["products"] === "string" ? args["products"] : undefined,
			filter: typeof args["filter"] === "string" ? args["filter"] : undefined,
			derived: typeof args["derived"] === "boolean" ? args["derived"] : undefined,
			nested: typeof args["nested"] === "boolean" ? args["nested"] : undefined,
			format: "json",
		};
	});
}

export const loadAdsTool = {
	name: "loadAds",
	description:
		"Fetch Amazon advertising performance metrics aggregated by configurable dimensions (asin, family, parentAsin, " +
		"campaign, adType, placement, target, adgroup, country, store, merchant, marketplaceId), optionally over a time " +
		"unit. Returns impressions, clicks, addToCart, purchases, units, spend, revenue, and halo (cross-product) metrics; " +
		"optionally derived ratios (CTR, CR, CPC, ACOS, ROAS). Reads the client DB; Amazon's ad reports lag 1-2 days. " +
		"Rows built only from halo-in metrics (this product's sales that Amazon credits to ads for other products) " +
		"carry haloInOnly: true and zero advertised and halo-out metrics. Such rows appear, with or without a products " +
		"filter, for a product with no ads of its own in the row's window or time bucket. groupBy placement or target " +
		"reports halo-in under null placement or null target/targetMatchType respectively, because Amazon's halo-in " +
		"report has neither dimension. groupBy target returns targetMatchType alongside target and requires a products " +
		"filter or an exact campaignName filter ('campaignName:=:<name>'). haloInOnly is a top-level " +
		"field in nested output too. meta.dateDataLatest is the latest date with ad data for the selected stores, " +
		"whatever the window, or null when they have none.",
	inputSchema,
	run: (args: Record<string, unknown>, sql: Sql) =>
		Effect.flatMap(Effect.fromResult(parseParams(args)), (params) => loadAds(params, sql)),
};
