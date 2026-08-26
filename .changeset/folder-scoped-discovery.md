---
"@promptowl/contextnest-engine": minor
---

Folder-scoped discovery and folder listing.

`context_list` and `NestStorage.discoverDocuments` accept `folder` (a path relative to the vault root, i.e. the id prefix) and `recursive`.

New `context_folders` operation and `NestStorage.listFolders`: the vault's folders and their document counts, read from directory entries without opening a single document. Discovery's cost is parsing every markdown file it finds, so a caller that only needs the vault's shape — a navigable tree, a folder picker, per-folder counts — now pays none of it. Folders are read rather than inferred from the documents inside them, so a folder holding only subfolders still appears.

This narrows the crawl rather than the result. Previously the only way to browse one folder was to read and parse every document in the vault and filter afterwards, which costs the same as not filtering — painful on a large vault, and worse on a network-backed mount where each document is a round trip. With `recursive: false` a folder's subfolders are never opened either, so a lazily-expanded document tree pays only for the level it is showing.

The vault walk now also stops descending once no pattern can match any deeper, so existing callers with non-recursive patterns (e.g. `listSuggestionIds`) stop reading subtrees they were already discarding.
