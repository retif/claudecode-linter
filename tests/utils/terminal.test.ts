import { describe, it, expect } from "vitest";
import { sanitizeForTerminal } from "../../src/utils/terminal.js";

const ESC = String.fromCharCode(0x1b);
const CR = String.fromCharCode(0x0d);
const NUL = String.fromCharCode(0x00);
const DEL = String.fromCharCode(0x7f);
const BEL = String.fromCharCode(0x07);

describe("sanitizeForTerminal", () => {
	it("leaves plain text untouched", () => {
		expect(sanitizeForTerminal("hello world")).toBe("hello world");
	});

	it("strips ESC (the basis of ANSI escape sequences)", () => {
		const ansi = `${ESC}[31mred${ESC}[0m`;
		expect(sanitizeForTerminal(ansi)).toBe("[31mred[0m");
	});

	it("strips carriage return", () => {
		expect(sanitizeForTerminal(`a${CR}b`)).toBe("ab");
	});

	it("strips NUL, BEL and DEL", () => {
		expect(sanitizeForTerminal(`a${NUL}b${BEL}c${DEL}d`)).toBe("abcd");
	});

	it("keeps tab and newline", () => {
		expect(sanitizeForTerminal("a\tb\nc")).toBe("a\tb\nc");
	});

	it("strips every C0 control char except tab and newline", () => {
		let input = "";
		for (let cp = 0x00; cp <= 0x1f; cp++) {
			input += String.fromCharCode(cp);
		}
		input += DEL;
		// Only \t (0x09) and \n (0x0A) survive.
		expect(sanitizeForTerminal(input)).toBe("\t\n");
	});

	it("returns an empty string when given only control chars", () => {
		expect(sanitizeForTerminal(`${ESC}${CR}${NUL}${DEL}`)).toBe("");
	});
});
