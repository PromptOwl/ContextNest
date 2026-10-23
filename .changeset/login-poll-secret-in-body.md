---
"@promptowl/contextnest-cli": patch
---

`ctx login` now sends the device-login secret in the body of `POST /auth/device/poll` instead of in the URL, so server and proxy access logs can't record it. Against an older Community server without that endpoint (404/405), it falls back to the old GET poll, so login keeps working.
