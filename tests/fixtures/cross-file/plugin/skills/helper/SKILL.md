---
name: helper-by-name
description: Use when testing referenced-files-exist.
---

# Helper

## References

- [guide](references/guide.md) resolves
- [guide section](references/guide.md#setup) resolves without its anchor
- ![diagram](./assets/missing.png) is broken
- [missing](references/missing.md) is broken
- `[in a code span](references/span.md)` is not a link
- [site](https://example.com/docs) and [anchor](#references) are skipped
- [plugin var](${CLAUDE_PLUGIN_ROOT}/x.md) and [mail](mailto:a@b.c) are skipped

```markdown
[in a fence](references/fenced.md)
```
