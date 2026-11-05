---
"@promptowl/contextnest-engine": minor
"@promptowl/contextnest-cli": minor
---

`ctx validate` lists every dangling reference (`[[wikilink]]`, `contextnest://` node link, `depends_on`) with its document and line, as warnings that leave the exit code alone; `--json` adds a `dangling` array. `ctx delete` names the documents that will be left linking to a deleted one, and still deletes it. The engine exports `findDanglingReferences`. A `folder` given with its `nodes/` root (`nodes/briefs`) now files under `nodes/briefs` on create and import, not `nodes/nodes/briefs`.
