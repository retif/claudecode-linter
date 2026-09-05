import { defineConfig } from "vitest/config";

// oleks/claudecode-linter#42: the two suites below shell out (`runCli` →
// `npx tsx` / `node dist/index.js`), so their wall time includes process spawn
// and TypeScript transform — the cost that balloons under CPU contention and
// blew vitest's 5000 ms default on a loaded host. They get their own project
// with a bounded, larger timeout; the ~700 in-process tests keep the default
// so a genuine slowdown there still fails fast.
const SUBPROCESS_SUITES = [
  "tests/scripts/check-deps.test.ts",
  "tests/scripts/check-mirror-drift.test.ts",
  "tests/resource-limits.test.ts",
];

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["tests/**/*.test.ts"],
          exclude: ["**/node_modules/**", ...SUBPROCESS_SUITES],
        },
      },
      {
        test: {
          name: "subprocess",
          include: SUBPROCESS_SUITES,
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
