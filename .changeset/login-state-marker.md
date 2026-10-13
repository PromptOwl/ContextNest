---
"@promptowl/contextnest-cli": patch
---

Commands against an HTTP remote registered without auth no longer read the OS keyring on every call when nothing was ever saved by `ctx login`. A non-secret `~/.contextnest/login-state` marker (`none` / `saved`, never the key) records whether any login exists; on Windows this skips the ~1 s PowerShell start per command. If the server still asks for a key, ctx reads the keyring once more, so keys saved by an older ctx are never missed.
