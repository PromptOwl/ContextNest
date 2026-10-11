# Structure rules

A nest owner can set hard rules for a vault's layout:
- which folders may exist;
- which node types each folder takes;
- what folder and file names must look like;
- the template a folder's new files start from, and the headings they must keep;
- the subfolders and files every matching folder must have.

The rules live in the vault itself, in `.context/config.yaml`, and the engine enforces them on every write surface: the `ctx` CLI, the MCP server, the engine API, and anything built on it, such as Context Nest Community.

The rules are opt-in. A vault without them works exactly as before. The normative definition is [`CONTEXT_NEST_SPEC.md` §11.1.1](../CONTEXT_NEST_SPEC.md); this page is the guide.

## A quick example

```yaml
# .context/config.yaml (next to the vault's existing keys)
structure:
  enforce: true      # refuse writes that break a rule (false or absent: report only)
  closed: true       # only the folders below may exist and hold documents

folders:
  "/": {}                                   # the vault root, declared but empty
  "clients/{client}":
    folder_name: "/[a-z]+-[0-9]{3}/"        # acme-042, globex-117, …
    types: [document]
    files:
      overview: { template: client-overview }   # every client folder has one
  "clients/{client}/meetings":
    required: true                           # created with its client folder
    types: [document]
    file_name: "{date}-{slug}"               # 2026-10-07-kickoff
    template: meeting-note
  "clients/{client}/contracts":
    required: true
    types: [pdf]

templates:
  meeting-note:
    body: "## Attendees\n## Decisions\n## Action items\n"
    required_sections: [Decisions, Action items]
  client-overview:
    body: "## Summary\n## Contacts\n"
```

With these rules the CLI behaves like this. The output below is a real run of the CLI.

```console
$ ctx add nodes/clients/acme-042/meetings/2026-10-07-kickoff --title "2026-10-07 Kickoff"
Created and published nodes/clients/acme-042/meetings/2026-10-07-kickoff.md
```

That one write also created:

```text
nodes/clients/acme-042/
  overview.md          # required file, a draft from the client-overview template
  meetings/
    2026-10-07-kickoff.md   # starts from the meeting-note template
  contracts/           # required folder
```

Writes that break a rule are refused, and the message names the rule:

```console
$ ctx add nodes/clients/acme-042/meetings/kickoff --title "Kickoff"
Error [VALIDATION_FAILED]: File names in "clients/acme-042/meetings/" must look like {date}-{slug}; "kickoff" does not. A file is named after its title (lowercased, words joined by "-"), so title the document to fit.

$ ctx add nodes/clients/Acme/meetings/2026-10-07-intro --title "2026-10-07 Intro"
Error [VALIDATION_FAILED]: "clients/Acme/" doesn't fit clients/{client}: the {client} folder name must look like /[a-z]+-[0-9]{3}/.

$ ctx add nodes/notes/idea --title "Idea"
Error [VALIDATION_FAILED]: "notes/" is not an allowed folder. Allowed: /, clients/{client}, clients/{client}/contracts, clients/{client}/meetings.

$ ctx update nodes/clients/acme-042/meetings/2026-10-07-kickoff --body "## Attendees"
Error [VALIDATION_FAILED]: This edit would remove the required "Decisions" heading from "clients/acme-042/meetings/2026-10-07-kickoff" (meeting-note template). …

$ ctx delete nodes/clients/acme-042/overview --yes
Error [VALIDATION_FAILED]: "overview" is required in "clients/acme-042/" (rule clients/{client}) — delete the folder, or its other documents first.
```

## The three keys

### `structure`

| Key | Meaning |
|---|---|
| `enforce` | `true`: writes that break a rule are refused. `false` or absent: the rules only report, so nothing is refused or scaffolded. Any other value is a configuration error, never read as off. |
| `closed` | `true`: only declared folders (and their parent folders) may exist and hold documents. `false` or absent: undeclared folders are free. |

### `folders`

Each key is a folder path pattern, written without the leading `nodes/`, so the same rules fit structured and flat vaults. `"/"` is the vault root.

- **Literal names** match without regard to case. `Engineering` and `engineering` are the same folder, as they are on macOS and Windows.
- **`{placeholder}` segments** match any folder at that position. A placeholder named after a token (`{yyyy}`) takes that token's format. Any other placeholder takes the `folder_name` of its rule, or any slug if the rule has none.
- **Overlaps:** when two patterns overlap, a literal beats a placeholder at the first segment where they differ. Declaration order does not matter.
- **Limit:** a vault declares at most 256 folder rules.

| Field | Meaning |
|---|---|
| `types` | Node types allowed directly in the folder, such as `[document, snippet]`. `[]` allows none, for a folder that only holds folders. |
| `folder_name` | Format of the folder name that fills a `{placeholder}`. |
| `file_name` | Format of file names in the folder. A file is named after its title, so `{date}-{slug}` means "title it `2026-10-07 Kickoff`". |
| `template` | Name of a template under `templates`. New files here start from its body. |
| `required: true` | A fixed-name subfolder, created with its parent. |
| `files` | Files every matching folder must contain, each with an optional `template` and `type`. They are created as drafts from their templates. |

### `templates`

| Field | Meaning |
|---|---|
| `body` | The text a new file starts from. |
| `required_sections` | Headings a document must keep. A heading counts when its anchor matches (`## Action Items` and `## Action items` both satisfy `Action items`). |

A `template` that names nothing under `templates` is only a label, so older `folders:` blocks keep working. `ctx structure` warns about such labels.

## Name formats

A `folder_name` or `file_name` is either a token pattern or a `/regex/`.

**Token patterns** combine literal characters (`a-z`, `0-9`, `-`) with these tokens:

| Token | Matches |
|---|---|
| `{slug}` | kebab-case, such as `quarterly-review` |
| `{date}` | `YYYY-MM-DD` |
| `{yyyy}` | a four-digit year |
| `{n}` | digits |

A pattern may use at most one `{slug}` and at most three variable-width tokens (`{slug}`, `{n}`), and no two of them may sit side by side. Examples: `{date}-{slug}`, `adr-{n}-{slug}`, `{yyyy}`.

**A `/regex/`** is matched against the whole name and uses a deliberately small grammar, so no pattern can slow a write down:
- literals, `.`, classes `[…]` and `[^…]`, and the escapes `\d \w \s \D \W \S`;
- quantifiers `* + ? {m} {m,} {m,n}` (bounds of at most three digits), only after a single character, escape, class or `.`;
- groups `( … )` and `(?: … )` with `|`, which are never quantified;
- literal `{ } [ ]` written escaped;
- no lookaround and no backreferences;
- at most 200 characters.

Regexes and token patterns run on a linear-time matcher, never on a backtracking regex engine. Names longer than 128 characters never match a format.

## What is checked, and when

With `enforce: true`, every write is checked:

- **Create and add** (`ctx add`, `context_create`, the deprecated `create_document`): folder, type, name and required headings.
- **Update** (`ctx update`, `context_update`): only what the edit newly breaks, either a change to a type the folder does not allow or the removal of a required heading.
- **Delete:** a required file can be deleted only when it is the last document left in its folder.
- **Import** (`ctx import`, `context_import`, `context_import_pdf`, `ctx pull`): each document as its publish will judge it. A refused document takes its version history and PDF sidecar with it.
- **Publish and approval:** a document's first publish is judged in full. A later publish, the approval of a held edit or a drift suggestion, a rollback and a direct edit are judged against the document's last sealed version.

A refusal is a `VALIDATION_FAILED` error naming the rule and the format it expects. Nothing is written.

### Content that predates the rules

Existing content is grandfathered. A document that broke a rule before the rule existed stays readable and editable. It is refused only when an edit newly breaks a rule, for example by dropping a heading it had. The compliance report lists such documents so you can tidy them up at your own pace.

### Scaffolding

When an enforced write brings a folder into existence, the engine also creates the folder's `required` subfolders and its `files`, each a draft started from its template.
- Scaffolding is best effort and never fails the write.
- A write held for review is scaffolded when it is approved.
- Placeholder folders are never created on their own.

## Reading the rules

| Command | Shows |
|---|---|
| `ctx structure` | The rules, readable |
| `ctx structure --json` | The same as JSON, for agents and scripts |
| `ctx structure --folder <path>` | The rule that governs one folder, its required sections and its template |
| `ctx structure --report` | Existing content and folders that break the rules |

The MCP tool `context_structure` returns the same JSON, with `folder` and `report` options. `ctx structure` works on remote nests too (`--vault <server>/<nest>`), with identical JSON. `ctx add` without `--body` starts from the folder's template.

A rule that does not compile, such as an invalid regex or a key of the wrong shape, never stops reads. `ctx structure` reports it as `error`, and in an enforced vault writes are refused with `CONFIG_ERROR` until it is fixed.

The report uses these violation codes:

| Code | Meaning |
|---|---|
| `FOLDER_NOT_ALLOWED` | The folder is not declared (closed rules), or it spells the content root another way, such as `NODES/` |
| `FOLDER_NAME` | A placeholder folder's name does not match its format |
| `TYPE_NOT_ALLOWED` | The node type is not allowed in the folder |
| `FILE_NAME` | The file name does not match `file_name` |
| `MISSING_SECTION` | A required heading is missing |
| `MISSING_FOLDER` | A `required` subfolder is missing |
| `MISSING_FILE` | A required file is missing |

## Changing the rules

Edit `.context/config.yaml` by hand, or call `setStructure()` from the engine, which rewrites only the rule blocks and keeps the rest of the file, its comments and its line endings.

A re-run of `ctx init` keeps the rules, and starter content leaves out anything the rules refuse.

`.context/` cannot be written through `context_import`, so an import can never rewrite the rules or the review gate. Only a trusted host restoring a whole vault, such as Community's bundle restore, may bring `.context/` back. Hosts do that with `OperationContext.structure: "skip"`, which is never available from a tool's input.

## For coding agents

The Claude Code plugin's session start includes a compact summary of the pinned or working-directory vault's rules, taken from `ctx structure --json`. The capture and curator agents check the rules before they write, so notes land in an allowed folder, with an allowed name and the required headings.

## Limits and safeguards

These hold whether or not a vault has rules:

- **Reserved paths:** no write puts a document under `.context/`, `.versions/` or `_suggestions/` at any depth, or under the vault-root `packs/`. Look-alike spellings count as reserved too: case, trailing dots, `:stream` suffixes, ignorable characters and NTFS short names.
- **Id shape:** ids use `/`, never `\`. They stay under 1024 characters, with no name over 251 bytes.
- **Imports:** an import of a vault's own export restores over itself, including its version history, PDFs, forgotten documents and held revisions. An import is checked against what the vault will hold after the call, and a document's history may arrive before or after the document. Within one history, send `history.yaml` last, after the keyframes and diffs it needs.
- **PDF sidecars:** import never replaces a PDF node's file on disk with different bytes. A new version of a PDF comes through `ctx import pdf` or `context_import_pdf`.
- **Work per import:** reading and replaying version histories is bounded per call by `limits.importReplayChars` (default 512 Mi characters, set by the host). Only documents that break a rule are replayed: one that passes the full check needs no history to excuse it. Over the limit, `files[]` are refused with a request to split the call, and a document the publish step could not judge is reported "not published — publish it in a separate call".

## Not covered yet

- **Encrypted vaults:** re-importing an encrypted vault's raw, still-encrypted export over itself is refused under enforced rules. Export through a decrypted copy instead.
- **Community:** the editor and API for these rules in Context Nest Community are planned. Today you set them in `.context/config.yaml`.
