/**
 * Connection helper. The tool logic never opens a connection itself — a `sql`
 * is injected by the frontend (CLI / stdio / hosted), so the same loaders run
 * against a client's own DB (POSTGRES_URL) or a resolved target DB (hosted).
 *
 * `createSqlProvider` adds multi-workspace routing: given a `Config`, it lazily
 * pools one connection per workspace (keyed by wsid, `search_path` set to the
 * workspace schema) and resolves each tool call to the right one. With no config
 * it degrades to a single `POSTGRES_URL` pool — the original behaviour.
 */

import postgres, { type Sql } from "postgres";
import { type Config, resolveWorkspace } from "./config.ts";

/** Open a postgres client to the target DB. Cross-runtime: reads `process.env`. */
export function getSql(connectionString?: string, schema?: string): Sql {
	const url = connectionString ?? process.env.POSTGRES_URL;
	if (!url) {
		throw new Error("POSTGRES_URL environment variable is required");
	}
	return postgres(url, {
		max: 5,
		idle_timeout: 30,
		connect_timeout: 10,
		transform: { undefined: null },
		...(schema ? { connection: { search_path: schema } } : {}),
	});
}

export interface SqlProvider {
	/** Resolve a tool call's arguments to the connection for its workspace. */
	getSqlForArgs(args: Record<string, unknown>): Sql;
	/** Close every pool this provider opened. */
	endAll(): Promise<void>;
}

/**
 * Build a connection provider. With a `Config`, connections are pooled per
 * workspace and resolved via `resolveWorkspace`; without one, a single
 * `POSTGRES_URL` pool serves every call (wsid is ignored).
 */
export function createSqlProvider(config: Config | null): SqlProvider {
	const pools = new Map<string, Sql>();
	const endAll = async (): Promise<void> => {
		await Promise.all([...pools.values()].map((s) => s.end()));
		pools.clear();
	};

	if (!config) {
		return {
			getSqlForArgs() {
				let sql = pools.get("__default__");
				if (!sql) {
					sql = getSql();
					pools.set("__default__", sql);
				}
				return sql;
			},
			endAll,
		};
	}

	return {
		getSqlForArgs(args) {
			const ws = resolveWorkspace(config, args);
			let sql = pools.get(ws.wsid);
			if (!sql) {
				sql = getSql(ws.database.postgresUrl, ws.database.schema);
				pools.set(ws.wsid, sql);
			}
			return sql;
		},
		endAll,
	};
}
