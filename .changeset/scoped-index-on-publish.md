---
"@promptowl/contextnest-engine": minor
---

**Publishing or approving one document no longer rewrites every folder's index.** The index rebuild that follows a publish now rewrites only the INDEX.md of the folder the document lives in, since a folder's index lists only its own documents; context.yaml is still rebuilt in full. Agent configuration files (CLAUDE.md, GEMINI.md, .cursorrules and the rest) are only written when their content actually changed. On a nest with many folders this makes each publish, and each approval in a bulk review, far cheaper. The rebuild takes a new optional changedIds option to scope it; calls without it behave as before.
