/**
 * Strip C0 control characters and DEL from a string before it is written to
 * a terminal, while preserving tab and newline.
 *
 * Diagnostic messages, file paths and `--fix-dry-run` diffs embed untrusted
 * strings (rule content, field values, file content, plugin-controlled file
 * and directory names). Without sanitization an attacker-supplied artifact
 * could smuggle ANSI/control sequences into the user's terminal.
 *
 * Strips U+0000-U+0008, U+000B-U+001F and U+007F (DEL) - every C0 control
 * char and DEL except U+0009 (tab) and U+000A (newline), which are kept.
 * The stripped set includes U+000D (CR) and U+001B (ESC) by design.
 */
export function sanitizeForTerminal(s: string): string {
	// eslint-disable-next-line no-control-regex
	return s.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "");
}
