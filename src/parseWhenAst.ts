import { Either } from "effect";
import { type Duration, parse as parseDuration } from "tinyduration";

// Re-export tinyduration's Duration type with our naming
export type WhenAst_Duration = Duration & { readonly _tag: "Duration" };

export interface WhenAst_Date {
	readonly _tag: "Date";
	readonly date: string;
}

export interface WhenAst_Time {
	readonly _tag: "Time";
	readonly time: string;
}

export interface WhenAst_DateTime {
	readonly _tag: "DateTime";
	readonly datetime: string;
}

export type WhenAst_Primitive = WhenAst_Duration | WhenAst_Date | WhenAst_Time | WhenAst_DateTime;

export interface WhenAst_Interval_DateDate {
	readonly _tag: "Interval_DateDate";
	readonly left: WhenAst_Date;
	readonly right: WhenAst_Date;
}

export interface WhenAst_Interval_DateTimeDatetime {
	readonly _tag: "Interval_DateTimeDatetime";
	readonly left: WhenAst_DateTime;
	readonly right: WhenAst_DateTime;
}

export interface WhenAst_Interval_DateDuration {
	readonly _tag: "Interval_DateDuration";
	readonly left: WhenAst_Date | WhenAst_DateTime;
	readonly right: WhenAst_Duration;
}

export interface WhenAst_Interval_DurationDate {
	readonly _tag: "Interval_DurationDate";
	readonly left: WhenAst_Duration;
	readonly right: WhenAst_Date | WhenAst_DateTime;
}

export type WhenAst_Interval =
	| WhenAst_Interval_DateDate
	| WhenAst_Interval_DateTimeDatetime
	| WhenAst_Interval_DateDuration
	| WhenAst_Interval_DurationDate;

export type WhenAst = WhenAst_Primitive | WhenAst_Interval;

export interface WhenAstError {
	readonly message: string;
	readonly input: string;
}

export function parseWhenAst(when: string): Either.Either<WhenAst, WhenAstError> {
	const trimmed = when.trim();

	if (trimmed === "") {
		return Either.left({ message: "Empty input", input: when });
	}

	// Check for interval (contains '/' or '--')
	const separator = findIntervalSeparator(trimmed);
	if (separator !== null) {
		const leftStr = trimmed.slice(0, separator.index);
		const rightStr = trimmed.slice(separator.index + separator.length);

		if (leftStr === "" || rightStr === "") {
			return Either.left({ message: "Invalid interval: missing left or right side", input: when });
		}

		const leftResult = parsePrimitive(leftStr);
		if (Either.isLeft(leftResult)) {
			return Either.left({ message: `Invalid interval left side: ${leftResult.left.message}`, input: when });
		}

		const rightResult = parsePrimitive(rightStr);
		if (Either.isLeft(rightResult)) {
			return Either.left({ message: `Invalid interval right side: ${rightResult.left.message}`, input: when });
		}

		return makeInterval(leftResult.right, rightResult.right, when);
	}

	// Not an interval, parse as primitive
	const result = parsePrimitive(trimmed);
	if (Either.isLeft(result)) {
		return Either.left({ ...result.left, input: when });
	}
	return result;
}

function findIntervalSeparator(input: string): { readonly index: number; readonly length: number } | null {
	// Check for '--' first (longer separator takes precedence)
	const dashDashIndex = input.indexOf("--");
	if (dashDashIndex !== -1) {
		return { index: dashDashIndex, length: 2 };
	}

	// Check for '/'
	const slashIndex = input.indexOf("/");
	if (slashIndex !== -1) {
		return { index: slashIndex, length: 1 };
	}

	return null;
}

function parsePrimitive(input: string): Either.Either<WhenAst_Primitive, WhenAstError> {
	// Try datetime first (most specific)
	const datetime = tryParseDateTime(input);
	if (datetime) {
		return Either.right(datetime);
	}

	// Try date
	const date = tryParseDate(input);
	if (date) {
		return Either.right(date);
	}

	// Try time
	const time = tryParseTime(input);
	if (time) {
		return Either.right(time);
	}

	// Try duration
	const duration = tryParseDuration(input);
	if (duration) {
		return Either.right(duration);
	}

	return Either.left({ message: `Unable to parse as date, time, datetime, or duration`, input });
}

function makeInterval(
	left: WhenAst_Primitive,
	right: WhenAst_Primitive,
	originalInput: string,
): Either.Either<WhenAst_Interval, WhenAstError> {
	// Date/Date
	if (left._tag === "Date" && right._tag === "Date") {
		return Either.right({ _tag: "Interval_DateDate", left, right });
	}

	// DateTime/DateTime
	if (left._tag === "DateTime" && right._tag === "DateTime") {
		return Either.right({ _tag: "Interval_DateTimeDatetime", left, right });
	}

	// Date or DateTime / Duration
	if ((left._tag === "Date" || left._tag === "DateTime") && right._tag === "Duration") {
		return Either.right({ _tag: "Interval_DateDuration", left, right });
	}

	// Duration / Date or DateTime
	if (left._tag === "Duration" && (right._tag === "Date" || right._tag === "DateTime")) {
		return Either.right({ _tag: "Interval_DurationDate", left, right });
	}

	return Either.left({
		message: `Invalid interval combination: ${left._tag}/${right._tag}`,
		input: originalInput,
	});
}

// Regex patterns for structural validation (not semantic validation)
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;
const DATETIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/;

/**
 * One optional duration component, e.g. `31D`. UNSIGNED: a sign is legal only at
 * the FRONT of the whole duration, where it sets the `negative` flag.
 */
function durationComponentPattern(symbol: string): string {
	return `(?:\\d*[.,]?\\d+${symbol})?`;
}

/**
 * The ISO 8601 duration shape, ANCHORED AT BOTH ENDS — the anchoring is the
 * whole point, so do not relax it into a prefix test.
 *
 * `tinyduration` builds an equivalent pattern but applies it with `exec` and
 * neither `^` nor `$`, and every component in it is optional, so a PREFIX match
 * wins and the tail is discarded in silence: `"P31Days"` parsed as 31 days,
 * `"P1D2D"` as one day, and `"P1Min"` as one MONTH — a ~30x error on a string a
 * human writes meaning one minute, indistinguishable in the AST from a
 * deliberate `"P1M"`. Its per-component pattern also carries its own `-?`,
 * entirely separate from the leading `(?<negative>-)?`, so `"P-1D"` yielded
 * `{days: -1}` with the `negative` flag ABSENT: a duration that points
 * backwards while reporting itself as non-negative to every caller, all of which
 * read the flag. Both are silent wrong answers rather than errors, which is why
 * the shape is validated here and `tinyduration` is used only to pull the numbers
 * out of a string already known to be well-formed.
 *
 * `T` requires at least one time component (the lookahead), which is what rejects
 * a dangling `"P1DT"`. `"P"` and `"-P"` still MATCH this pattern, because every
 * date component is optional; they are caught by `tinyduration`, which rejects a
 * duration with no components at all.
 */
const DURATION_PATTERN = new RegExp(
	"^-?P" +
		durationComponentPattern("Y") +
		durationComponentPattern("M") +
		durationComponentPattern("W") +
		durationComponentPattern("D") +
		"(?:T(?=[.,\\d])" +
		durationComponentPattern("H") +
		durationComponentPattern("M") +
		durationComponentPattern("S") +
		")?$",
);

function tryParseDateTime(input: string): WhenAst_DateTime | null {
	if (DATETIME_PATTERN.test(input)) {
		return { _tag: "DateTime", datetime: input };
	}
	return null;
}

function tryParseDate(input: string): WhenAst_Date | null {
	if (DATE_PATTERN.test(input)) {
		return { _tag: "Date", date: input };
	}
	return null;
}

function tryParseTime(input: string): WhenAst_Time | null {
	if (TIME_PATTERN.test(input)) {
		return { _tag: "Time", time: input };
	}
	return null;
}

function tryParseDuration(input: string): WhenAst_Duration | null {
	if (!DURATION_PATTERN.test(input)) {
		return null;
	}
	try {
		const duration = parseDuration(input);
		return { ...duration, _tag: "Duration" as const };
	} catch {
		return null;
	}
}
