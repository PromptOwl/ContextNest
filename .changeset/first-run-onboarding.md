---
"@promptowl/contextnest-engine": minor
"@promptowl/contextnest-cli": minor
---

**Bare `ctx` sets you up on first run.** The first time `ctx` is run with no arguments in a terminal and no vault exists, a guided setup creates a local vault (`ctx init --starter developer`, registered as `main`), signs in to a team server (`ctx login https://nest.promptowl.ai --as promptowl`), does both, or skips. It never prompts in CI or without a TTY, and existing users are never onboarded. After that, bare `ctx` prints the command list and **exits 0 (was 1)**, with a "No vault yet" line when there is no vault. The engine registry gains optional top-level `onboarded_at` / `skipped_at` markers and a new `markOnboarding()` export; older CLIs ignore the markers.
