import { Effect, Either, Exit, Runtime } from "effect";

/** Retain foreign Error identity and preserve non-Error rejection values as causes. */
export function toError(cause: unknown): Error {
	return cause instanceof Error ? cause : new Error("External operation failed", { cause });
}

/** Execute only at a foreign callback boundary that requires rejection on failure. */
export function exitValue<A, E>(exit: Exit.Exit<A, E>): A {
	if (Exit.isSuccess(exit)) {
		return exit.value;
	}
	if (exit.cause._tag === "Fail") {
		throw exit.cause.error;
	}
	throw Runtime.makeFiberFailure(exit.cause);
}

/** Only absent relations/columns justify the optional metric fallback. */
export function isMissingRelationOrColumn(error: Error): boolean {
	if ("code" in error && (error.code === "42P01" || error.code === "42703")) {
		return true;
	}
	return error.cause instanceof Error && error.cause !== error && isMissingRelationOrColumn(error.cause);
}

/** Run synchronous work, preserving foreign errors and their causes. */
export function tryOrOperationError<A>(fn: () => A): Either.Either<A, Error> {
	return Either.try({ try: fn, catch: toError });
}

/** Run Promise work, preserving foreign errors and their causes. */
export function tryPromiseOrOperationError<A>(fn: () => Promise<A>): Effect.Effect<A, Error> {
	return Effect.tryPromise({ try: fn, catch: toError });
}
