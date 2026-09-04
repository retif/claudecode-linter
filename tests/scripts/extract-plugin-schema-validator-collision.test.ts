/**
 * Master-schema location across a minified-name collision, and a master-schema
 * failure that no longer takes the other eight schemas down with it
 * (oleks/claudecode-linter#39).
 *
 * Claude Code 2.1.260 stopped extracting with "Could not locate master plugin
 * schema". The anchor had NOT moved — every anchor these locators key on was
 * still present and still unique. What changed is that the `"plugin-json"`
 * artifact-type validator was minified to `jce`, and a completely unrelated
 * `notify_idle` helper eleven megabytes earlier in the corpus is *also* named
 * `jce`. The locator resolved the validator's declaration with a single
 * corpus-wide `RegExp.exec`, so it took the first match — the wrong function —
 * found no `.safeParse(` in its body, and reported the anchor as lost.
 * 2.1.259 worked only because its validator name (`dde`) happened to be
 * globally unique.
 *
 * That is the same mechanism #33 fixed for schema symbols: minified names are
 * MODULE-scoped, so a corpus-wide first match has no claim to being right. The
 * fix here is the same shape — rank declarations by the module the call site
 * lives in, then verify the candidate by what its body actually produces — and
 * these tests pin the mechanism rather than 2.1.260's particular names.
 *
 * They run against in-memory module fragments, not a real binary, so they stay
 * stable across Claude Code releases.
 */

import { describe, expect, it } from "vitest";
import {
	buildCorpusWithRanges,
	buildPluginSchema,
	findMasterSchemaName,
	indexDefinitions,
	schemaTargets,
} from "../../scripts/extract-plugin-schema.js";
import type { DefinitionIndex } from "../../scripts/extract-plugin-schema.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Enough unrelated code to push the kebab-case error string out of strategy 1's
 * 4000-character backward window.
 *
 * Without this the fixtures are not discriminating: strategy 1 finds
 * `masterSchema` on its own from the `.safeParse(` sitting near the kebab
 * string, and every assertion below passes even with strategy 2 fully broken.
 * Claude Code has not had those two adjacent since 2.1.197.
 */
function pad(): string {
	return `var PAD="${"x".repeat(5000)}";`;
}

/**
 * The module that really validates plugin manifests: it declares the validator
 * under `name`, and dispatches to it with the "plugin-json" type string.
 */
function validatorModule(name: string): string {
	return [
		`var coreSchema=CH(()=>E.object({name:E.string().min(1),version:E.string().optional()}));`,
		`var masterSchema=CH(()=>E.object({...coreSchema().shape}));`,
		`function ${name}(e,t,n){let a=masterSchema().safeParse(e);return a.success?{ok:!0}:{ok:!1}}`,
		pad(),
		`function lintManifest(m,r){let i=${name}(m,"plugin-json",{manifestPath:r});`,
		`if(!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(m.name))push("is not kebab-case")}`,
	].join("");
}

/**
 * An unrelated module that happens to bind the same minified name. `body`
 * decides how convincing a decoy it is.
 */
function decoyModule(name: string, body: string): string {
	// Padded so the decoy's own body window cannot run past the module boundary
	// into the real validator's `.safeParse(` — in the real bundle the two are
	// eleven megabytes apart, and an unpadded fixture would let a broken locator
	// find the right answer by accident.
	return `var K=1,Y="notify_idle";function ${name}(e,n){${body}}${pad()}`;
}

function indexModules(modules: string[]): DefinitionIndex {
	const corpus = buildCorpusWithRanges(modules);
	return indexDefinitions(corpus.source, corpus.moduleRanges);
}

// ---------------------------------------------------------------------------
// Half 1 — locating the master schema despite a colliding validator name
// ---------------------------------------------------------------------------

describe("validator name colliding across modules (2.1.260)", () => {
	it("finds the master when an unrelated module declares the same name first", () => {
		// The decoy is declared FIRST, so a corpus-wide first-match search lands
		// on it. This is 2.1.260 exactly.
		const idx = indexModules([
			decoyModule("jce", `return e.ant?.getPeerPid==="function"?K:Y`),
			validatorModule("jce"),
		]);
		expect(findMasterSchemaName(idx)).toBe("masterSchema");
	});

	it("prefers the declaration in the dispatching module over a decoy that also safeParses", () => {
		// A harder decoy: it is declared first AND its body contains a
		// `<sym>().safeParse(`, so validating candidates by body shape is not
		// enough on its own — the module the "plugin-json" call site sits in is
		// what discriminates. Without module ranking this returns `decoySchema`.
		const idx = indexModules([
			decoyModule("jce", `let a=decoySchema().safeParse(e);return a`),
			validatorModule("jce"),
		]);
		expect(findMasterSchemaName(idx)).toBe("masterSchema");
	});

	it("does not read a neighbouring module's safeParse through the body window", () => {
		// A short decoy declaration butting up against an unrelated module: the
		// 4000-character body window opened at the decoy runs straight past the
		// module boundary and finds `decoySchema().safeParse(` in code the decoy
		// does not contain, naming the wrong master. Module preference cannot
		// save this one — the "plugin-json" dispatch is in a fourth module, so no
		// candidate is in the calling module and the decoy is simply first. The
		// window is clamped to the declaring module for exactly this case.
		const idx = indexModules([
			`var K=1;function jce(e,n){return K}`,
			`function unrelated(e){let a=decoySchema().safeParse(e);return a}`,
			`var coreSchema=CH(()=>E.object({name:E.string().min(1)}));` +
				`var masterSchema=CH(()=>E.object({...coreSchema().shape}));` +
				`function jce(e,t,n){let a=masterSchema().safeParse(e);return a}` +
				pad(),
			`function lintManifest(m,r){jce(m,"plugin-json",{manifestPath:r});` +
				`if(!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(m.name))push("is not kebab-case")}`,
		]);
		expect(findMasterSchemaName(idx)).toBe("masterSchema");
	});

	it("still resolves a validator declared in a module other than the call site's", () => {
		// The cross-module case must keep working: nothing guarantees the
		// declaration and the dispatch share a module, and on 2.1.259 they did
		// not. Ranking is a preference, not a restriction.
		const idx = indexModules([
			`var coreSchema=CH(()=>E.object({name:E.string().min(1)}));` +
				`var masterSchema=CH(()=>E.object({...coreSchema().shape}));` +
				`function jce(e,t,n){let a=masterSchema().safeParse(e);return a}` +
				pad(),
			`function lintManifest(m,r){jce(m,"plugin-json",{manifestPath:r});` +
				`if(!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(m.name))push("is not kebab-case")}`,
		]);
		expect(findMasterSchemaName(idx)).toBe("masterSchema");
	});

	it("composes the full plugin schema through the collision", () => {
		const idx = indexModules([
			decoyModule("jce", `return K`),
			validatorModule("jce"),
		]);
		const schema = buildPluginSchema(idx);
		expect(schema).not.toBeNull();
		const props = (schema as { properties: Record<string, object> }).properties;
		expect(Object.keys(props).sort()).toEqual(["name", "version"]);
	});
});

// ---------------------------------------------------------------------------
// Half 2 — a master failure must not abort the other eight schemas
// ---------------------------------------------------------------------------

describe("master-schema failure is contained", () => {
	it("returns null rather than throwing when the master cannot be located", () => {
		// The throw was the abort mechanism: `buildPluginSchema` ran before the
		// target loop, so throwing meant lsp/monitors/settings/frontmatter×3/
		// mcp/hooks were never attempted at all.
		const idx = indexModules([`var nothing=1;function f(){return nothing}`]);
		expect(() => buildPluginSchema(idx)).not.toThrow();
		expect(buildPluginSchema(idx)).toBeNull();
	});

	it("returns null rather than throwing when the master spread yields no refs", () => {
		// The second throw on the same path: master located, spread empty.
		const idx = indexModules([
			`var masterSchema=CH(()=>E.object({}));`,
			`function jce(e,t){let a=masterSchema().safeParse(e);return a}` +
				pad() +
				`function lint(m){jce(m,"plugin-json");` +
				`if(!/^[a-z]+$/.test(m.name))push("is not kebab-case")}`,
		]);
		expect(() => buildPluginSchema(idx)).not.toThrow();
		expect(buildPluginSchema(idx)).toBeNull();
	});

	it("gates the plugin schema through the same target table as the other eight", () => {
		// Being in the table is what makes the per-schema drift gate apply to the
		// plugin schema and what makes its failure a per-target verdict rather
		// than a whole-run abort.
		const targets = schemaTargets();
		expect(targets.map((t) => t.file)).toEqual([
			"plugin.schema.json",
			"lsp.schema.json",
			"monitors.schema.json",
			"settings.schema.json",
			"skill-frontmatter.schema.json",
			"agent-frontmatter.schema.json",
			"command-frontmatter.schema.json",
			"mcp.schema.json",
			"hooks.schema.json",
		]);
	});

	it("lets every later target still build when the plugin target returns null", () => {
		// The property that actually matters: the loop reaches the rest. Drive
		// the real table over an index with no master and assert the plugin
		// target reports null without throwing, so nothing downstream is skipped.
		const idx = indexModules([`var nothing=1;`]);
		const targets = schemaTargets();
		const plugin = targets.find((t) => t.key === "plugin");
		expect(plugin).toBeDefined();
		let reachedAfterPlugin = 0;
		for (const target of targets) {
			expect(() => target.build(idx)).not.toThrow();
			if (target.key !== "plugin") reachedAfterPlugin++;
		}
		expect(reachedAfterPlugin).toBe(8);
	});
});
