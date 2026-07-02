/**
 * loadTraffic — MCP tool contract (the dbl-metrics-traffic / Sales & Traffic loader).
 */

import type { Sql } from "postgres";
import { loadTraffic } from "./load.ts";
import { type LoadTrafficParams, VALID_TRAFFIC_GROUP_BY, VALID_TRAFFIC_TIME_UNITS } from "./types.ts";

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
			description: "ISO 8601 interval or duration: '2026-04-13/2026-04-19', 'P7D', 'P4W/2026-04-19'. Required.",
		},
		groupBy: {
			type: "string",
			enum: [...VALID_TRAFFIC_GROUP_BY],
			description: "asin (default) or family.",
		},
		timeUnit: {
			type: "string",
			enum: [...VALID_TRAFFIC_TIME_UNITS],
			description: "Bucket size: WEEK (default), DAY, or MONTH.",
		},
		products: {
			type: "string",
			description: "Optional filter: comma-separated family names, parent ASINs (auto-expanded), or child ASINs.",
		},
	},
	required: ["stores", "when"],
	additionalProperties: false,
} as const;

function parseParams(args: Record<string, unknown>): LoadTrafficParams {
	return {
		stores: String(args.stores ?? ""),
		when: String(args.when ?? ""),
		groupBy: typeof args.groupBy === "string" ? args.groupBy : undefined,
		timeUnit: typeof args.timeUnit === "string" ? args.timeUnit : undefined,
		products: typeof args.products === "string" ? args.products : undefined,
	};
}

export const loadTrafficTool = {
	name: "loadTraffic",
	description:
		"Fetch Amazon Sales & Traffic metrics per ASIN (or family) over a time window: sessions, units ordered, " +
		"ordered-product sales, and conversion rate (units/sessions). Bucketed by DAY/WEEK/MONTH across the requested " +
		"marketplaces. Reads the client DB (amzreport_SALES_AND_TRAFFIC__skuByDay).",
	inputSchema,
	run: (args: Record<string, unknown>, sql: Sql) => loadTraffic(parseParams(args), sql),
};
