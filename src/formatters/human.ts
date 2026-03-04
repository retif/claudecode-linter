import chalk from "chalk";
import type { LintResult, Severity } from "../types.js";

const SEVERITY_ICONS: Record<Severity, string> = {
  error: chalk.red("error"),
  warning: chalk.yellow("warn "),
  info: chalk.blue("info "),
};

export function formatHuman(results: LintResult[], quiet: boolean): string {
  const lines: string[] = [];
  let errorCount = 0;
  let warningCount = 0;
  let infoCount = 0;

  for (const result of results) {
    const filtered = quiet
      ? result.diagnostics.filter((d) => d.severity === "error")
      : result.diagnostics;

    if (filtered.length === 0) continue;

    lines.push("");
    lines.push(chalk.underline(result.file));

    for (const d of filtered) {
      const loc = d.line ? chalk.dim(`:${d.line}${d.column ? `:${d.column}` : ""}`) : "";
      lines.push(`  ${SEVERITY_ICONS[d.severity]}  ${d.message}  ${chalk.dim(d.rule)}${loc}`);

      if (d.severity === "error") errorCount++;
      else if (d.severity === "warning") warningCount++;
      else infoCount++;
    }
  }

  if (errorCount === 0 && warningCount === 0 && infoCount === 0) {
    lines.push(chalk.green("No issues found."));
  } else {
    lines.push("");
    const parts: string[] = [];
    if (errorCount > 0) parts.push(chalk.red(`${errorCount} error${errorCount !== 1 ? "s" : ""}`));
    if (warningCount > 0) parts.push(chalk.yellow(`${warningCount} warning${warningCount !== 1 ? "s" : ""}`));
    if (!quiet && infoCount > 0) parts.push(chalk.blue(`${infoCount} info`));
    lines.push(parts.join(", "));
  }

  return lines.join("\n");
}
