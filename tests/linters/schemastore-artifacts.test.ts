import { describe, it, expect } from "vitest";
import { marketplaceJsonLinter } from "../../src/linters/marketplace-json.js";
import { keybindingsJsonLinter } from "../../src/linters/keybindings-json.js";
import type { LinterConfig } from "../../src/types.js";

const CONFIG: LinterConfig = { rules: {} };

describe("schemastore-backed linters (gitea#6)", () => {
	describe("marketplace-json", () => {
		it("reports invalid JSON", () => {
			const r = marketplaceJsonLinter.lint("marketplace.json", "{ broken", CONFIG);
			expect(r.some((d) => d.rule === "marketplace-json/valid-json")).toBe(true);
		});

		it("flags structural schema violations", () => {
			// A marketplace.json with no `plugins` array fails the schemastore shape.
			const r = marketplaceJsonLinter.lint(
				"marketplace.json",
				JSON.stringify({ name: "test", owner: "test" }),
				CONFIG,
			);
			expect(r.some((d) => d.rule === "marketplace-json/schema-valid")).toBe(true);
		});

		it("accepts a minimally-valid marketplace.json", () => {
			const r = marketplaceJsonLinter.lint(
				"marketplace.json",
				JSON.stringify({
					name: "demo",
					owner: { name: "demo" },
					plugins: [],
				}),
				CONFIG,
			);
			expect(r.filter((d) => d.severity === "error")).toHaveLength(0);
		});
	});

	describe("keybindings-json", () => {
		it("reports invalid JSON", () => {
			const r = keybindingsJsonLinter.lint("keybindings.json", "not json", CONFIG);
			expect(r.some((d) => d.rule === "keybindings-json/valid-json")).toBe(true);
		});

		it("accepts a minimally-valid keybindings.json", () => {
			// schemastore requires the top-level `bindings` array.
			const r = keybindingsJsonLinter.lint(
				"keybindings.json",
				JSON.stringify({ bindings: [] }),
				CONFIG,
			);
			expect(r.filter((d) => d.severity === "error")).toHaveLength(0);
		});

		it("flags a missing `bindings` field", () => {
			const r = keybindingsJsonLinter.lint(
				"keybindings.json",
				JSON.stringify({}),
				CONFIG,
			);
			expect(r.some((d) => d.rule === "keybindings-json/schema-valid")).toBe(true);
		});
	});
});
