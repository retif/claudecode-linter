import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * oleks/claudecode-linter#47 — ci/mirror-sync.sh pushes to `main` unattended,
 * so the refusals are the deliverable: it may move gitea main only on a proven
 * fast-forward, and every other shape or uncertainty must leave the tip where
 * it was. Each case builds two bare "remotes" plus a clone and drives the real
 * script.
 */

const REPO_ROOT = resolve(import.meta.dirname!, "..", "..");
const SCRIPT = join(REPO_ROOT, "ci", "mirror-sync.sh");

let tmp: string;
let github: string;
let gitea: string;
let work: string;

// Host git config must not leak in: a system-wide core.hooksPath (as on the
// fleet's hosts) replaces every repo's hooks/ dir, which both runs the fleet's
// push hooks on these fixture pushes and silently disables the pre-receive
// hook the rejection test installs.
const ISOLATED_GIT = (): Record<string, string> => ({
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_CONFIG_GLOBAL: join(tmp, "empty-gitconfig"),
});

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		env: {
			...process.env,
			...ISOLATED_GIT(),
			GIT_AUTHOR_NAME: "t",
			GIT_AUTHOR_EMAIL: "t@example.invalid",
			GIT_COMMITTER_NAME: "t",
			GIT_COMMITTER_EMAIL: "t@example.invalid",
		},
	}).trim();
}

function commit(cwd: string, name: string): void {
	writeFileSync(join(cwd, name), `${name}\n`);
	git(cwd, "add", name);
	git(cwd, "commit", "-q", "-m", name);
}

function tip(bare: string): string {
	return git(bare, "rev-parse", "refs/heads/main");
}

function run(args: string[] = [], env: Record<string, string> = {}) {
	const r = spawnSync("bash", [SCRIPT, ...args], {
		cwd: work,
		encoding: "utf8",
		env: {
			...process.env,
			...ISOLATED_GIT(),
			CI: "",
			GITHUB_URL: github,
			GITEA_URL: "",
			GITEA_REMOTE: "gitea",
			...env,
		},
	});
	return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
}

/** One commit on the github side only — what dependabot / the release bot do. */
function githubAhead(): void {
	commit(work, "bot-bump");
	git(work, "push", "-q", "origin", "main");
}

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "ccl-mirror-sync-"));
	writeFileSync(join(tmp, "empty-gitconfig"), "");
	github = join(tmp, "github.git");
	gitea = join(tmp, "gitea.git");
	work = join(tmp, "work");
	git(tmp, "init", "-q", "--bare", "-b", "main", github);
	git(tmp, "init", "-q", "--bare", "-b", "main", gitea);
	git(tmp, "init", "-q", "-b", "main", work);
	commit(work, "base");
	git(work, "remote", "add", "origin", github);
	git(work, "remote", "add", "gitea", gitea);
	git(work, "push", "-q", "origin", "main");
	git(work, "push", "-q", "gitea", "main");
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

describe("ci/mirror-sync.sh", () => {
	it("is a no-op when both tips are equal", () => {
		const before = tip(gitea);
		const { code, out } = run(["--apply"]);
		expect(code).toBe(0);
		expect(out).toContain("in sync");
		expect(tip(gitea)).toBe(before);
	});

	it("fast-forwards gitea to github with --apply, and reads the result back", () => {
		githubAhead();
		const { code, out } = run(["--apply"]);
		expect(code).toBe(0);
		expect(out).toContain("FAST-FORWARDABLE (gitea 1 commit(s) behind github)");
		expect(out).toContain("fast-forwarded gitea main");
		expect(tip(gitea)).toBe(tip(github));
	});

	it("pushes nothing without --apply (dry run is the default)", () => {
		githubAhead();
		const before = tip(gitea);
		const { code, out } = run();
		expect(code).toBe(0);
		expect(out).toContain("dry run — would fast-forward");
		expect(tip(gitea)).toBe(before);
	});

	it("refuses DIVERGED and leaves the gitea tip alone", () => {
		githubAhead();
		git(work, "reset", "-q", "--hard", "HEAD~1");
		commit(work, "on-gitea");
		git(work, "push", "-q", "gitea", "main");
		const before = tip(gitea);
		const { code, out } = run(["--apply"]);
		expect(code).toBe(1);
		expect(out).toContain("DIVERGED");
		expect(tip(gitea)).toBe(before);
	});

	it("refuses when gitea is ahead — that direction is a human decision", () => {
		commit(work, "merged-on-gitea");
		git(work, "push", "-q", "gitea", "main");
		const ghBefore = tip(github);
		const gtBefore = tip(gitea);
		const { code, out } = run(["--apply"]);
		expect(code).toBe(1);
		expect(out).toContain("gitea is AHEAD");
		expect(tip(github)).toBe(ghBefore);
		expect(tip(gitea)).toBe(gtBefore);
	});

	it("exits 2 when the github upstream is unreachable", () => {
		const before = tip(gitea);
		const { code, out } = run(["--apply"], { GITHUB_URL: join(tmp, "missing.git") });
		expect(code).toBe(2);
		expect(out).toContain("CANNOT DETERMINE");
		expect(tip(gitea)).toBe(before);
	});

	it("exits 2 when the gitea side is unreachable", () => {
		githubAhead();
		const { code, out } = run(["--apply"], { GITEA_URL: join(tmp, "missing.git") });
		expect(code).toBe(2);
		expect(out).toContain("could not fetch main from gitea");
	});

	it("refuses, non-zero, when gitea rejects the push — and nothing moves", () => {
		githubAhead();
		const hook = join(gitea, "hooks", "pre-receive");
		writeFileSync(hook, "#!/bin/sh\necho 'denied by test' >&2\nexit 1\n");
		chmodSync(hook, 0o755);
		const before = tip(gitea);
		const { code, out } = run(["--apply"]);
		expect(code).toBe(1);
		expect(out).toContain("REFUSED");
		expect(tip(gitea)).toBe(before);
	});

	it("refuses in CI when the push credential is missing", () => {
		githubAhead();
		const before = tip(gitea);
		const { code, out } = run(["--apply"], {
			CI: "woodpecker",
			CI_REPO_CLONE_URL: gitea,
			REGISTRY_TOKEN: "",
		});
		expect(code).toBe(1);
		expect(out).toContain("REGISTRY_TOKEN");
		expect(tip(gitea)).toBe(before);
	});

	it("never prints the token-bearing gitea URL", () => {
		githubAhead();
		const { out } = run(["--apply"], {
			CI: "woodpecker",
			CI_REPO_CLONE_URL: "https://git.invalid/o/r.git",
			REGISTRY_TOKEN: "s3cr3t-token-value",
		});
		expect(out).not.toContain("s3cr3t-token-value");
	});

	it("rejects unknown arguments instead of guessing", () => {
		const { code } = run(["--force"]);
		expect(code).toBe(2);
	});
});
