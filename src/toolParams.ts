import { Result } from "effect";

/** Keep omitted strings empty for loader validation; reject objects without coercion. */
export function stringArgument(value: unknown, name: string): Result.Result<string, Error> {
	if (value === undefined || value === null) {
		return Result.succeed("");
	}
	if (typeof value !== "string") {
		return Result.fail(new Error(`${name} must be a string`));
	}
	return Result.succeed(value);
}
