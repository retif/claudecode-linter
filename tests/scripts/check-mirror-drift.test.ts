import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * oleks/claudecode-linter#38 — the mirror-drift check must tell expected,
 * fast-forwardable lag (dependabot / release-workflow commits landing on the
 * github side by themselves) from a genuine fork, and must never pass
 * vacuously. Each case builds two bare "remotes" plus a clone and drives the
 * real script with GITHUB_URL / GITEA_REMOTE pointing at them.
 */

const REPO_ROOT = resolve(import.meta.dirname!, "..", "..");
const SCRIPT = join(REPO_ROOT, "ci", "check-mirror-drift.sh");

let tmp: string;
let github: string;
let gitea: string;
let work: string;

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		env: {
			...process.env,
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

function runCheck(env: Record<string, string> = {}) {
	const r = spawnSync("bash", [SCRIPT], {
		cwd: work,
		encoding: "utf8",
		env: {
			...process.env,
			CI: "",
			GITHUB_URL: github,
			GITEA_REMOTE: "gitea",
			MAX_DRIFT_HOURS: "24",
			...env,
		},
	});
	return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
}

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "ccl-mirror-drift-"));
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

describe("ci/check-mirror-drift.sh", () => {
	it("exits 0 and says in sync when both tips are equal", () => {
		const { code, out } = runCheck();
		expect(code).toBe(0);
		expect(out).toContain("in sync");
	});

	it("classifies github-only commits as fast-forwardable lag, not a fork", () => {
		// A server-side commit on the github side only (dependabot / release bot).
		commit(work, "dependabot-bump");
		git(work, "push", "-q", "origin", "main");
		const { code, out } = runCheck();
		expect(code).toBe(0); // under the 24 h threshold
		expect(out).toContain("FAST-FORWARDABLE (github ahead)");
		expect(out).toContain("git merge --ff-only origin/main");
		expect(out).not.toContain("DIVERGED");
	});

	it("classifies gitea-only commits as fast-forwardable lag on the gitea side", () => {
		commit(work, "merged-on-gitea");
		git(work, "push", "-q", "gitea", "main");
		const { code, out } = runCheck();
		expect(code).toBe(0);
		expect(out).toContain("FAST-FORWARDABLE (gitea ahead)");
		expect(out).toContain("CANNOT be released");
	});

	it("calls a two-sided history DIVERGED and does not suggest a plain push", () => {
		commit(work, "on-github");
		git(work, "push", "-q", "origin", "main");
		git(work, "reset", "-q", "--hard", "HEAD~1");
		commit(work, "on-gitea");
		git(work, "push", "-q", "gitea", "main");
		const { out } = runCheck();
		expect(out).toContain("DIVERGED");
		expect(out).toContain("merge one side into the other");
	});

	it("fails on any drift when MAX_DRIFT_HOURS=0", () => {
		commit(work, "dependabot-bump");
		git(work, "push", "-q", "origin", "main");
		const { code, out } = runCheck({ MAX_DRIFT_HOURS: "0" });
		expect(code).toBe(1);
		expect(out).toContain("FAILING");
	});

	it("exits 2 rather than passing when the github upstream is unreachable", () => {
		const { code, out } = runCheck({
			GITHUB_URL: join(tmp, "does-not-exist.git"),
		});
		expect(code).toBe(2);
		expect(out).toContain("CANNOT DETERMINE");
	});
});
