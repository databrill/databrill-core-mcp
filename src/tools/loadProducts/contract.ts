import { Effect, Schema } from "effect";
import type { Sql } from "postgres";
import { loadProducts } from "./load.ts";
import { LEVELS } from "./types.ts";

const Params = Schema.Struct({
	level: Schema.optional(Schema.Literals(LEVELS)),
	stores: Schema.optional(Schema.String),
	products: Schema.optional(Schema.String),
	search: Schema.optional(Schema.String),
	columns: Schema.optional(Schema.String),
	includeUnassigned: Schema.optional(Schema.Boolean),
	limit: Schema.optional(Schema.Number),
	offset: Schema.optional(Schema.Number),
});

export const loadProductsTool = {
	name: "loadProducts",
	access: "read" as const,
	description:
		"Discover this workspace's products before choosing subjects for analysis. List families, parent ASINs, ASINs or seller SKUs with titles. " +
		"Family and parent ASIN are independent groupings, not nested levels. Reads brand_config_amazon_asin/_family, the catalog and active listings; " +
		"brand_ontology views depend on separately populated ontology tables and are not the hierarchy source. Missing labels remain null. " +
		"meta reports the full matching count, unassigned products, missing tables and truncation. Narrow columns if the byte cap stops a page; " +
		"advance offset by rowCount. Localized ASIN titles and parents use the first available country in meta.titleCountryPriority. " +
		"Family counts cover the whole workspace; other grains cover the resolved active real stores. SKU counts count merchant/marketplace/SKU tuples.",
	inputSchema: {
		type: "object",
		properties: {
			level: { type: "string", enum: LEVELS, default: "family" },
			stores: {
				type: "string",
				description:
					"Optional comma-separated countries, regions, marketplace IDs, '*', or merchantId-scope. Default all active real stores; ignored at family grain.",
			},
			products: {
				type: "string",
				description:
					"Optional comma-separated families, parent ASINs (expanded to children), or child ASINs; same syntax as loadAds.",
			},
			search: {
				type: "string",
				description:
					"Case-insensitive literal substring in title or family (including family label at family grain).",
			},
			columns: {
				type: "string",
				description:
					"Comma-separated projection; meta.columnsAvailable lists this grain's allow-list. Unknown names are refused.",
			},
			includeUnassigned: {
				type: "boolean",
				default: true,
				description:
					"Include ASINs and SKUs without a family. At parent grain include parents with unassigned children.",
			},
			limit: { type: "integer", minimum: 1, maximum: 2000, default: 200 },
			offset: { type: "integer", minimum: 0, default: 0 },
		},
		additionalProperties: false,
	},
	run: (args: Record<string, unknown>, sql: Sql) =>
		Effect.gen(function* () {
			const params = yield* Schema.decodeUnknownEffect(Params)(args);
			return yield* loadProducts({
				...params,
				columns: params.columns?.split(",").map((column) => column.trim()),
			}, sql);
		}),
};
