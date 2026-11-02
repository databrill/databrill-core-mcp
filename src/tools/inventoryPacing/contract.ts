/**
 * inventoryPacing — MCP tool contract (the dbl-ask-inventory-pacing decision).
 */

import { stringArgument } from "../../toolParams.ts";
import { Effect, Result } from "effect";
import type { Sql } from "postgres";
import { loadInventoryPacing } from "./load.ts";
import type { LoadInventoryPacingParams } from "./types.ts";

const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

const inputSchema = {
	type: "object",
	properties: {
		stores: {
			type: "string",
			description:
				"Comma-separated stores: country code, region, marketplaceId, '*', or '{merchantId}-{scope}'. Required.",
		},
		velocityDays: {
			type: "integer",
			description: "Days of sales, ending yesterday, that units/day is averaged over. 1 to 28; values outside " +
				"are clamped, and meta.config reports the value used. Default 7.",
		},
		spendWindowDays: { type: "integer", description: "Window for ad spend/day. Default 7." },
		criticalDays: { type: "integer", description: "Runway ≤ this → pause. Default 7." },
		lowDays: { type: "integer", description: "Runway ≤ this → throttle. Default 21." },
		overstockDays: { type: "integer", description: "Runway ≥ this → ramp/sell-down. Default 90." },
		minSpendPerDay: { type: "number", description: "Ignore ad spend below this when deciding to cut. Default 1." },
		minVelocity: { type: "number", description: "Ignore families selling less than this/day. Default 0.2." },
	},
	required: ["stores"],
	additionalProperties: false,
} as const;

function parseParams(args: Record<string, unknown>): Result.Result<LoadInventoryPacingParams, Error> {
	return Result.gen(function* () {
		return {
			stores: yield* stringArgument(args["stores"], "stores"),
			velocityDays: num(args["velocityDays"]),
			spendWindowDays: num(args["spendWindowDays"]),
			criticalDays: num(args["criticalDays"]),
			lowDays: num(args["lowDays"]),
			overstockDays: num(args["overstockDays"]),
			minSpendPerDay: num(args["minSpendPerDay"]),
			minVelocity: num(args["minVelocity"]),
		};
	});
}

export const inventoryPacingTool = {
	name: "inventoryPacing",
	description:
		"Recommend how advertising should respond to inventory: per family, join the runway (days of stock at current " +
		"velocity) with current ad spend and return a pacing action — pause / throttle / hold / ramp — with a rationale. " +
		"Critical runway with active spend → pause; inbound restock softens to throttle; overstock → ramp to sell down. " +
		"Flags a worst-variant caveat when a child ASIN is critical under a healthy family. Reads the client DB. " +
		"FBA stock comes from Amazon's per-marketplace inventory summaries. Where one stock pool serves several " +
		"marketplaces, as Amazon's Pan-European FBA does, Amazon reports the whole pool on each of them, so each such " +
		"marketplace's row sets the shared stock against that marketplace's sales alone and its runway reads longer " +
		"than the stock supports. Never add stock across those marketplaces.",
	inputSchema,
	run: (args: Record<string, unknown>, sql: Sql) =>
		Effect.flatMap(Effect.fromResult(parseParams(args)), (params) => loadInventoryPacing(params, sql)),
};
