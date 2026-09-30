/**
 * Sales-drop diagnosis — MCP tool contract. The single source of truth for this
 * tool's name + input schema + invocation. The stdio server, the CLI, and (P2)
 * the hosted frontend all consume this.
 */

import type { Sql } from "postgres";
import { load } from "./load.ts";
import type { LoadConfig } from "./types.ts";

const inputSchema = {
	type: "object",
	properties: {
		stores: {
			type: "string",
			description: "Comma-separated store filter: a merchantId, a country code (US, DE), a marketplace id, or " +
				"merchantId-country. Regions and '*' are not accepted here; a token that matches no store yields an " +
				"empty result, not an error. Omit to use the countries of the client's active stores. Ignored when " +
				"allStores is true.",
		},
		allStores: {
			type: "boolean",
			description: "Include every store with data, not just configured countries. Default false.",
		},
		recentDays: {
			type: "integer",
			description: "Length of the recent window in days. Default 7.",
		},
		baselineDays: {
			type: "integer",
			description: "Length of the baseline window (the days before the recent window). Default 28.",
		},
		dropThreshold: {
			type: "number",
			description: "Fraction fall in sales/day that flags a store as a drop (0.10 = 10%). Default 0.10.",
		},
		inventoryRunwayMax: {
			type: "integer",
			description: "Flag ASINs with inventory runway at or below this many days as a possible cause. Default 14.",
		},
		skipInventory: {
			type: "boolean",
			description: "Skip the inventory join (faster). Default false.",
		},
	},
	additionalProperties: false,
} as const;

/** Map loosely-typed tool arguments to a `LoadConfig` (defaults match the agency report). */
export function parseConfig(args: Record<string, unknown>): LoadConfig {
	const storesRaw = typeof args["stores"] === "string" ? args["stores"] : undefined;
	return {
		stores: storesRaw ? storesRaw.split(",").map((s) => s.trim()).filter(Boolean) : null,
		allStores: args["allStores"] === true,
		recentDays: typeof args["recentDays"] === "number" ? args["recentDays"] : 7,
		baselineDays: typeof args["baselineDays"] === "number" ? args["baselineDays"] : 28,
		dropThreshold: typeof args["dropThreshold"] === "number" ? args["dropThreshold"] : 0.10,
		inventoryRunwayMax: typeof args["inventoryRunwayMax"] === "number" ? args["inventoryRunwayMax"] : 14,
		skipInventory: args["skipInventory"] === true,
	};
}

export const salesDropDiagnosisTool = {
	name: "salesDropDiagnosis",
	description:
		"Diagnose a change in a store's sales. For each in-scope store, compares a recent window with the baseline " +
		"window before it, decomposes the change in daily sales into traffic (sessions/day), conversion " +
		"(units/session) and price (average selling price), ranks the causes by their share of the change, and " +
		"attaches ad-channel, ad-efficiency and low-inventory signals. Returns every in-scope store, not only those " +
		"that fell; isDrop marks a fall of at least dropThreshold. Both windows end at each store's latest Sales & " +
		"Traffic day, or at its latest data day when Sales & Traffic lags by more than recentDays. When sessions " +
		"cover less than half of either window's days, only the price factor is separated and notes says so. A " +
		"store with too little history, no sales in both windows, or no data in the last 14 days is left out. " +
		"Reads the client database.",
	inputSchema,
	run: (args: Record<string, unknown>, sql: Sql) => load(parseConfig(args), sql),
};
