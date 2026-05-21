import {
  SKILL_FRONTMATTER,
  AGENT_FRONTMATTER,
  COMMAND_FRONTMATTER,
} from "../contracts.js";

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

const KEY_SETS: Record<ArtifactKind, ReadonlySet<string>> = {
  skill: SKILL_FRONTMATTER,
  agent: AGENT_FRONTMATTER,
  command: COMMAND_FRONTMATTER,
};

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
  if (KEY_SETS[self].has(key) || extraKnown.has(key)) return null;

  // Valid for some *other* markdown artifact → misplacement.
  for (const kind of ["skill", "agent", "command"] as ArtifactKind[]) {
    if (kind === self) continue;
    if (KEY_SETS[kind].has(key)) {
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
