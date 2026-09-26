---
"@promptowl/contextnest-cli": minor
---

Privacy hardening.

- `.context/welcome.html` no longer loads Google Analytics or Google Fonts unless the vault opted in
  with `telemetry: true` (the existing telemetry flag). Default off for new and existing vaults;
  opted out, the page makes zero network requests. Pages written by older versions keep GA until
  `ctx welcome` regenerates them.
- Telemetry honours `DO_NOT_TRACK=1` and `CONTEXTNEST_TELEMETRY=0`, and reports the real CLI
  version instead of a hard-coded `0.3.0`.
- The PromptOwl cloud token moves from plaintext `~/.promptowl/credentials.json` to the OS keyring
  (macOS `security`, Linux `secret-tool`, Windows Credential Manager via PowerShell; no new
  dependencies, secrets passed over stdin). Without a keyring, `CONTEXTNEST_CREDENTIALS_KEY` enables
  an AES-256-GCM file (`~/.promptowl/credentials.enc.json`, 0600). The plaintext file is migrated
  on first read and securely deleted. **Breaking for headless users with a stored token:** with no
  keyring and no key, `ctx query @org/pack` now errors instead of reading plaintext — set
  `CONTEXTNEST_CREDENTIALS_KEY` or `PROMPTOWL_ACCESS_TOKEN`.
- `ctx doctor` shows a Privacy line (telemetry state, credential store).
