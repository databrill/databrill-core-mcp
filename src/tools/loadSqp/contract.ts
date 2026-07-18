/**
 * loadSqp — MCP tool contract (the dbl-metrics-sqp loader).
 */

import type { Sql } from "postgres";
import { loadSqp } from "./load.ts";
import { type LoadSqpParams, VALID_SQP_TIME_UNITS } from "./types.ts";

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
			description: "Optional filter: comma-separated family names, parent ASINs (auto-expanded), or child ASINs.",
		},
		timeUnit: {
			type: "string",
			enum: [...VALID_SQP_TIME_UNITS],
			description: "SQP period: WEEK (default) or MONTH.",
		},
		keywordLimit: { type: "integer", description: "Top-N search queries by market impressions. Default 25." },
	},
	required: ["stores", "when"],
	additionalProperties: false,
} as const;

function parseParams(args: Record<string, unknown>): LoadSqpParams {
	return {
		stores: String(args.stores ?? ""),
		when: String(args.when ?? ""),
		products: typeof args.products === "string" ? args.products : undefined,
		timeUnit: typeof args.timeUnit === "string" ? args.timeUnit : undefined,
		keywordLimit: typeof args.keywordLimit === "number" ? args.keywordLimit : undefined,
	};
}

export const loadSqpTool = {
	name: "loadSqp",
	description:
		"Fetch Search Query Performance: our-vs-market impressions, clicks, and purchases per period (with share %), " +
		"plus the top search queries by market impressions. Bucketed by the report's WEEK or MONTH timeUnit, across the " +
		"requested marketplaces. Reads the client DB (amzreport_SEARCH_QUERY_PERFORMANCE).",
	inputSchema,
	run: (args: Record<string, unknown>, sql: Sql) => loadSqp(parseParams(args), sql),
};
