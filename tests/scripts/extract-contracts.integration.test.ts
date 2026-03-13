import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	collectObjectKeySets,
	classifyByOverlap,
	parseToolsDts,
	validateContracts,
} from "../../scripts/extract-contracts.js";

describe("integration: census extraction vs current contracts", () => {
	const contractsPath = join(import.meta.dirname!, "../../contracts/claude-code-contracts.json");
	const contracts = JSON.parse(readFileSync(contractsPath, "utf8")).contracts;

	const censusCategories = [
		"pluginJsonFields",
		"agentFrontmatter",
		"commandFrontmatter",
		"mcpServerFields",
		"settingsUserFields",
	] as const;

	it("all census categories have known values in contracts", () => {
		for (const cat of censusCategories) {
			const values = contracts[cat];
			expect(values, `${cat} should exist and have values`).toBeDefined();
			expect(values.length, `${cat} should have at least 3 values`).toBeGreaterThanOrEqual(3);
		}
	});

	it("validateContracts passes for identical contracts", () => {
		const result = validateContracts(contracts, contracts);
		expect(result.failed).toBe(false);
		expect(result.errors).toEqual([]);
	});
});
