/**
 * Connection helper. The tool logic never opens a connection itself — a `sql`
 * is injected by the frontend (CLI / stdio / hosted), so the same loaders run
 * against a registry-selected workspace DB (local) or a resolved target DB (hosted).
 *
 * `createSqlProvider` lazily pools one connection per explicitly named
 * workspace, and hands it back with no questions asked. Each registry entry must
 * carry that workspace's own credential.
 *
 * It does NOT check that the credential is the role it claims to be. A check that
 * read `current_user` and `search_path` stood here until 2026-09-04 and was
 * removed: the registry is the consumer's own hand-edited `databrill.config.json`,
 * so the only thing it could catch was that consumer misconfiguring their own
 * workspace — which shows up immediately as recognisably wrong data in a
 * workspace whose data they know. Do not reintroduce it.
 */

import { makePostgresJsTypes } from "@jsr/databrill__core-pg-kysely/canonical";
import postgres, { type Sql } from "postgres";
import { type Config, resolveWorkspace } from "./config.ts";

/** Open a postgres client to the target DB. */
export function getSql(connectionString: string): Sql {
	return postgres(connectionString, {
		max: 5,
		idle_timeout: 30,
		connect_timeout: 10,
		types: makePostgresJsTypes(),
		transform: { undefined: null },
	});
}

export interface SqlProvider {
	/**
	 * Resolve a tool call's arguments to the connection for its workspace.
	 *
	 * Returns a promise although nothing here awaits: opening a pool is the kind of
	 * thing that acquires a resource, `registerTools` accepts either shape, and the
	 * CLI's `resolveSql` is built around a promise. Narrowing it to `Sql` would
	 * change a mirrored package's exported signature to save one microtask.
	 */
	getSqlForArgs(args: Record<string, unknown>): Promise<Sql>;
	/** Close every pool this provider opened. */
	endAll(): Promise<void>;
}

/**
 * Build a connection provider. Connections are pooled per workspace and every
 * call is resolved from its explicit `wsid`.
 */
export function createSqlProvider(config: Config): SqlProvider {
	const pools = new Map<string, Sql>();
	// `allSettled`, so one pool that fails to close cannot skip `clear()` and strand
	// the rest of the map pointing at handles nothing will ever end.
	const endAll = async (): Promise<void> => {
		await Promise.allSettled([...pools.values()].map((sql) => sql.end()));
		pools.clear();
	};

	return {
		getSqlForArgs(args) {
			const ws = resolveWorkspace(config, args);
			let sql = pools.get(ws.wsid);
			if (sql === undefined) {
				sql = getSql(ws.database.postgresUrl);
				pools.set(ws.wsid, sql);
			}
			return Promise.resolve(sql);
		},
		endAll,
	};
}
