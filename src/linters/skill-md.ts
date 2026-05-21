import type { Linter, LintDiagnostic, LinterConfig, Severity } from "../types.js";
import { isRuleEnabled, getRuleSeverity } from "../types.js";
import { parseFrontmatter } from "../utils/frontmatter.js";
import {
  artifactLabel,
  classifyUnknownFrontmatterKey,
} from "../utils/frontmatter-keys.js";
import { isKebabCase } from "../utils/kebab-case.js";

interface RuleDef { id: string; defaultSeverity: Severity; }

const RULES: RuleDef[] = [
  { id: "skill-md/valid-frontmatter", defaultSeverity: "error" },
  { id: "skill-md/name-required", defaultSeverity: "error" },
  { id: "skill-md/name-kebab-case", defaultSeverity: "error" },
  { id: "skill-md/name-max-length", defaultSeverity: "error" },
  { id: "skill-md/description-required", defaultSeverity: "error" },
  { id: "skill-md/description-max-length", defaultSeverity: "error" },
  { id: "skill-md/description-no-angle-brackets", defaultSeverity: "error" },
  { id: "skill-md/description-trigger-phrases", defaultSeverity: "warning" },
  { id: "skill-md/no-unknown-frontmatter", defaultSeverity: "info" },
  { id: "skill-md/body-word-count", defaultSeverity: "info" },
  { id: "skill-md/body-has-headers", defaultSeverity: "info" },
];

/**
 * Decide whether a SKILL.md `description` communicates *when* the skill
 * applies. A description that gives Claude Code any concrete applicability
 * cue is fine — only purely declarative descriptions (a flat statement of
 * what the skill is, with no routing signal at all) should be flagged.
 *
 * Recognized signals, in rough order of how common they are in real skills:
 *  - explicit trigger sections: "Trigger on …", "Trigger when/whenever …",
 *    "Triggers: …", "TRIGGER when:", routing-marker comments
 *  - "use when / use for / use whenever / use this skill when / use to"
 *  - "should be used when …", "applies when …", "invoke when …"
 *  - "when the user asks/wants/mentions/needs …" and bare "when <verb>ing"
 *  - imperative-verb openers ("Diagnose …", "Deploy …", "Author …") — an
 *    imperative description states the task the skill performs, which is
 *    itself an applicability cue
 *  - gerund openers ("Building …", "Searching …")
 */
function hasTriggerSignal(desc: string): boolean {
  const d = desc.trim();
  if (!d) return false;

  // Routing-marker comments authors drop in to delimit trigger lists.
  if (/BEGIN ROUTING TRIGGERS|ROUTING TRIGGERS/i.test(d)) return true;

  // Explicit trigger / use-when phrasing anywhere in the description.
  // "Trigger" only counts as a routing cue when used as a directive verb
  // ("Trigger on …", "Trigger when/whenever/if …", "Triggers: …", "TRIGGER
  // when:") — not when "trigger" merely appears as a noun (e.g. the phrase
  // "no trigger phrases").
  const triggerPhrases =
    /\btrigger(s)?\b\s*(on|when|whenever|if|upon|for)\b|\btriggers?\s*:|\buse (this skill |it )?(when|whenever|for|to|on|if)\b|\bshould be used (when|whenever|for|to|if)\b|\b(applies|invoke|reach for|call this|run this|use this) (when|whenever|if|to|for)\b|\bwhen (the user|you|asked|working|debugging|diagnosing|investigating|reviewing|writing|building|creating|editing|setting up|deploying|the task|a request|a question|you need|there|something|anything)\b|\bwhen [a-z]+ing\b|\bfor (debugging|diagnosing|tasks|requests|questions|when|any)\b/i;
  if (triggerPhrases.test(d)) return true;

  // First "sentence-ish" chunk — used to detect imperative / gerund openers.
  const opener = d.split(/[.\n—:(]/, 1)[0].trim();
  const firstWord = opener.split(/\s+/, 1)[0].replace(/[^A-Za-z-]/g, "");

  // Gerund opener ("Building a …", "Searching the …").
  if (/^[A-Z][a-z]+ing\b/.test(opener)) return true;

  // Imperative-verb opener. A skill description that starts with a bare
  // verb is describing the action the skill performs, which signals when
  // to route to it. Accept a curated set of common imperative verbs so we
  // don't accidentally pass a noun-opener declarative description.
  const imperativeVerbs = new Set([
    "add", "analyze", "audit", "author", "automate", "build", "check",
    "clean", "configure", "convert", "create", "debug", "delete", "deploy",
    "diagnose", "drive", "edit", "enforce", "ensure", "estimate",
    "evaluate", "execute", "extract", "fetch", "find", "fix", "format",
    "generate", "guide", "handle", "help", "identify", "implement",
    "initialize", "inspect", "install", "investigate", "lint", "list",
    "manage", "migrate", "mint", "monitor", "open", "optimize", "parse",
    "perform", "pin", "plan", "prepare", "preview", "produce", "profile",
    "publish", "pull", "push", "query", "reclaim", "refactor", "render",
    "report", "resolve", "restore", "review", "rollout", "run", "scaffold",
    "scan", "search", "set", "ship", "size", "summarize", "sweep", "sync",
    "test", "trace", "track", "transform", "transition", "translate",
    "troubleshoot", "tune", "update", "upgrade", "validate", "verify",
    "watch", "write",
  ]);
  if (imperativeVerbs.has(firstWord.toLowerCase())) return true;

  return false;
}

function diag(
  config: LinterConfig,
  filePath: string,
  ruleId: string,
  defaultSeverity: Severity,
  message: string,
  line?: number,
  column?: number,
): LintDiagnostic | null {
  if (!isRuleEnabled(config, ruleId)) return null;
  return {
    rule: ruleId,
    severity: getRuleSeverity(config, ruleId, defaultSeverity),
    message,
    file: filePath,
    line,
    column,
  };
}

export const skillMdLinter: Linter = {
  artifactType: "skill-md",

  lint(filePath: string, content: string, config: LinterConfig): LintDiagnostic[] {
    const diagnostics: LintDiagnostic[] = [];
    const push = (d: LintDiagnostic | null) => { if (d) diagnostics.push(d); };

    const fm = parseFrontmatter(content);

    if (!fm.valid) {
      push(diag(config, filePath, "skill-md/valid-frontmatter", "error",
        fm.error ?? "Invalid frontmatter"));
      return diagnostics;
    }

    // name
    if (!("name" in fm.data) || typeof fm.data.name !== "string") {
      push(diag(config, filePath, "skill-md/name-required", "error",
        "\"name\" is required in frontmatter"));
    } else {
      const name = fm.data.name;
      if (!isKebabCase(name)) {
        push(diag(config, filePath, "skill-md/name-kebab-case", "error",
          `"name" must be kebab-case (got "${name}")`));
      }
      if (name.length > 64) {
        push(diag(config, filePath, "skill-md/name-max-length", "error",
          `"name" must be at most 64 characters (got ${name.length})`));
      }
    }

    // description
    if (!("description" in fm.data) || typeof fm.data.description !== "string") {
      push(diag(config, filePath, "skill-md/description-required", "error",
        "\"description\" is required in frontmatter"));
    } else {
      const desc = fm.data.description;
      if (desc.length > 1024) {
        push(diag(config, filePath, "skill-md/description-max-length", "error",
          `"description" must be at most 1024 characters (got ${desc.length})`));
      }
      if (/<|>/.test(desc)) {
        push(diag(config, filePath, "skill-md/description-no-angle-brackets", "error",
          "\"description\" must not contain angle brackets (< or >)"));
      }
      if (!hasTriggerSignal(desc)) {
        push(diag(config, filePath, "skill-md/description-trigger-phrases", "warning",
          "Description has no applicability signal — say when the skill applies " +
          "(e.g., \"Use when…\", \"Trigger on…\", \"when the user asks to…\", or an imperative verb)"));
      }
    }

    // Frontmatter keys: only flag cross-artifact misplacement. A key that is
    // valid for a *different* markdown artifact (e.g. agent's "effort" on a
    // skill) gets an info; a key valid for no artifact stays silent.
    for (const key of Object.keys(fm.data)) {
      const cls = classifyUnknownFrontmatterKey(key, "skill");
      if (cls?.kind === "owned-by-other" && cls.owner) {
        push(diag(config, filePath, "skill-md/no-unknown-frontmatter", "info",
          `"${key}" is ${artifactLabel(cls.owner)} frontmatter — Claude Code ignores it on a skill`));
      }
    }

    // body checks
    const body = fm.body.trim();
    if (body) {
      // Word-count is a soft style hint: a concise, well-scoped skill body is
      // legitimate. Only flag genuinely thin bodies (< 150 words) or very
      // large ones (> 5000) that likely belong split into references/.
      const words = body.split(/\s+/).length;
      if (words < 150) {
        push(diag(config, filePath, "skill-md/body-word-count", "info",
          `Body has ${words} words — consider adding more detail (recommended: 150-5000)`, fm.bodyStartLine));
      } else if (words > 5000) {
        push(diag(config, filePath, "skill-md/body-word-count", "info",
          `Body has ${words} words — consider moving detail to references/ (recommended: 150-5000)`, fm.bodyStartLine));
      }

      if (!/^##\s/m.test(body)) {
        push(diag(config, filePath, "skill-md/body-has-headers", "info",
          "Body should use H2 (##) sections for organization", fm.bodyStartLine));
      }
    }

    return diagnostics;
  },
};

export { RULES as SKILL_MD_RULES };
