import { EFFORT_LEVELS } from "../contracts.js";

/**
 * Validate a frontmatter `effort` value against the Claude Code contract.
 *
 * Claude Code's frontmatter Zod schema types `effort` as a permissive scalar
 * (`anyOf[string,number,boolean,null]`), but the field's own `.describe()`
 * string in the bundle reads:
 *   "Thinking effort for the model: `low`, `medium`, `high`, `max`, or an integer."
 *
 * So a valid `effort` is either one of the named levels (EFFORT_LEVELS) or an
 * integer. Anything else — a non-integer number, a boolean, an unknown string,
 * null — is reported. Returns a human-readable reason when invalid, or null
 * when the value is acceptable.
 */
export function invalidEffortReason(value: unknown): string | null {
	const valid = [...EFFORT_LEVELS].join(", ");
	if (typeof value === "string") {
		if (EFFORT_LEVELS.has(value)) return null;
		return `"effort" string must be one of: ${valid} (got "${value}")`;
	}
	if (typeof value === "number") {
		if (Number.isInteger(value)) return null;
		return `"effort" number must be an integer (got ${value})`;
	}
	return `"effort" must be one of: ${valid}, or an integer (got ${JSON.stringify(value)})`;
}
