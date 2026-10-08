---
description: Capture something from this session into the Context Nest vault on purpose, regardless of the capture_mode setting.
argument-hint: "[what to capture]"
---

# Capture to Context Nest

The plugin's end-of-turn capture is deliberately quiet: it defaults to
proposing rather than writing, and it holds a cooldown so it cannot fire every
turn. This command is the explicit override — the user is asking for a write
right now, so treat that as the decision point the automatic path lacks.

Requested: `$ARGUMENTS`

## What to do

1. Invoke the `contextnest-capture` agent. It is declared `background: true`, so
   it runs alongside whatever the user does next — don't hold them while it works.
2. Tell it that this is an **explicit, user-initiated capture**, so it should
   write rather than propose — the user has already given consent by running
   this command.
3. Scope it: if `$ARGUMENTS` names something specific, capture that and nothing
   else. If `$ARGUMENTS` is empty, let the agent review the recent exchange and
   apply the capture ladder as usual.
4. The ladder still applies even here. If the material is already in the vault,
   the agent extends the existing node instead of creating a duplicate; if it
   cannot be stated as a headline plus a "why it matters" sentence, the agent
   should say so rather than write something shapeless.
5. Relay what was written, one line per node.

If the user is correcting something that is already in the vault rather than
adding something new, use the `contextnest-curator` agent instead — it sweeps
for every node carrying the stale fact rather than writing a second version of
it alongside the first. It is likewise a background agent.

Note the plugin also queues these agents on its own: the `Stop` hook parks a job
instead of blocking the end of a turn, and the next prompt dispatches it. This
command is for when the user wants it now and wants it written.
