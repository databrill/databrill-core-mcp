import type { Sql } from "postgres";
import { loadAmazonFbaStockouts } from "./load.ts";
import type { LoadAmazonFbaStockoutsParams } from "./types.ts";

const inputSchema = {
	type: "object",
	properties: {
		stores: {
			type: "string",
			description: "Country, region (na, eu, fe), marketplaceId, '*', or {merchantId}-{scope}; comma-separated.",
		},
		when: {
			type: "string",
			description: "ISO interval, or a duration ending on the latest local today of the selected stores' " +
				"marketplaces. Default: the last 90 days. A range ending after that day, or reversed, is refused.",
		},
		products: {
			type: "string",
			description:
				"Optional comma-separated child or parent ASINs, family names, FNSKUs or seller SKUs. Parent ASINs expand within each marketplace. " +
				"Every token is also matched exactly as an FNSKU and as a seller SKU.",
		},
		limit: {
			type: "integer",
			minimum: 1,
			maximum: 1000,
			default: 250,
			description: "Maximum episodes to return.",
		},
	},
	required: ["stores"],
	additionalProperties: false,
} as const;

function parseParams(args: Record<string, unknown>): LoadAmazonFbaStockoutsParams {
	return {
		stores: typeof args["stores"] === "string" ? args["stores"] : "",
		when: typeof args["when"] === "string" ? args["when"] : undefined,
		products: typeof args["products"] === "string" ? args["products"] : undefined,
		limit: typeof args["limit"] === "number" ? args["limit"] : undefined,
	};
}

export const loadAmazonFbaStockoutsTool = {
	name: "loadAmazonFbaStockouts",
	description: "When did a product run out of FBA stock, and did it come back: stockout episodes per merchant, " +
		"marketplace and FNSKU, with asin and every seller SKU of the FNSKU. From FBA inventory history, a " +
		"CLOSED_OUT episode starts on the first day fulfillable stock closes at zero after a day closing in stock " +
		"and ends on the first later day closing in stock; a day that reached zero but closed in stock is a one-day " +
		"INTRADAY_DIP. Future supply never decides a stockout; futureSupplyBuyableMax reports it. For the days " +
		"before a store's history starts, episodes come from the FBA inventory ledger's SELLABLE balance across " +
		"the store's center countries; they are a lower bound, since reserved units count in that balance. An " +
		"episode already out where its source starts being read has a null stockoutDate and outOnOrBefore set. An " +
		"FNSKU whose inventory did not change in the range has no episode. meta.stores says per store where " +
		"history starts and which days came from the ledger. Episodes still out come first, then by start, newest " +
		"first; at most limit are returned, and meta.isTruncated is true when more matched. When a required table " +
		"is missing the result is empty and meta.missingTables names it.",
	inputSchema,
	run: (args: Record<string, unknown>, sql: Sql) => loadAmazonFbaStockouts(parseParams(args), sql),
};
