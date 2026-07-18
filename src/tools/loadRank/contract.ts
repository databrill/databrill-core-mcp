/**
 * loadRank — MCP tool contract (BSR / organic-rank trend; the rank slice of the
 * dbl-ask-organic-rank toolkit).
 */

import type { Sql } from "postgres";
import { loadRank } from "./load.ts";
import type { LoadRankParams } from "./types.ts";

const inputSchema = {
	type: "object",
	properties: {
		stores: {
			type: "string",
			description:
				"Comma-separated stores: country code, region, marketplaceId, '*', or '{merchantId}-{scope}'. Required.",
		},
		when: { type: "string", description: "ISO 8601 interval or duration. Required." },
		products: {
			type: "string",
			description: "Optional (recommended) filter: family names, parent ASINs (auto-expanded), or child ASINs.",
		},
	},
	required: ["stores", "when"],
	additionalProperties: false,
} as const;

function parseParams(args: Record<string, unknown>): LoadRankParams {
	return {
		stores: String(args.stores ?? ""),
		when: String(args.when ?? ""),
		products: typeof args.products === "string" ? args.products : undefined,
	};
}

export const loadRankTool = {
	name: "loadRank",
	description:
		"Fetch Best Sellers Rank (BSR) trend per ASIN over a window, with subcategory names resolved. Picks the " +
		"per-marketplace rank table for each requested country; countries without a rank table are reported in " +
		"meta.missingRankTables. Reads the client DB (amazon_sales_rank__{cc}, amazon_browse_node).",
	inputSchema,
	run: (args: Record<string, unknown>, sql: Sql) => loadRank(parseParams(args), sql),
};
