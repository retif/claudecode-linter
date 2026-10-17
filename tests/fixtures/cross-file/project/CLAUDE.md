# Project

Fixture for the CLAUDE.md import rules.

## Imports

- @docs/a.md resolves, and @docs/a.md#intro resolves without its fragment
- @docs/missing.md is broken
- @./docs/cycle-a.md leads into a cycle
- @docs/deep1.md is a chain one hop too deep
- @docs is a directory
- `@docs/span-missing.md` is in a code span
- ping @oleks and install @anthropic-ai/claude-code are not file imports
- mail me at someone@docs/missing-mail.md (no whitespace before @)

<!-- @docs/comment-missing.md -->

```sh
cat @docs/fence-missing.md
```
