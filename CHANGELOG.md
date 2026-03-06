# Changelog

## 2.1.69 (2026-03-06)

Synced with Claude Code v2.1.69.

### Changes

- **Hook Events**: +InstructionsLoaded
- **Settings (User)**: +includeGitInstructions, +pluginTrustMessage, +showThinkingSummaries

### Contract Summary

| Category | Count | Values |
|----------|------:|--------|
| Tools | 28 | Agent, AskUserQuestion, Bash, Edit, EnterPlanMode, EnterWorktree, ExitPlanMode, Glob, Grep, LSP, ... (28 total) |
| Hook Events | 21 | ConfigChange, Elicitation, ElicitationResult, InstructionsLoaded, Notification, PermissionRequest, PostToolUse, PostToolUseFailure, PreCompact, PreToolUse, ... (21 total) |
| Hook Types | 4 | agent, command, http, prompt |
| Prompt Events | 8 | Notification, PostToolUse, PostToolUseFailure, PreToolUse, SessionStart, Setup, SubagentStart, UserPromptSubmit |
| Agent Colors | 9 | blue, cyan, green, magenta, orange, pink, purple, red, yellow |
| Agent Models | 4 | haiku, inherit, opus, sonnet |
| Plugin JSON Fields | 8 | name, version, description, author, homepage, repository, license, keywords |
| Agent Frontmatter | 9 | description, tools, disallowedTools, prompt, model, mcpServers, criticalSystemReminder_EXPERIMENTAL, skills, maxTurns |
| Command Frontmatter | 6 | source, content, description, argumentHint, model, allowedTools |
| MCP Server Fields | 9 | type, command, args, env, url, headers, headersHelper, oauth, cwd |
| Skill Frontmatter | 9 | allowed-tools, argument-hint, description, disable-model-invocation, model, name, user-invocable, version, when_to_use |
| Settings (User) | 61 | agent, allowManagedHooksOnly, allowManagedMcpServersOnly, ... (61 total) |
| Settings (Project) | 1 | permissions |
