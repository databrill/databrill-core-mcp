import { Either } from "effect";

/** Keep omitted strings empty for loader validation; reject objects without coercion. */
export function stringArgument(value: unknown, name: string): Either.Either<string, Error> {
	if (value === undefined || value === null) {
		return Either.right("");
	}
	if (typeof value !== "string") {
		return Either.left(new Error(`${name} must be a string`));
	}
	return Either.right(value);
}
