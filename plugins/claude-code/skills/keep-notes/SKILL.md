---
name: keep-notes
description: Keep the user's Context Nest notes current when they ask you to remember or save something, or when they correct a fact their notes may hold. Don't use it for ordinary conversation, and never save anything they didn't ask for.
requirements:
  - Bash
---

The user wants something kept, or has corrected something. Hand it to the right agent and carry on with what they asked next.

- **Something new to remember.** Invoke the `contextnest-capture` agent. Tell it this is an explicit, user-initiated capture, so it should write rather than propose, and say what to capture.
- **A correction.** If the notes may hold the old fact, invoke the `contextnest-curator` agent with the old value and the new one. It finds every note carrying the old fact, so the change doesn't land in only one of them.

Both agents run in the background. When one finishes, tell the user what changed in one line per note.

If `ctx vault list --json` shows no notes yet, offer `/contextnest:setup` instead.
