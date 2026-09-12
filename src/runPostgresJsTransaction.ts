import { Cause, Effect, Exit, Runtime } from "effect";
import type { Sql, TransactionSql } from "postgres";
import { exitValue, toError, tryOrOperationError } from "./effectErrors.ts";

/**
 * Run an Effect inside a PostgreSQL transaction using the postgres.js client library.
 *
 * `sql.begin` accepts a callback that returns a Promise. postgres.js commits when
 * that Promise resolves and rolls back when it rejects. This function runs `body`
 * inside that callback and makes its Promise reject when the Effect fails, so a
 * failed Effect cannot accidentally commit the transaction.
 *
 * The body runs with the caller's Effect runtime. Its typed failures, defects and
 * interruption Causes are preserved. On caller interruption, the body is signalled
 * and this function waits for both the callback and `sql.begin` to settle before
 * returning. If the driver fails first, the callback is interrupted and its cleanup
 * is awaited. That internal interruption is removed from the returned Cause; the
 * driver Error and callback cleanup failures/defects are retained. Foreign work
 * protected from interruption remains awaited. This function does not send a
 * PostgreSQL cancellation request or close the pool.
 *
 * @param sql - postgres.js pool used to open the transaction.
 * @param mode - Transaction options passed to `sql.begin`, such as "read only" or "".
 * @param body - Effect-producing callback given the reserved transaction connection.
 * @returns A lazy Effect with the body's result, its failure Cause, or a postgres.js Error.
 */
export function runPostgresJsTransaction<A, E, R>(
	sql: Sql,
	mode: string,
	body: (tx: TransactionSql) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | Error, R> {
	return Effect.uninterruptibleMask((restore) =>
		Effect.gen(function* () {
			const runtime = yield* Effect.runtime<R>();
			let driverFailure: Error | undefined;
			let callbackFailure: Cause.Cause<E | Error> | undefined;
			let cancelled = false;
			const operation = Effect.async<A, E | Error>((resume, signal) => {
				let callbackRejection: unknown;
				let callbackFinished: Promise<void> | undefined;
				let callbackSettled = false;
				const stopCallback = new AbortController();
				const callbackSignal = AbortSignal.any([signal, stopCallback.signal]);
				// Promise.resolve captures a synchronous sql.begin invocation throw as well.
				const finished = Promise.resolve().then(() =>
					sql.begin(mode, (tx) => {
						const callback = Runtime.runPromiseExit(runtime)(
							Effect.interruptible(
								Effect.flatMap(tryOrOperationError(() => body(tx)), (effect) => effect),
							),
							{ signal: callbackSignal },
						).then((result) => {
							callbackSettled = true;
							if (Exit.isFailure(result)) {
								callbackFailure = result.cause;
								callbackRejection = result.cause._tag === "Fail"
									? result.cause.error
									: Runtime.makeFiberFailure(result.cause);
								throw callbackRejection;
							}
							// Box the value so postgres.js's UnwrapPromiseArray type preserves A.
							return { value: exitValue(result) };
						});
						// Observe rejection immediately, independently of the driver's Promise race.
						callbackFinished = callback.then(() => {}, () => {});
						return callback;
					})
				).then(
					(boxed) => {
						resume(Effect.succeed(boxed.value));
					},
					async (error: unknown) => {
						const driverFailedFirst = callbackFinished !== undefined && !callbackSettled;
						if (driverFailedFirst) {
							stopCallback.abort();
						}
						// Undefined means begin failed before invoking the callback: nothing to await.
						await callbackFinished;
						if (error !== callbackRejection) {
							driverFailure = toError(error);
						}
						resume(
							driverFailedFirst
								? Effect.failCause(Cause.sequential(
									Cause.fail(toError(error)),
									callbackFailure === undefined
										? Cause.empty
										: Cause.filter(callbackFailure, (part) => part._tag !== "Interrupt"),
								))
								: callbackFailure === undefined
								? Effect.fail(toError(error))
								: Effect.failCause(
									error === callbackRejection
										? callbackFailure
										: Cause.sequential(callbackFailure, Cause.fail(toError(error))),
								),
						);
					},
				);
				// postgres.js has no AbortSignal API here. Interrupt the owned callback through
				// the signal, then wait for postgres.js to finish ROLLBACK before release.
				return Effect.zipRight(
					Effect.sync(() => {
						cancelled = true;
					}),
					Effect.promise(() => finished),
				);
			});
			const result = yield* Effect.exit(restore(operation));
			if (Exit.isFailure(result) && cancelled) {
				let cause = result.cause;
				if (callbackFailure !== undefined) {
					cause = Cause.sequential(cause, Cause.filter(callbackFailure, (part) => part._tag !== "Interrupt"));
				}
				if (driverFailure !== undefined) {
					cause = Cause.sequential(cause, Cause.fail(driverFailure));
				}
				return yield* Effect.failCause(cause);
			}
			return yield* result;
		})
	);
}
