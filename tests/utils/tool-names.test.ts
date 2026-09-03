import { describe, expect, it } from "vitest";
import {
	editDistance,
	nearestKnownTool,
	toolNameProblem,
} from "../../src/utils/tool-names.js";

describe("editDistance", () => {
	it("counts an adjacent transposition as one edit", () => {
		expect(editDistance("Bahs", "Bash")).toBe(1);
	});

	it("counts a substitution as one edit", () => {
		expect(editDistance("Raed", "Read")).toBe(1);
	});

	it("is zero for identical strings", () => {
		expect(editDistance("Bash", "Bash")).toBe(0);
	});
});

describe("nearestKnownTool", () => {
	it("finds the tool a typo was aiming at", () => {
		expect(nearestKnownTool("Bashh")).toBe("Bash");
		expect(nearestKnownTool("TodoWrit")).toBe("TodoWrite");
	});

	it("returns null for a name that resembles nothing known", () => {
		expect(nearestKnownTool("ListAgents")).toBeNull();
		expect(nearestKnownTool("EndConversation")).toBeNull();
	});

	it("does not read a Tool-suffixed alias as a misspelling", () => {
		// ListMcpResources is an alias Claude Code maps to ListMcpResourcesTool;
		// four edits apart, so the relative cap must keep this silent.
		expect(nearestKnownTool("ListMcpResourcesTool")).toBeNull();
		expect(nearestKnownTool("ReadMcpResourceTool")).toBeNull();
		expect(nearestKnownTool("ReadMcpResourceDirTool")).toBeNull();
	});
});

describe("toolNameProblem", () => {
	it("accepts a tool in the extracted registry", () => {
		expect(toolNameProblem("Bash")).toBeNull();
		expect(toolNameProblem("Read")).toBeNull();
	});

	it("accepts built-ins the extracted registry does not list", () => {
		// All four are callable on Claude Code 2.1.259 and absent from
		// contracts.tools — the registry lags the running harness by design.
		for (const t of [
			"ListAgents",
			"DesignSync",
			"SendFeedback",
			"EndConversation",
		]) {
			expect(toolNameProblem(t), t).toBeNull();
		}
	});

	it("accepts a runtime-resolved mcp__ tool", () => {
		expect(toolNameProblem("mcp__gitea__list_my_repos")).toBeNull();
	});

	it("accepts the Tool(specifier) form", () => {
		expect(toolNameProblem("Bash(npm run test:*)")).toBeNull();
		expect(toolNameProblem("Read(~/**)")).toBeNull();
	});

	it("reports a near-miss of a known tool, with the suggestion", () => {
		expect(toolNameProblem("Bahs")).toContain('did you mean "Bash"');
		expect(toolNameProblem("Raed")).toContain('did you mean "Read"');
		expect(toolNameProblem("WebFecth")).toContain('did you mean "WebFetch"');
	});

	it("reports a near-miss inside a specifier form", () => {
		expect(toolNameProblem("Bahs(npm run test:*)")).toContain(
			'did you mean "Bash"',
		);
	});

	it("reports a wrong-case tool name", () => {
		expect(toolNameProblem("bash")).toContain('did you mean "Bash"');
	});

	it("reports a name that cannot be a tool identifier", () => {
		expect(toolNameProblem("some tool")).toContain("Invalid tool name");
		expect(toolNameProblem("read-file")).toContain("Invalid tool name");
	});

	it("reports an empty entry", () => {
		expect(toolNameProblem("  ")).toContain("Empty tool name");
	});
});
