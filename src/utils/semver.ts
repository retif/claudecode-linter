// https://semver.org/#is-there-a-suggested-regular-expression-regex-to-check-a-semver-string
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

const MAX_LENGTH = 256;

// Mirrors node-semver's `valid()`: surrounding whitespace and an optional
// leading "v" are tolerated, numeric components must stay below 2^53.
export function isValidSemver(version: unknown): boolean {
  if (typeof version !== "string") return false;

  const trimmed = version.trim().replace(/^v/, "");
  if (trimmed.length === 0 || trimmed.length > MAX_LENGTH) return false;

  const m = SEMVER_RE.exec(trimmed);
  if (!m) return false;

  for (const part of [m[1], m[2], m[3]]) {
    if (Number(part) > Number.MAX_SAFE_INTEGER) return false;
  }

  return true;
}
