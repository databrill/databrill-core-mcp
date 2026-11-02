/**
 * loadRank — MCP tool contract (BSR / organic-rank trend; the rank slice of the
 * dbl-ask-organic-rank toolkit).
 */

import { stringArgument } from "../../toolParams.ts";
import { Effect, Result } from "effect";
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
		when: {
			type: "string",
			description: "ISO 8601 interval or duration. Both ends are inclusive. A bare duration ends at the latest " +
				"date with advertising data, not the latest rank date; pass an explicit interval to choose the end. " +
				"Required.",
		},
		products: {
			type: "string",
			description: "Optional filter: family names, parent ASINs (auto-expanded), or child ASINs. Without it, " +
				"every ranked ASIN in each requested marketplace is returned, one row per ASIN, category and day, " +
				"with no row cap. A family name that maps to no ASIN is dropped without an error; the call fails " +
				"only when no token resolves to any ASIN.",
		},
	},
	required: ["stores", "when"],
	additionalProperties: false,
} as const;

function parseParams(args: Record<string, unknown>): Result.Result<LoadRankParams, Error> {
	return Result.gen(function* () {
		return {
			stores: yield* stringArgument(args["stores"], "stores"),
			when: yield* stringArgument(args["when"], "when"),
			products: typeof args["products"] === "string" ? args["products"] : undefined,
		};
	});
}

export const loadRankTool = {
	name: "loadRank",
	description:
		"Fetch Best Sellers Rank (BSR) per ASIN, category and day over a window: one row per ASIN, category and " +
		"marketplace-local calendar day, holding the latest rank snapshot of that day, with observedAt giving that " +
		"snapshot's time in UTC. An ASIN is ranked in several categories at once: categoryKind is subcategory for a " +
		"numeric browse-node category, whose categoryName is resolved from amazon_browse_node where that table " +
		"exists, and department for a top-level category, whose categoryName is its key. Compare ranks only within " +
		"one category. Picks the per-marketplace rank table for each requested country; countries without a rank " +
		"table are reported in meta.missingRankTables. Reads the client DB (amazon_sales_rank__{cc}, " +
		"amazon_browse_node).",
	inputSchema,
	run: (args: Record<string, unknown>, sql: Sql) =>
		Effect.flatMap(Effect.fromResult(parseParams(args)), (params) => loadRank(params, sql)),
};
