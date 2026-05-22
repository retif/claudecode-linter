import {
  SKILL_FRONTMATTER,
  AGENT_FRONTMATTER,
  COMMAND_FRONTMATTER,
} from "../contracts.js";
import {
  loadSkillFrontmatterSchema,
  loadAgentFrontmatterSchema,
  loadCommandFrontmatterSchema,
} from "../plugin-schema.js";

/**
 * Cross-artifact classification of a markdown frontmatter key.
 *
 * The `no-unknown-frontmatter` rules for skill/agent/command markdown used to
 * warn on *any* key outside the current artifact's known set. That over-flags:
 * a genuinely unfamiliar key (a typo, a one-off) is harmless noise, while a
 * key that is valid for a *different* markdown artifact is the actually
 * interesting case — it usually means the author pasted frontmatter from the
 * wrong artifact type, and Claude Code will silently ignore it.
 *
 * So these rules now only speak up for the misplacement case:
 *  - `"owned-by-other"` — the key is unknown here but valid for another
 *    markdown artifact (skill/agent/command). Emit an `info` naming the owner.
 *  - `"unknown-everywhere"` — the key is valid for no artifact at all.
 *    Emit nothing.
 */
export type ArtifactKind = "skill" | "agent" | "command";

// Census-extraction sets (scripts/extract-contracts.ts). Used only as a
// fallback when the auto-extracted frontmatter schema is unavailable — the
// census extractor lags the schema walker (e.g. it was missing `effort`).
const CENSUS_FALLBACK: Record<ArtifactKind, ReadonlySet<string>> = {
  skill: SKILL_FRONTMATTER,
  agent: AGENT_FRONTMATTER,
  command: COMMAND_FRONTMATTER,
};

const SCHEMA_LOADERS: Record<
  ArtifactKind,
  () => { knownFields: ReadonlySet<string> } | null
> = {
  skill: loadSkillFrontmatterSchema,
  agent: loadAgentFrontmatterSchema,
  command: loadCommandFrontmatterSchema,
};

const keyCache = new Map<ArtifactKind, ReadonlySet<string>>();

/**
 * Known frontmatter keys for an artifact — the union of the auto-extracted
 * schema's property names (authoritative, complete, kept in sync with Claude
 * Code's Zod) and the census-contract set. Union rather than schema-only so a
 * key known to *either* extraction is never mis-flagged: `no-unknown-
 * frontmatter` is advisory and a false positive is the only real harm.
 */
function knownKeys(kind: ArtifactKind): ReadonlySet<string> {
  const cached = keyCache.get(kind);
  if (cached) return cached;
  const merged = new Set<string>(CENSUS_FALLBACK[kind]);
  const schema = SCHEMA_LOADERS[kind]();
  if (schema) for (const k of schema.knownFields) merged.add(k);
  keyCache.set(kind, merged);
  return merged;
}

const ARTIFACT_LABEL: Record<ArtifactKind, string> = {
  skill: "skill",
  agent: "agent",
  command: "command",
};

export interface CrossArtifactResult {
  kind: "owned-by-other" | "unknown-everywhere";
  /** Owning artifact kind, present only when kind === "owned-by-other". */
  owner?: ArtifactKind;
}

/**
 * Classify `key` relative to `self` (the artifact being linted).
 *
 * `extraKnown` lets a caller treat a few extra keys as known-for-self (some
 * linters historically accept hyphenated aliases the contract set lists in a
 * canonicalized form, e.g. `allowed-tools` / `argument-hint`).
 */
export function classifyUnknownFrontmatterKey(
  key: string,
  self: ArtifactKind,
  extraKnown: ReadonlySet<string> = new Set(),
): CrossArtifactResult | null {
  // Known for the current artifact — not unknown at all.
  if (knownKeys(self).has(key) || extraKnown.has(key)) return null;

  // Valid for some *other* markdown artifact → misplacement.
  for (const kind of ["skill", "agent", "command"] as ArtifactKind[]) {
    if (kind === self) continue;
    if (knownKeys(kind).has(key)) {
      return { kind: "owned-by-other", owner: kind };
    }
  }

  // Valid nowhere → genuinely unfamiliar; callers stay silent.
  return { kind: "unknown-everywhere" };
}

/** Human-readable label for an artifact kind ("skill", "agent", "command"). */
export function artifactLabel(kind: ArtifactKind): string {
  return ARTIFACT_LABEL[kind];
}
