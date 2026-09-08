---
paths:
  - "test/**"
  - "modelguild/tests/**"
  - "modelguild/verify-*.sh"
  - ".devcontainer/test-*.sh"
  - ".github/workflows/**"
---

# Testing conventions

Loaded by Claude Code when it touches the test tree, and by opencode on every session through `opencode.json`. The catalogue of what each suite and lint asserts is [docs/testing.md](../../docs/testing.md); the commands to run are in [AGENTS.md § Commands](../../AGENTS.md#commands).

- **Test fixtures are immune to commit signing and need no `git -c commit.gpgsign=false` prefix:** every fixture `git` runs under `fixtureGitEnv()` (`test/harness.ts`), which scrubs identity and disables `commit.gpgsign`/`tag.gpgsign` — a fixture's commit is nobody's signed commit. **Route any new test that shells out to `git` through it** (issue #98): the env form covers child-process gits that `-c` on the argv would miss, and a fixture that signs can hang the suite silently rather than failing.
- **Testing `src/fsguard.ts` has its own trap:** a regression BLOCKS, so an in-process FIFO test cannot go red — it wedges the suite and hands CI a timeout with no signal. Use `runBounded`/`runBoundedProbe` in `test/harness.ts`, and remember a killed child reports `status === null`, so `status !== 0` **accepts** the hang it was written to catch.
- A new `test/*.test.ts` suite is named in `test/run.ts`; one that needs a real `opencode serve` goes in its `OFFLINE_EXCLUDED` list, because CI never spawns opencode. Do not state suite counts in prose (issue #194; [docs/testing.md](../../docs/testing.md)).
- Every lint carries a `--self-test`, and CI runs the lint **plain and then `--self-test`**, because a self-test may short-circuit the repo scan (issue #166). A new lint gets both invocations in both the `shell` and `macos` jobs of `.github/workflows/ci.yml`.
- The `macos` job runs stock bash 3.2 and BSD awk/sed/grep: expand a possibly-empty array as `${arr[@]+"${arr[@]}"}` under `set -u`, and never assume `mktemp` honours `TMPDIR`.
- `test/doctor.test.ts` shadows `PATH` for its whole run with a stub `opencode` and no `claude` (issue #151); vary the environment inside a case, never rely on the host's.
- The `verify-guild-*.sh` and `verify-permission-surface.sh` proofs need a logged-in opencode and run locally after an opencode bump, never in CI; an inconclusive run is reported as such, not as a pass.
