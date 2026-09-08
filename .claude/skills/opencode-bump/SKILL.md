---
name: opencode-bump
description: Re-verify ModelGuild after an opencode upgrade or a hardened agent-def change. Runs the local proofs (verify-guild-*.sh, verify-permission-surface.sh), re-checks the opencode endpoints src/ depends on, and says what to record. Use when opencode was bumped, `.opencode/agent/*.md` changed, or a verify script reported INCONCLUSIVE or ATTENTION.
---

# After an opencode bump

The dev container tracks opencode `@latest` and CI never runs opencode, so the only proof that a new opencode still enforces the hardened defs is the one you run here. Nothing below calls a paid model; the runtime probes use free models.

1. **Name the version.** `opencode --version`. It goes in the commit message and in any `docs/architecture.md` sentence you touch.
2. **Static proofs first** (no login needed): `bash modelguild/verify-guild-read.sh --static`, `… verify-guild-build.sh --static`, `… verify-guild-research.sh --static`. A failure here is a def or resolution change; stop and read `.claude/rules/agent-defs.md` before editing a def.
3. **Runtime proofs** (need `opencode auth login`): the same three scripts without `--static`. INCONCLUSIVE is not PASS; say so in the report.
4. **The permission-surface pin:** `bash modelguild/verify-permission-surface.sh`. Exit 0 = the v1 pin holds; exit 7 = ATTENTION, revisit issue #93 and the `V1 PIN` block in `src/client.ts` before anything else; exit 6 = INCONCLUSIVE, report it as such.
5. **Endpoints and schemas.** `src/client.ts` and `src/lifecycle.ts` speak `POST /session`, `POST /session/{id}/message`, the message list, `DELETE /session/{id}`, `GET /session/{id}`, `GET /agent`, `GET /config/providers`, `GET /global/health`, `GET /event`, and the v1 permission reply routes. Diff `GET /doc` on the new serve for `AssistantMessage`, `Part` (the `compaction`/`synthetic` markers, `ReasoningPart`), and the permission operations; each extractor's header comment names the shape it depends on.
6. **The full suite:** `npm test` (three suites spawn a real `opencode serve`). Then `bash modelguild/tests/check-agent-permissions.sh --self-test`.
7. **Record it.** A behaviour change is a CONTRACT.md clause plus the module header; a probe result goes in the header of the module that depends on it; `docs/architecture.md` follows. AGENTS.md changes only if what every session needs changed.
