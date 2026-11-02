# REVIEW.md

Instructions for every code review of this repository — the Claude PR review workflow, the managed Claude Code Review, and human reviewers alike.

## Required PR checklist (always blocking)

Check these on **every** PR before reviewing code. Read the PR title, body and branch name (`gh pr view <number> --json title,body,headRefName`). A missing item is a 🔴 **blocking** finding — never a nit, never optional, whoever (or whatever) wrote the PR.

1. **Task.** The PR references the task the work belongs to, either:
   - a **vault task link** in the body — the team's tasks live in the `po-engineering-ops` nest: `Task: https://nest.promptowl.ai/nest/<nest-id>?doc=nodes/projects/<stage>/<task-slug>` (any `nest.promptowl.ai` link to a `nodes/projects/` document counts), or
   - a **ClickUp ticket** in the title, body or branch name: `CU-<id>`, `[CU-<id>]`, `#<id>`, or an `app.clickup.com/t/<id>` link.

   Neither → 🔴 blocking.
2. **Steps to test.** The PR body has a section titled "Steps to test" (or "How to test" / "Testing steps") with numbered steps a tester can follow **from the user's perspective**:
   - where to go or what to run (page, command, API call, starting data),
   - what to do,
   - what they should see when it works (and, for a bug fix, what they saw before).

   🔴 blocking when the section is missing, when it is only "ran unit tests" / "CI passes", or when the steps do not exercise the change in the diff. A PR with no user-facing change (docs, CI, refactor, chore) may say `N/A — no user-facing change` plus one line on why; the reviewer must agree with that claim.

Start the review comment with this block, then the code findings:

```
### PR checklist
- ✅/🔴 Task: <vault task link or ClickUp ticket found, or "missing">
- ✅/🔴 Steps to test: <ok, or what is missing>
```

## Code review focus

- Correctness bugs, security, performance, and missing or weak tests for new behaviour.
- The rules in `CLAUDE.md`. A finding that cites a CLAUDE.md rule is not optional.
- Report problems only; skip praise.

### This repo

- Cross-platform correctness (CI runs ubuntu/windows/macOS): CRLF, path separators, no POSIX-only tools.
- `plugins/claude-code/core/` is a vendored copy — edits belong in `plugins/shared/` followed by `pnpm plugins:sync`.
- MCP tools are registered through the local `tool()` helper, never `server.tool()`; new core tools come from the engine operation catalog.
- Structure-rules, storage and import changes follow the invariants in CLAUDE.md's engine table; new attacks get a test in `structure-adversarial*.test.ts`.
