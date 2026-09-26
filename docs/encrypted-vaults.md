# Encrypted vaults (opt-in)

Vaults are plain Markdown by default, and that default is not changing. An
**encrypted vault** is an opt-in mode for regulated or enterprise deployments:
note content is stored encrypted at rest, and every Context Nest surface (CLI,
MCP server, engine API) keeps working when the key is available.

```bash
ctx init --encrypted            # new vault, encrypted from the first byte
ctx vault encrypt               # migrate an existing vault in place (resumable)
ctx vault decrypt               # back to plain Markdown
```

> **Losing the key means losing the data.** At `init --encrypted` /
> `vault encrypt` the CLI prints a **recovery passphrase once**. If this
> machine's key store is lost and you do not have that passphrase, the content
> is gone: nobody can recover it, PromptOwl included. Write it down and keep it
> offline.

## What is encrypted

| On disk | Encrypted? | Notes |
|---|---|---|
| Document body (`nodes/**/*.md`) | **Yes** | The whole original file is sealed; a plaintext copy of its front matter sits above the ciphertext |
| Document front matter | **No** (by design) | Kept plaintext so titles, tags, type and status stay indexable and visible to tools without the key. Bound into the ciphertext's authentication tag |
| `.versions/<doc>/vN.md` keyframes | **Yes** | Whole file, front matter included |
| `.versions/<doc>/vN.diff` change logs | **Yes** | |
| `history.yaml` `note` / legacy inline `diff` | **Yes** | Field-level |
| `history.yaml` hashes, authors, timestamps, `client` | No | Needed to check chain linkage without the key |
| `_suggestions/**` patches and meta | **Yes** | They carry body diffs |
| `context.yaml` | **Yes** | Its edge list is derived from links inside bodies |
| pdf sidecars and archived binaries | **Yes** | |
| `INDEX.md`, `CLAUDE.md` / agent configs | No | Built from front matter only (already plaintext) |
| `.context/config.yaml`, `CONTEXT.md`, packs, `context_history.yaml`, `chain_events.yaml` | No | Configuration and hashes; do not put secrets in the vault name or CONTEXT.md |
| File and folder names (document ids) | No | Choose non-sensitive slugs |

Search and indexing decrypt **in memory only**. The engine writes no plaintext
body, index or cache to disk. One CLI convenience was changed to hold that line:
`ctx read --html` in an encrypted vault needs an explicit `--out <file>` rather
than silently dropping a decrypted render under `.context/`.

### Why front matter stays plaintext

Encrypting everything except what indexing strictly needs was the goal. v1
keeps the whole front matter plaintext, which trades metadata leakage (titles,
tags, descriptions, and a `checksum` that lets someone who already has a
candidate plaintext confirm a match) for simple, inspectable files and indexing
that tools outside the engine can use. The plaintext copy is authenticated as
AES-GCM additional data, so hand-editing it makes the document fail to open
with a clear error instead of silently diverging from the sealed original.
Edit documents with `ctx` (or the MCP tools), not in a text editor. A mode that
also encrypts front matter is a follow-up.

## Integrity semantics

`content_hash`, `chain_hash` and `checksum` stay defined over the **normalized
plaintext**, exactly as in a plain vault. With the key, `ctx verify` on an
encrypted vault and on a plain copy of the same history gives identical results.
The test suite asserts this.

Without the key, `ctx verify` reports `encrypted_key_required` ("encrypted, key
required") and exits non-zero. It still checks `chain_hash` linkage and the
checkpoint chain, but it **never passes**. A wrong key reports the same finding
with "key rejected".

Encryption adds three findings:

- `decryption_failed`: a sealed artifact failed AES-GCM authentication, meaning
  it was tampered with or sealed under a key this vault does not hold.
- `unencrypted_file`: a content file inside an encrypted vault is plaintext,
  for example one dropped in by an editor or left by an interrupted migration.
  Reads still work, and the next engine write seals it.
- `encrypted_key_required`: see above.

## Keys

```
KEK  (key-encryption key)   OS key store, or CONTEXTNEST_VAULT_KEY. Never inside the vault.
 └─ DEK (data key)          .context/encryption.yaml, stored twice:
                              wrapped by the KEK            (normal unlock)
                              wrapped by scrypt(passphrase) (recovery)
```

- **Cipher:** AES-256-GCM through Node's built-in `crypto`, with a fresh 96-bit
  IV per seal and a 128-bit tag. There are no third-party crypto dependencies.
  Each ciphertext binds its *kind* (doc, keyframe, diff, and so on) and the id
  of the key that sealed it into the tag, so a keyframe cannot be replayed into
  a diff slot. Paths are not bound, so moving a folder keeps working, and
  swapping one version's ciphertext for another's is caught by the hash chain.
- **Recovery passphrase:** 120 random bits in Crockford base32
  (`XXXX-XXXX-XXXX-XXXX-XXXX-XXXX`), stretched with scrypt (N=2^17, r=8, p=1).
- **Unlock order:** `CONTEXTNEST_VAULT_KEY` (base64 32-byte KEK, for CI,
  containers and headless MCP) → the key store → `CONTEXTNEST_VAULT_PASSPHRASE`
  (the recovery passphrase).
- **Key store:** the engine codes against a small `VaultKeyStore` interface.
  The OS-keychain credential store (separate work) registers itself through
  `setDefaultVaultKeyStore()`. **Until it lands, the default is an interim
  0600 file under `~/.contextnest/keys/`.** That protects a vault folder that
  leaves the machine, but not a stolen disk, and the CLI says so when it
  creates the key.

Stop long-running MCP servers and agents before `vault encrypt` / `decrypt`.
A running engine does re-check `.context/encryption.yaml` every second, but a
migration is not the moment to race it.

### Migration guarantees

`vault encrypt` and `vault decrypt` run under the vault write lock. The key is
stored before the first byte is sealed. Each file is replaced atomically
(temp file, fsync, rename). Reads tolerate a half-migrated vault, and rerunning
either command finishes an interrupted run. This is not a single multi-file
transaction, so **take a backup (copy the folder) first**; the CLI asks you to.
Migration does not securely erase the old plaintext blocks on disk, and it does
not reach copies that already left the machine (sync history, backups, git).

## Push and hosted nests

`ctx push` reads documents through the engine, so an encrypted vault pushes
**decrypted** content over TLS to the hosted nest. It still shows the per-document
confirmation it always has. A hosted nest is not end-to-end encrypted, so do not
push a vault whose content must never leave the machine. Requiring an explicit
`--decrypt-for-push` opt-in is a follow-up.

## Threat model

**Protects against:**

- A lost laptop or stolen disk, once the KEK lives in the OS keychain. With the
  interim file store, this only holds if the home directory is also protected,
  for example by full-disk encryption.
- Exposure of the vault folder itself: a synced folder (Dropbox, iCloud, OneDrive),
  a shared drive, a copied backup, or a repo accidentally pushed.
- Silent tampering with sealed content. GCM authentication fails loudly, and the
  hash chain still catches substitution of whole versions.

**Does not protect against:**

- Malware or another user **in your running session**. Anything that can run as
  you can ask the key store for the key, or read decrypted content from the
  engine's memory.
- Metadata: front matter, file names, folder structure, sizes, timestamps,
  version counts, authors and hashes are all visible.
- Content you have already exported: `ctx read --raw`, `--html --out`, `push`,
  or agent transcripts.
- Losing both the key and the recovery passphrase. That is data loss by design.

## Follow-ups (not in v1)

- `ctx vault rotate-key` (re-wrap the DEK under a new KEK, or re-encrypt under
  a new DEK), plus export and import of a wrapped-key backup.
- Front-matter encryption mode (a minimal plaintext projection, or none at all).
- **Crypto-shred for the forget protocol:** per-document (or per-version) keys
  wrapped by the DEK. Forgetting destroys the document's key, which makes every
  surviving copy of its ciphertext unrecoverable, and a DEK rotation afterwards
  makes a forensically recovered key file useless too. The envelope already
  records a key id per ciphertext, and storage routes every seal through a
  per-document seam (`sealText(docId, …)`), so this needs no format change.
- Push: an explicit `--decrypt-for-push` opt-in, and optionally end-to-end
  encrypted hosted nests.
- Wire the OS-keychain credential store in as the default key store.
