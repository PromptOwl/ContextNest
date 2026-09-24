---
"@promptowl/contextnest-cli": minor
---

New `ctx pull <remote> --recipe <id>`: pull a recipe from a remote nest into the local vault. A recipe is a node (slug `recipe-<id>`) with a ```yaml recipe manifest naming the documents, skills, template files and pack to bring in. Pulled documents land as drafts with `derived_from` lineage and the upstream version. A re-pull skips what is current, applies newer upstream versions only with `--update`, and never overwrites a document or file it did not pull. `--dry-run` prints the plan and writes nothing.
