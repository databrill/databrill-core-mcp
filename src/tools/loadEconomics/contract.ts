/**
 * loadEconomics — MCP tool contract (profitability / dbl-ask-profitability).
 */

import { stringArgument } from "../../toolParams.ts";
import { Effect, Either, Schema } from "effect";
import type { Sql } from "postgres";
import { loadEconomics, type LoadEconomicsParams } from "./load.ts";
import { EconomicsInputSchema } from "./economics.ts";

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
				"date with advertising data in the database. Required.",
		},
		products: {
			type: "string",
			description: "Optional filter: family names, parent ASINs (auto-expanded), or child ASINs. A family name " +
				"that maps to no ASIN is dropped without an error; the call fails only when no token resolves to " +
				"any ASIN.",
		},
		economics: {
			type: "object",
			description:
				"Optional cost inputs, which the client DB does not hold: { perAsin: { [asin]: { price, cogs, " +
				"fbaPickPack, referralPct, storage } }, familyDefault? }. Money values are per unit, in the currency " +
				"of the ad revenue. referralPct is a fraction (0.15 means 15%) and defaults to 0.15. familyDefault, " +
				"when given, applies to every advertised ASIN without a perAsin entry (source=default). An ASIN with " +
				"neither gets zero costs and source=missing, and its net-per-ad-sale figures are then only the " +
				"negative of its ad cost per sale, not a profit estimate.",
		},
	},
	required: ["stores", "when"],
	additionalProperties: false,
} as const;

function parseParams(args: Record<string, unknown>): Either.Either<LoadEconomicsParams, Error> {
	return Either.gen(function* () {
		return {
			stores: yield* stringArgument(args["stores"], "stores"),
			when: yield* stringArgument(args["when"], "when"),
			products: typeof args["products"] === "string" ? args["products"] : undefined,
			economics: args["economics"] === undefined || args["economics"] === null
				? null
				: yield* Schema.decodeUnknownEither(EconomicsInputSchema)(args["economics"]).pipe(
					Either.mapLeft((cause) => new Error(`Invalid economics: ${cause.message}`)),
				),
		};
	});
}

export const loadEconomicsTool = {
	name: "loadEconomics",
	description:
		"Per-advertised-ASIN ad profitability over a window. Returns two arrays. `rollup` is the ad data from the " +
		"client DB grouped by ASIN (as loadAds with groupBy asin): totalSpend, totalDirectOrders (ad-attributed " +
		"units), totalDirectRev, totalHaloRev, avgCpc (currency), avgCr and avgAcos (percent) and avgRoas " +
		"(revenue / spend). " +
		"`economics` applies the cost inputs passed in `economics`: net before ads, net margin, ad cost per sale, " +
		"and net profit per ad sale without and with halo, where halo sales are valued at the ASIN's own net " +
		"margin. The client DB holds no price, COGS or fee data, so without `economics` every figure in the " +
		"`economics` array is zero with source=missing, ad cost per sale included; compute that one as " +
		"totalSpend / totalDirectOrders from `rollup`.",
	inputSchema,
	run: (args: Record<string, unknown>, sql: Sql) =>
		Effect.flatMap(parseParams(args), (params) => loadEconomics(params, sql)),
};
