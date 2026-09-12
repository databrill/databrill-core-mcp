import { Either } from "effect";
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
import { Cause, Effect, Exit, type Scope } from "effect";
import { tryOrOperationError, tryPromiseOrOperationError } from "./effectErrors.ts";
import postgres, { type Sql } from "postgres";
import { type Config, resolveWorkspace } from "./config.ts";

/** Construct a postgres client synchronously; connection I/O begins with its first query. */
export function getSql(connectionString: string): Either.Either<Sql, Error> {
	return tryOrOperationError(() =>
		postgres(connectionString, {
			max: 5,
			idle_timeout: 30,
			connect_timeout: 10,
			types: makePostgresJsTypes(),
			transform: { undefined: null },
		})
	);
}

export interface SqlProvider {
	/** Resolve explicit workspace arguments and lazily share its acquired pool. */
	getSqlForArgs(args: Record<string, unknown>): Effect.Effect<Sql, Error>;
	/** Close every pool; retain failed handles so a later call can retry. */
	endAll(): Effect.Effect<void, Error>;
}

/**
 * Build a connection provider. Connections are pooled per workspace and every
 * call is resolved from its explicit `wsid`.
 */
export function createSqlProvider(config: Config): SqlProvider {
	const pools = new Map<string, Sql>();
	const ownership = Effect.unsafeMakeSemaphore(1);
	let closing: Effect.Effect<void, Error> | undefined;

	function endAll(): Effect.Effect<void, Error> {
		return Effect.uninterruptible(Effect.gen(function* () {
			if (closing !== undefined) {
				return yield* closing;
			}
			const attempt = yield* Effect.cached(
				ownership.withPermits(1)(Effect.gen(function* () {
					let failures: Cause.Cause<Error> = Cause.empty;
					for (const [wsid, sql] of pools) {
						const result = yield* Effect.exit(tryPromiseOrOperationError(() => sql.end()));
						if (Exit.isSuccess(result)) {
							pools.delete(wsid);
						} else {
							failures = Cause.parallel(failures, result.cause);
						}
					}
					if (!Cause.isEmpty(failures)) {
						return yield* Effect.failCause(failures);
					}
				})),
			);
			closing = attempt;
			return yield* attempt.pipe(Effect.ensuring(Effect.sync(() => {
				closing = undefined;
			})));
		}));
	}

	return {
		getSqlForArgs(args) {
			return Effect.gen(function* () {
				if (closing !== undefined) {
					yield* closing;
				}
				return yield* ownership.withPermits(1)(Effect.uninterruptible(Effect.gen(function* () {
					const ws = yield* resolveWorkspace(config, args);
					let sql = pools.get(ws.wsid);
					if (sql === undefined) {
						// Hold ownership and defer interruption until the new handle is cached.
						sql = yield* getSql(ws.database.postgresUrl);
						pools.set(ws.wsid, sql);
					}
					return sql;
				})));
			});
		},
		endAll,
	};
}

/** Acquire a workspace provider and close its pools when the enclosing scope ends. */
export function acquireSqlProvider(config: Config): Effect.Effect<SqlProvider, never, Scope.Scope> {
	return Effect.acquireRelease(
		Effect.sync(() => createSqlProvider(config)),
		(provider) => Effect.orDie(provider.endAll()),
	);
}
