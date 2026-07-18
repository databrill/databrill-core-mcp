/**
 * loadEconomics — MCP tool contract (profitability / dbl-ask-profitability).
 */

import type { Sql } from "postgres";
import { loadEconomics, type LoadEconomicsParams } from "./load.ts";
import type { EconomicsInput } from "./economics.ts";

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
			description: "Optional filter: family names, parent ASINs (auto-expanded), or child ASINs.",
		},
		economics: {
			type: "object",
			description:
				"Optional cost inputs (not in the client DB). { perAsin: { [asin]: { price, cogs, fbaPickPack, referralPct, storage } }, familyDefault? }. " +
				"Without it, the ad rollup is returned but margins are zero (source=missing).",
		},
	},
	required: ["stores", "when"],
	additionalProperties: false,
} as const;

function parseParams(args: Record<string, unknown>): LoadEconomicsParams {
	return {
		stores: String(args.stores ?? ""),
		when: String(args.when ?? ""),
		products: typeof args.products === "string" ? args.products : undefined,
		economics: (args.economics && typeof args.economics === "object") ? args.economics as EconomicsInput : null,
	};
}

export const loadEconomicsTool = {
	name: "loadEconomics",
	description:
		"Per-advertised-ASIN profitability over a window: ad spend, ad cost per sale, halo revenue, and (when cost inputs " +
		"are supplied) net margin and net profit per ad sale with/without halo. Fetches the ad rollup from the client DB; " +
		"COGS/price/fees must be passed in `economics` since they are not stored in the DB.",
	inputSchema,
	run: (args: Record<string, unknown>, sql: Sql) => loadEconomics(parseParams(args), sql),
};
