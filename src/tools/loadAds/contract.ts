/**
 * loadAds — MCP tool contract. The primary metric-fetch tool (the `dbl-metrics-ads`
 * loader): Amazon advertising performance aggregated by configurable dimensions,
 * with halo (cross-product) metrics and optional derived ratios. Migrated from
 * core-agent-docs `src/amazonMetrics`; the loader (`loadAds.ts`) is unchanged.
 */

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
			description:
				"ISO 8601 interval or duration: '2026-04-13/2026-04-19', 'P7D', 'P4W/2026-04-19'. Required.",
		},
		groupBy: {
			type: "string",
			description:
				`Comma-separated dimensions: ${VALID_GROUP_BY.join(", ")}. Required. Use 'store' for no specific breakdown.`,
		},
		timeUnit: {
			type: "string",
			enum: [...VALID_TIME_UNITS],
			description: "Optional temporal aggregation.",
		},
		products: {
			type: "string",
			description: "Optional comma-separated filter: family names, parent ASINs (auto-expanded), or child ASINs.",
		},
		filter: {
			type: "string",
			description: "Optional filter expression, e.g. 'campaignName:=:value'.",
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

function parseParams(args: Record<string, unknown>): LoadAdsParams {
	return {
		stores: String(args.stores ?? ""),
		when: String(args.when ?? ""),
		groupBy: String(args.groupBy ?? ""),
		timeUnit: typeof args.timeUnit === "string" ? args.timeUnit : undefined,
		products: typeof args.products === "string" ? args.products : undefined,
		filter: typeof args.filter === "string" ? args.filter : undefined,
		derived: typeof args.derived === "boolean" ? args.derived : undefined,
		nested: typeof args.nested === "boolean" ? args.nested : undefined,
		format: "json",
	};
}

export const loadAdsTool = {
	name: "loadAds",
	description:
		"Fetch Amazon advertising performance metrics aggregated by configurable dimensions (asin, family, parentAsin, " +
		"campaign, adType, placement, target, adgroup, country, store, merchant, marketplaceId), optionally over a time " +
		"unit. Returns impressions, clicks, addToCart, purchases, units, spend, revenue, and halo (cross-product) metrics; " +
		"optionally derived ratios (CTR, CR, CPC, ACOS, ROAS). Reads the client DB; data lags 1-2 days.",
	inputSchema,
	run: (args: Record<string, unknown>, sql: Sql) => loadAds(parseParams(args), sql),
};
