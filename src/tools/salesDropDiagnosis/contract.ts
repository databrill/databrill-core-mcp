/**
 * Sales-drop diagnosis — MCP tool contract. The single source of truth for this
 * tool's name + input schema + invocation. The stdio server, the CLI, and (P2)
 * the hosted frontend all consume this; the plugin's skill is generated from it.
 */

import { Effect } from "effect";
import type { Sql } from "postgres";
import { load } from "./load.ts";
import type { LoadConfig } from "./types.ts";

const inputSchema = {
	type: "object",
	properties: {
		stores: {
			type: "string",
			description:
				"Comma-separated store filter: a merchantId, a country code (US, DE), or merchantId-site. Omit to use the client's configured countries.",
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
	const storesRaw = typeof args.stores === "string" ? args.stores : undefined;
	return {
		stores: storesRaw ? storesRaw.split(",").map((s) => s.trim()).filter(Boolean) : null,
		allStores: args.allStores === true,
		recentDays: typeof args.recentDays === "number" ? args.recentDays : 7,
		baselineDays: typeof args.baselineDays === "number" ? args.baselineDays : 28,
		dropThreshold: typeof args.dropThreshold === "number" ? args.dropThreshold : 0.10,
		inventoryRunwayMax: typeof args.inventoryRunwayMax === "number" ? args.inventoryRunwayMax : 14,
		skipInventory: args.skipInventory === true,
	};
}

export const salesDropDiagnosisTool = {
	name: "salesDropDiagnosis",
	description:
		"Diagnose why a store's sales dropped. Decomposes the change in daily sales into traffic (sessions/day), " +
		"conversion (units/session) and price (average selling price), ranks the causes by their share of the change, " +
		"and attaches ad-channel and ad-efficiency signals. Reads the client database. Returns one diagnosis object per in-scope store.",
	inputSchema,
	run: (args: Record<string, unknown>, sql: Sql) => Effect.runPromise(load(parseConfig(args), sql)),
};
