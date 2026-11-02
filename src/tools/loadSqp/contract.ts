/**
 * loadSqp — MCP tool contract (the dbl-metrics-sqp loader).
 */

import { stringArgument } from "../../toolParams.ts";
import { Effect, Result } from "effect";
import type { Sql } from "postgres";
import { loadSqp } from "./load.ts";
import { DEFAULT_KEYWORD_LIMIT, type LoadSqpParams, MAX_KEYWORD_LIMIT, VALID_SQP_TIME_UNITS } from "./types.ts";

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
			description:
				"ISO 8601 interval or duration. A period is included when its first day falls in the window, " +
				"both ends inclusive, and the whole period is returned. A bare duration ends at the latest date with " +
				"advertising data, not the latest SQP date; pass an explicit interval to choose the end. Required.",
		},
		products: {
			type: "string",
			description:
				"Optional filter: comma-separated family names, parent ASINs (auto-expanded), or child ASINs. " +
				"A family name that maps to no ASIN is dropped without an error; the call fails only when no token " +
				"resolves to any ASIN.",
		},
		timeUnit: {
			type: "string",
			enum: [...VALID_SQP_TIME_UNITS],
			description: "SQP period: WEEK (default) or MONTH.",
		},
		keywordLimit: {
			type: "integer",
			minimum: 1,
			maximum: MAX_KEYWORD_LIMIT,
			default: DEFAULT_KEYWORD_LIMIT,
			description: `Top-N search queries by market impressions: a whole number from 1 to ${MAX_KEYWORD_LIMIT}, ` +
				`default ${DEFAULT_KEYWORD_LIMIT}. A value outside that range is rejected rather than clamped.`,
		},
	},
	required: ["stores", "when"],
	additionalProperties: false,
} as const;

function parseParams(args: Record<string, unknown>): Result.Result<LoadSqpParams, Error> {
	return Result.gen(function* () {
		return {
			stores: yield* stringArgument(args["stores"], "stores"),
			when: yield* stringArgument(args["when"], "when"),
			products: typeof args["products"] === "string" ? args["products"] : undefined,
			timeUnit: typeof args["timeUnit"] === "string" ? args["timeUnit"] : undefined,
			keywordLimit: typeof args["keywordLimit"] === "number" ? args["keywordLimit"] : undefined,
		};
	});
}

export const loadSqpTool = {
	name: "loadSqp",
	description:
		"Fetch Search Query Performance: our-vs-market impressions, clicks, and purchases per period (with share %), " +
		"plus the top search queries by market impressions. Each keyword row carries all six counts — market and ours " +
		"for impressions, clicks and purchases — so a market CTR or CVR is an exact division of two of them; never " +
		"invert a rounded share, and never use the report's totalClickRate/totalPurchaseRate columns, which are " +
		"per-search rather than per-impression. Rows whose search term Amazon's report leaves empty are excluded " +
		"from both the period totals and the keyword list: the empty term stands for a different, unnamed search in " +
		"each period and marketplace, so it cannot be added up like a named term. Bucketed by the report's WEEK or " +
		"MONTH timeUnit, across the requested marketplaces. Reads the client DB (amzreport_SEARCH_QUERY_PERFORMANCE).",
	inputSchema,
	run: (args: Record<string, unknown>, sql: Sql) =>
		Effect.flatMap(Effect.fromResult(parseParams(args)), (params) => loadSqp(params, sql)),
};
