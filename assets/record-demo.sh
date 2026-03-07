#!/usr/bin/env bash
# Script to be run inside asciinema recording
set -e
cd /home/oleks/projects/claudecode-linter

export TERM=xterm-256color
export FORCE_COLOR=1

# Helper to simulate typing with prompt
run_cmd() {
	local cmd="$1"
	printf '$ '
	for ((i = 0; i < ${#cmd}; i++)); do
		printf '%s' "${cmd:$i:1}"
		sleep 0.04
	done
	echo
	sleep 0.3
}

clear
sleep 0.5

# 1. List rules (first 20)
run_cmd "claudecode-linter --list-rules | head -20"
node dist/index.js --list-rules | head -20
sleep 2

# 3. Lint demo plugin
run_cmd "claudecode-linter tests/fixtures/demo-plugin/"
node dist/index.js tests/fixtures/demo-plugin/ || true
sleep 2.5

# 4. Fix dry-run
run_cmd "claudecode-linter --fix-dry-run tests/fixtures/demo-plugin/ 2>&1 | head -20"
node dist/index.js --fix-dry-run tests/fixtures/demo-plugin/ 2>&1 | head -20 || true
sleep 2.5

# 5. Validate user settings
run_cmd "claudecode-linter --scope user ~/.claude/"
node dist/index.js --scope user ~/.claude/ || true
sleep 1.5

# 6. Validate project settings (scope-aware warnings)
run_cmd "claudecode-linter tests/fixtures/demo-plugin/.claude/settings.local.json"
node dist/index.js tests/fixtures/demo-plugin/.claude/settings.local.json || true
sleep 2

# 7. JSON output
run_cmd "claudecode-linter --output json tests/fixtures/demo-plugin/ 2>&1 | head -15"
node dist/index.js --output json tests/fixtures/demo-plugin/ 2>&1 | head -15 || true
sleep 2

echo
