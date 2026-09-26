---
"@promptowl/contextnest-engine": minor
"@promptowl/contextnest-cli": minor
---

Opt-in encrypted vault mode. `ctx init --encrypted` and `ctx vault encrypt` (migrate in place, resumable) store note bodies, keyframes, diffs, suggestion patches, history notes, `context.yaml` and pdf binaries encrypted at rest with AES-256-GCM (Node built-in `crypto`, no new dependencies). `ctx vault decrypt` reverses it. Front matter stays plaintext for indexing. The data key is wrapped by a key held in the CLI's secure credential store (OS keychain, or the encrypted file store; interim 0600 file only when neither is available; `CONTEXTNEST_VAULT_KEY` overrides) and by a one-time recovery passphrase shown at init (`CONTEXTNEST_VAULT_PASSPHRASE` to unlock). `content_hash`/`chain_hash` stay defined over the plaintext, so `ctx verify` gives identical results for an encrypted and a plain copy of the same history. Without the key, verify reports `encrypted_key_required` and never passes. New verify findings: `decryption_failed` (GCM tamper detection) and `unencrypted_file`. Default vaults are unchanged. See docs/encrypted-vaults.md for the threat model.

Also fixes a pre-existing bug where the first version of every new document was annotated "Chain restarted — no readable history.yaml": the restart check counted the keyframe the same call had just written.
