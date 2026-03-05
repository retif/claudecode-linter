#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { relative } from "node:path";
import { Command } from "commander";
import { loadConfig, mergeCliRules } from "./config.js";
import { discoverArtifacts } from "./discovery.js";
import { formatHuman } from "./formatters/human.js";
import { formatJson } from "./formatters/json.js";
import { pluginJsonLinter } from "./linters/plugin-json.js";
import { skillMdLinter } from "./linters/skill-md.js";
import { agentMdLinter } from "./linters/agent-md.js";
import { commandMdLinter } from "./linters/command-md.js";
import { hooksJsonLinter } from "./linters/hooks-json.js";
import { settingsJsonLinter } from "./linters/settings-json.js";
import { mcpJsonLinter } from "./linters/mcp-json.js";
import { claudeMdLinter } from "./linters/claude-md.js";
import { pluginJsonFixer } from "./fixers/plugin-json.js";
import { frontmatterFixer } from "./fixers/frontmatter.js";
import { hooksJsonFixer } from "./fixers/hooks-json.js";
import { mcpJsonFixer } from "./fixers/mcp-json.js";
import { settingsJsonFixer } from "./fixers/settings-json.js";
import { claudeMdFixer } from "./fixers/claude-md.js";
import { PLUGIN_JSON_RULES } from "./linters/plugin-json.js";
import { SKILL_MD_RULES } from "./linters/skill-md.js";
import { AGENT_MD_RULES } from "./linters/agent-md.js";
import { COMMAND_MD_RULES } from "./linters/command-md.js";
import { HOOKS_JSON_RULES } from "./linters/hooks-json.js";
import { SETTINGS_JSON_RULES } from "./linters/settings-json.js";
import { MCP_JSON_RULES } from "./linters/mcp-json.js";
import { CLAUDE_MD_RULES } from "./linters/claude-md.js";
import type { ArtifactType, ConfigScope, Linter, Fixer, LintResult } from "./types.js";

const LINTERS: Record<ArtifactType, Linter> = {
  "plugin-json": pluginJsonLinter,
  "skill-md": skillMdLinter,
  "agent-md": agentMdLinter,
  "command-md": commandMdLinter,
  "hooks-json": hooksJsonLinter,
  "settings-json": settingsJsonLinter,
  "mcp-json": mcpJsonLinter,
  "claude-md": claudeMdLinter,
};

const FIXERS: Partial<Record<ArtifactType, Fixer>> = {
  "plugin-json": pluginJsonFixer,
  "skill-md": frontmatterFixer,
  "agent-md": { ...frontmatterFixer, artifactType: "agent-md" },
  "command-md": { ...frontmatterFixer, artifactType: "command-md" },
  "hooks-json": hooksJsonFixer,
  "mcp-json": mcpJsonFixer,
  "settings-json": settingsJsonFixer,
  "claude-md": claudeMdFixer,
};

const ALL_RULES = [
  ...PLUGIN_JSON_RULES,
  ...SKILL_MD_RULES,
  ...AGENT_MD_RULES,
  ...COMMAND_MD_RULES,
  ...HOOKS_JSON_RULES,
  ...SETTINGS_JSON_RULES,
  ...MCP_JSON_RULES,
  ...CLAUDE_MD_RULES,
];

function simpleDiff(oldContent: string, newContent: string, filePath: string): string {
  if (oldContent === newContent) return "";
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  const lines: string[] = [];
  lines.push(`--- ${filePath}`);
  lines.push(`+++ ${filePath} (fixed)`);
  let i = 0;
  let j = 0;
  while (i < oldLines.length || j < newLines.length) {
    const oldLine = i < oldLines.length ? oldLines[i] : undefined;
    const newLine = j < newLines.length ? newLines[j] : undefined;
    if (oldLine === newLine) {
      lines.push(` ${oldLine}`);
      i++;
      j++;
    } else if (oldLine !== undefined && newLine !== undefined) {
      lines.push(`-${oldLine}`);
      lines.push(`+${newLine}`);
      i++;
      j++;
    } else if (oldLine !== undefined) {
      lines.push(`-${oldLine}`);
      i++;
    } else {
      lines.push(`+${newLine}`);
      j++;
    }
  }
  return lines.join("\n");
}

const program = new Command();

program
  .name("claude-lint")
  .description("Linter for Claude Code plugin artifacts")
  .version("0.1.0")
  .argument("[paths...]", "Plugin directories or individual files", ["."])
  .option("--fix", "Auto-fix fixable issues")
  .option("--output <type>", "Output format: human | json", "human")
  .option("--config <path>", "Config file path")
  .option("--scope <scope>", "Filter by scope: user | project | subdirectory")
  .option("--ignore <patterns>", "Comma-separated glob patterns to ignore")
  .option("--quiet", "Only show errors")
  .option("--enable <rules>", "Comma-separated rule IDs to enable")
  .option("--disable <rules>", "Comma-separated rule IDs to disable")
  .option("--rule <rule>", "Run only this single rule ID")
  .option("--list-rules", "Print all rules with their default severity and exit")
  .option("--fix-dry-run", "Run fixers but print diff instead of writing")
  .action((paths: string[], opts) => {
    try {
      if (opts.listRules) {
        for (const rule of ALL_RULES) {
          process.stdout.write(`${rule.id}\t${rule.defaultSeverity}\n`);
        }
        process.exit(0);
      }

      const enableList = opts.enable
        ? (opts.enable as string).split(",").map((s: string) => s.trim()).filter(Boolean)
        : [];
      const disableList = opts.disable
        ? (opts.disable as string).split(",").map((s: string) => s.trim()).filter(Boolean)
        : [];

      const config = mergeCliRules(loadConfig(opts.config), enableList, disableList);
      const results: LintResult[] = [];
      const scopeFilter = opts.scope as ConfigScope | undefined;
      const ignorePatterns: string[] = opts.ignore
        ? opts.ignore.split(",").map((p: string) => p.trim()).filter(Boolean)
        : [];

      for (const targetPath of paths) {
        const artifacts = discoverArtifacts(targetPath, { scope: scopeFilter, ignore: ignorePatterns });

        if (artifacts.length === 0) {
          process.stderr.write(`No plugin artifacts found in ${targetPath}\n`);
          continue;
        }

        for (const artifact of artifacts) {
          let content = readFileSync(artifact.filePath, "utf-8");
          const linter = LINTERS[artifact.artifactType];

          let fixed = 0;
          if (opts.fix) {
            const fixer = FIXERS[artifact.artifactType];
            if (fixer) {
              const fixedContent = fixer.fix(artifact.filePath, content, config);
              if (fixedContent !== content) {
                writeFileSync(artifact.filePath, fixedContent);
                content = fixedContent;
                fixed = 1;
              }
            }
          } else if (opts.fixDryRun) {
            const fixer = FIXERS[artifact.artifactType];
            if (fixer) {
              const fixedContent = fixer.fix(artifact.filePath, content, config);
              if (fixedContent !== content) {
                const diff = simpleDiff(content, fixedContent, artifact.filePath);
                process.stdout.write(diff + "\n");
              }
            }
          }

          let diagnostics = linter.lint(artifact.filePath, content, config, artifact.scope);

          if (opts.rule) {
            diagnostics = diagnostics.filter((d) => d.rule === (opts.rule as string));
          }

          results.push({
            file: relative(process.cwd(), artifact.filePath),
            artifact: artifact.artifactType,
            diagnostics,
            fixed: opts.fix ? fixed : undefined,
          });
        }
      }

      if (!opts.fixDryRun) {
        const output = opts.output === "json"
          ? formatJson(results, !!opts.quiet)
          : formatHuman(results, !!opts.quiet);

        process.stdout.write(output + "\n");
      }

      const hasErrors = results.some((r) =>
        r.diagnostics.some((d) => d.severity === "error"),
      );
      process.exit(hasErrors ? 1 : 0);
    } catch (err) {
      process.stderr.write(`Fatal error: ${(err as Error).message}\n`);
      process.exit(2);
    }
  });

program.parse();
