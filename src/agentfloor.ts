/**
 * agentfloor.ts — ASK OPENCODE WHAT IT ACTUALLY RESOLVED, AND REFUSE IF THE FLOOR IS GONE
 * (issue #111, maintainer decision 2026-07-29; CONTRACT.md C73).
 *
 * THE DEFECT. A hardened agent def whose frontmatter opencode cannot parse has NONE of that
 * frontmatter applied — not a partial application, not a warning, not a non-zero exit. The
 * permission map is absent entirely, so the agent resolves on opencode's built-in `"*": allow`
 * with no default-deny floor at all, while the file on disk still reads as hardened. Probed on
 * opencode 1.18.7 (2026-07-29, live `opencode serve` + `GET /agent`, corroborated by
 * `opencode agent list`) against the real `guild-read.md`:
 *
 *   control      -> [ …builtins…, '*:*:deny', 'read:*:allow', 'grep:*:allow', 'glob:*:allow',
 *                     'webfetch:*:allow', 'websearch:*:allow', … ]   (19 entries)
 *   dup-nested   -> [ …builtins… ]                                    (13 entries, NO '*:deny')
 *   tab-indented -> [ …builtins… ]                                    (13 entries, NO '*:deny')
 *
 * `mode` came back `all` in every case (opencode's own default), so a `mode` reading of `all`
 * proves nothing; `description` came back `null` on the voided defs, which is a symptom rather
 * than a test. The two shapes probed — a duplicate key at any depth, and tab indentation — are
 * the instances currently known and are explicitly NOT a closed list: the condition is the
 * parse, so a third shape that breaks it behaves the same way.
 *
 * WHY A RESOLVED-CONFIG CHECK RATHER THAN PARSING THE DEF OURSELVES (maintainer's decision).
 * Issue #100 hardened the CI lint, which reads the SOURCE. That guards this repository's defs
 * and nothing else: a user's installed def is never linted, and `init`'s never-clobber rule
 * means a user-edited (or merge-mangled) def stays exactly as edited. Detecting the known bad
 * shapes in our own parser would approximate opencode's parser and would only ever catch the
 * instances we can currently name. Asking opencode what it resolved is AUTHORITATIVE — it
 * catches any future change in how opencode parses, including shapes nobody has seen.
 *
 * HOW THE FLOOR IS TESTED — AN EFFECTIVE ACTION, NEVER A PRESENCE TEST. `#100` is a lesson
 * about presence tests: `mode: all` was asserted by presence, so `mode: all` followed by
 * `mode: subagent` passed. So this does NOT look for "an entry with permission `*` and action
 * `deny`". It computes the action opencode would resolve — LAST MATCH WINS over the rules that
 * can answer for an arbitrary tool — for a probe tool NO hardened def grants, and requires
 * `deny`. That also catches a later `"*": allow` re-opening everything, which a presence test
 * would miss. `modelguild/tests/check-agent-permissions.sh`'s `effective()` is the reference
 * for the semantics, and the probe name is deliberately the SAME literal it uses, so the
 * source-level lint and the runtime check are visibly asking one question.
 *
 * WHY A SENTINEL PROBE NAME RATHER THAN A REAL DENIED TOOL (Claude's call — second-guess it
 * here if anywhere). `task` is denied by all three shipped defs and would work today. But a
 * user who legitimately re-scopes their own def to allow `task` would then be REFUSED by a
 * check that has nothing to say about their floor — a false refusal on a def that parses and
 * does carry a floor. A name that is not a tool at all can never be legitimately granted, so
 * the probe asks exactly one question and only that question: *what does this agent resolve
 * for something it was never given?* Nothing here asks opencode to evaluate the name — the
 * rules are fetched as data and resolved in this file — so the sentinel involves no opencode
 * behaviour and cannot be special-cased by it.
 *
 * THE SENTINEL HAS ITS OWN FALSE-REFUSAL CLASS, and it is not the `task` one (review R6,
 * 2026-07-30): a def written as a DENYLIST — every unwanted tool denied by name, with no `"*"`
 * rule at all — resolves nothing for the sentinel, so `effectiveAction` returns `undefined` and
 * this refuses as "nothing matched". That is a def opencode applies perfectly well, refused for
 * having no floor. It is the intended direction, because the floor is the design (AGENTS.md's
 * "prefer an allowlist floor over a denylist for any versioned tool surface", reached the hard
 * way) and a denylist genuinely does leave every future opencode tool allowed — but it is a
 * refusal of a working configuration, so it is named here rather than left for someone to
 * discover from the message.
 *
 * THIS IS NOT A NEW FENCE. It verifies that the fence the def already declares is in force.
 * PARITY (AGENTS.md): you would want the same before running an Anthropic subagent under a
 * restricted tool set — "the restriction I configured is actually applied" is not a
 * restriction, it is the absence of a silent failure. Provenance: the defect came from
 * adversarial review of the #100 fix; the decision to verify-and-refuse is the MAINTAINER's
 * (Ben, 2026-07-29); the effective-action test, the sentinel probe, the caching shape and the
 * cannot-ask direction are Claude's.
 *
 * COST, STATED — and it was understated in the first cut (review R5, measured 2026-07-30).
 *   - Control-plane `GET /agent`s per call: **ONE** on the shared child once the verdict is
 *     `verified` (the pre-turn check is then a cache hit, and a 3-model panel still pays one).
 *     **TWO** whenever the verdict is NOT `verified` — the entry is deleted, so the pre-turn path
 *     recomputes — and **TWO under `GUILD_SERVE_PER_CALL=1`** whatever the verdict, because the
 *     serving child is a different instance and therefore a different key. The first cut of this
 *     list said "one per call" flatly; it is one only in the common case (review B6).
 *   - `ServeProvider.withServe` entries go **1 → 2** on a fresh consult. On the shared long-lived
 *     child that is nearly free (ensure-running, in-flight accounting, an idle-timer re-arm).
 *     **Under `GUILD_SERVE_PER_CALL=1` it is not**: each entry is a full spawn + readiness poll +
 *     teardown, so this roughly DOUBLES the startup cost of a call against the ~30s readiness
 *     ceiling `src/lifecycle.ts` documents.
 *   - **And in that mode the child that is CHECKED is not the child that runs the turn.** The
 *     verdict still transfers in practice — the second child is spawned at the same cwd from the
 *     same files, so it resolves identically — but it is a fresh resolution, not the one this
 *     check observed. Nothing here may claim the checked child is the serving child.
 *   - A new refusal that stops work when the def in force is not the hardened one, and a first
 *     touch of opencode that now precedes the approval pre-flight rather than only the turn.
 */

import {
  listAgents,
  type PreTurnAgentCheck,
  type ResolvedAgent,
  type ServeProvider,
} from "./client.js";
import { type ServeHandle } from "./lifecycle.js";

/**
 * The probe tool. Deliberately byte-identical to the one
 * `modelguild/tests/check-agent-permissions.sh` uses, so `grep -r __floor_probe__` finds both
 * halves of the same invariant — the source-level lint on this repo's defs and the runtime
 * check on whatever def is actually in force.
 */
export const FLOOR_PROBE = "__floor_probe__";

/** One resolved permission rule, normalized from `GET /agent`'s array. */
export interface ResolvedRule {
  /** The tool name the rule is about, or `*` for the catch-all. */
  permission: string;
  /** The argument glob the rule applies to. `*` = every invocation. */
  pattern: string;
  /** `allow` | `deny` | `ask` — kept as a string; unknown actions are data, not a crash. */
  action: string;
}

/**
 * Normalize `GET /agent`'s `permission` field, or say why it could not be read.
 *
 * STRICT ON PURPOSE, and the strictness runs toward "I cannot tell", never toward a verdict:
 * ONE entry this function does not understand fails the WHOLE array rather than being dropped.
 * Dropping it would mean computing last-match-wins over a list we only partly understand — and
 * the entry dropped could be the floor itself. An array we cannot fully read is reported as
 * unreadable, and the caller surfaces that instead of claiming either outcome.
 */
export function parseResolvedPermissions(
  value: unknown,
): { ok: true; rules: ResolvedRule[] } | { ok: false; reason: string } {
  if (!Array.isArray(value)) {
    return {
      ok: false,
      reason: `the resolved 'permission' field is ${value === undefined ? "absent" : `not an array (got ${typeof value})`}`,
    };
  }
  const rules: ResolvedRule[] = [];
  for (let i = 0; i < value.length; i++) {
    const e = value[i] as unknown;
    if (typeof e !== "object" || e === null || Array.isArray(e)) {
      return { ok: false, reason: `resolved permission rule #${i} is not an object` };
    }
    const rec = e as Record<string, unknown>;
    if (typeof rec.permission !== "string" || typeof rec.action !== "string") {
      return {
        ok: false,
        reason: `resolved permission rule #${i} has no string 'permission'/'action' pair`,
      };
    }
    // A MISSING PATTERN IS UNREADABLE, NOT A UNIVERSAL ONE (review, 2026-07-29). The first
    // cut coerced it to `"*"`, which was this parser's ONE place where the strictness ran
    // toward ACCEPTING — and it accepted in the dangerous direction, since a patternless rule
    // read as `"*"` is read as a FLOOR. Every entry on 1.18.7 carries `pattern`, so nothing
    // reachable today changes; a future shape that drops it now reads as "I cannot tell"
    // (proceed, and say so) rather than as a floor nobody verified.
    if (typeof rec.pattern !== "string") {
      return {
        ok: false,
        reason:
          `resolved permission rule #${i} has no string 'pattern' — refusing to read a ` +
          `patternless rule as the universal one`,
      };
    }
    rules.push({ permission: rec.permission, pattern: rec.pattern, action: rec.action });
  }
  return { ok: true, rules };
}

/**
 * The action opencode resolves for `tool`, LAST MATCH WINS — the same rule the agent defs are
 * written against and the same one `check-agent-permissions.sh` computes.
 *
 * A rule answers for `tool` when its `permission` is that tool or the catch-all `*`, AND its
 * `pattern` is the general `*`. THE PATTERN CONDITION IS AN ADDITION over the source-level
 * lint (whose input has no patterns) and it is the conservative direction: a rule scoped to a
 * narrow argument glob — opencode ships `read:*.env:ask`, for instance — cannot decide what
 * happens for an arbitrary invocation, so counting it would let a narrow rule masquerade as a
 * floor. The cost of that choice is stated where it bites: an opencode that one day expressed
 * the catch-all with a non-`*` pattern would read here as "no floor" and REFUSE. That is loud
 * and fixable; the opposite error is a silent pass.
 *
 * Returns `undefined` when nothing matched at all.
 */
export function effectiveAction(
  rules: readonly ResolvedRule[],
  tool: string,
): string | undefined {
  let action: string | undefined;
  for (const r of rules) {
    if (r.pattern !== "*") continue;
    if (r.permission === tool || r.permission === "*") action = r.action;
  }
  return action;
}

export type AgentFloorVerdict =
  /** opencode answered and the default-deny floor is in force. Proceed. */
  | { state: "verified"; agent: string }
  /** opencode answered and the floor is NOT in force. Refuse, naming what was resolved. */
  | { state: "unhardened"; agent: string; message: string }
  /**
   * opencode could not be asked, or answered in a shape this cannot read. PROCEED — and say
   * so. See `AgentFloorChecker` for the argument.
   */
  | { state: "unverified"; agent: string; note: string };

/** The cache key: the child INSTANCE first, then the URL, then the agent. One definition, so
 * the two entry points cannot key differently — see `AgentFloorChecker` for why the instance id
 * is the load-bearing component and the URL only belt-and-braces. */
function cacheKey(handle: ServeHandle, agent: string): string {
  return `${handle.instanceId}|${handle.baseUrl}|${agent}`;
}

/** Render the rules that can answer for the probe, compactly, for a refusal message. */
function renderCatchAll(rules: readonly ResolvedRule[]): string {
  const general = rules.filter((r) => r.permission === "*" && r.pattern === "*");
  if (general.length === 0) return "(no general '*' rule at all)";
  return general.map((r) => `"*": ${r.action}`).join(" → ");
}

export interface AgentFloorCheckerOpts {
  /** Test seam for the control-plane read; defaults to the real `GET /agent`. */
  list?: (baseUrl: string) => Promise<ResolvedAgent[]>;
  /** Where an "unverified" note is announced. Defaults to `console.error` (stderr — never
   * stdout, which is the MCP transport). */
  warn?: (line: string) => void;
}

/**
 * The check, with a cache that retains ONE verdict and keys it on ONE thing. Both halves were
 * wrong in the first cut and both were found by review (2026-07-29); they are recorded here
 * because either mistake makes this feature quietly stop working.
 *
 * WHAT IS CACHED: `verified`, AND NOTHING ELSE.
 * The first cut cached whatever came back, forever, with no TTL and no invalidation. That
 * turned both failure verdicts into permanent states of the process:
 *   - one transient `GET /agent` failure DISABLED VERIFICATION for that child+agent for the
 *     rest of the process — and because the stderr warning is emitted once per cached
 *     computation, every later call then proceeded unverified AND silent, defeating the
 *     "never silently" rule that warning exists for and making the description of cannot-ask
 *     as a *transient* condition false, since the cache is what made it stick;
 *   - and a user who FIXED their def stayed refused on every call until the MCP server was
 *     restarted. A correct def being permanently rejected is a worse failure than the extra
 *     GET that avoids it.
 * So a non-`verified` verdict is dropped and re-computed on the next call. The cost is one
 * control-plane GET per call while something is actually wrong — the state where the extra
 * check is wanted anyway — and the warning then repeats per call, which is the correct
 * behaviour for "never silently", not a regression. The drop happens BEFORE the promise
 * resolves, so no awaiter can observe a settled failure verdict still sitting in the map.
 *
 * WHAT IT IS KEYED ON: THE CHILD INSTANCE (`ServeHandle.instanceId`), NOT THE URL.
 * Since issue #96 there can be more than one `opencode serve` child (one per read/write root,
 * `ServePool`), and opencode resolves agents from the SERVE'S CWD — probed: a serve rooted at
 * a worktree of a repo whose main checkout holds `guild-read.md` does not list that agent at
 * all. So "is `guild-read` hardened?" is a per-child question, and the same agent name is
 * legitimately hardened at one root and voided at another. The first cut keyed on `baseUrl`
 * and called that per-child. **A base URL is a reusable loopback port, not an identity.**
 * `src/lifecycle.ts` negotiates the port by bind-and-close without reserving it, children are
 * retired by the idle timer and by `GUILD_SERVE_PER_CALL=1`, and this cache is never cleared
 * when one dies — so a LATER child, at a DIFFERENT root with a different def, can bind the
 * same port and inherit the earlier child's verdict. `instanceId` is a per-process monotonic
 * counter minted per spawn: two handles carry it iff they are the same child, so a dead
 * child's answer cannot be inherited. `pid` was the cheaper option and was rejected — pids
 * wrap too, so it would narrow the window rather than close it, and it still names no
 * lifecycle. The URL stays in the key as a second component, which can only ever make the key
 * STRICTER (an extra component causes a miss, never a stale hit).
 *
 * WHY RETAINING `verified` PER CHILD IS CORRECT BY CONSTRUCTION, and not merely cheap.
 * An earlier draft of this comment said opencode "re-reads agent defs", and offered the
 * retention as an accepted risk. **That is FALSE, and it was refuted by probe** (1.18.7,
 * 2026-07-30, reproduced independently by two reviewers and again here). A running serve child
 * NEVER re-reads a def:
 *
 *     hardened def, fresh serve      : rules=19  effective(probe)=deny
 *     same child, def VOIDED on disk : rules=19  effective(probe)=deny   (unchanged)
 *     fresh serve, same voided file  : rules=13  no floor
 *
 * And **enforcement does not re-read either — which is the half that matters.** With a serve
 * started on a `bash: allow` def and a `bash: deny` def swapped in on disk under the same agent
 * name, `GET /agent` still reported `bash:*:allow` and a real model turn ACTUALLY RAN bash
 * (`['bash','completed','MARKER-BASH-RAN\n']`). So the check and the enforcement read the SAME
 * config, fixed at spawn. There is therefore no state in which this reports `deny` while the
 * child enforces `allow`: for a given child instance the answer cannot change, so caching it is
 * a proof, not a risk. That is exactly why the key had to become the child INSTANCE — the
 * guarantee is scoped to one child and to nothing wider.
 *
 * THE COST LANDS SOMEWHERE ELSE, AND IT IS REAL: RECOVERY. Because the child does not re-read,
 * a user who does precisely what an `unhardened` refusal tells them — fix the def, re-run
 * `init` — **stays refused**, since the stale child is still serving the old config (probed
 * end-to-end: voided ⇒ refused, fixed ⇒ refused, retried ⇒ refused). Worse,
 * `OpencodeLifecycle.withServe` re-arms the idle timer on every entry, so retrying inside
 * `GUILD_SERVE_IDLE_MS` (default 600s) keeps the stale child alive indefinitely. `remedy()`
 * therefore names getting a FRESH CHILD, and says why. Killing the child from here on an
 * `unhardened` verdict was considered and NOT done: that is the #96 finding-H1 shape (tearing
 * down a child that may have other calls in flight) and is a separate decision.
 *
 * The cached value is the PROMISE, so a panel's concurrent members share one in-flight request
 * rather than racing three identical ones — including on the failure path, where the re-check
 * is therefore per CALL, not per member.
 *
 * "NOTHING THROWS" IS SCOPED, AND THE SCOPE MATTERS (review A5, 2026-07-30 — the unqualified
 * claim was false). No VERDICT failure becomes a call failure: an unreachable serve, a non-2xx, a
 * body this cannot read all become `unverified`, which is C31's posture applied to a verification
 * path. What is NOT guarded is **acquiring the serve lease**: `verify` calls `serve.withServe`,
 * and that throws when the child cannot be started at all (`spawn opencode ENOENT`, a readiness
 * timeout, port-race exhaustion) — reproduced. `gateAgentFloor` does not catch it either, so it
 * propagates out of the tool. That is left as-is deliberately rather than wrapped: it happens
 * BEFORE `log.newRun()`, so it leaves no orphaned `expected-call`, and a serve that cannot start
 * is going to fail the turn a moment later anyway — converting it into `unverified` would report
 * "could not check, proceeding" about a call that cannot proceed.
 *
 * NOTHING IS EVER EVICTED, AND THAT IS A COST (review A6, 2026-07-30). Only `verified` entries
 * are retained, and they are retained for the life of the process — there is no eviction on child
 * shutdown even though `OpencodeLifecycle.onShutdown` exists. On the shared child that is a
 * handful of entries forever. Under `GUILD_SERVE_PER_CALL=1` **every call brings a new child and
 * therefore new keys that can never be hit again** — two CACHE entries for every call, one per
 * lease, since the early gate and the pre-turn check see different instances — so the map grows without bound on a
 * long-lived server (two short string keys and two settled promises per call: slow, but
 * unbounded).
 * Stated as a cost rather than fixed: eviction means this module subscribing to lifecycle events,
 * which is machinery the invariant does not need, and the bound is small enough that naming it is
 * the honest trade. If a deployment ever cares, `onShutdown` is the hook.
 */
export class AgentFloorChecker {
  readonly #cache = new Map<string, Promise<AgentFloorVerdict>>();
  readonly #list: (baseUrl: string) => Promise<ResolvedAgent[]>;
  readonly #warn: (line: string) => void;

  constructor(opts: AgentFloorCheckerOpts = {}) {
    this.#list = opts.list ?? ((baseUrl) => listAgents({ baseUrl }));
    this.#warn = opts.warn ?? ((line) => console.error(line));
  }

  /**
   * ANNOUNCING IS THE CALLER'S DECISION, NOT THE CACHED COMPUTATION'S (review B1, 2026-07-30).
   *
   * The first cut passed an `announce` flag into `#run`, so the decision was baked into the
   * PROMISE. Two failures came out of that, both reproduced:
   *   - the pre-turn path suppressed the note to avoid an in-call duplicate, which is correct
   *     only while the two verdicts AGREE. When the early gate said `verified` and the serving
   *     child said `unverified`, the turn ran on a never-verified child with **nothing on any
   *     channel** — no stderr line and no `agentUnverified`. That is C73's "proceed and SAY SO"
   *     broken for precisely the child A3 exists to talk about;
   *   - and a *different concurrent call's* early gate — whose whole job is the unconditional
   *     line — could join a pre-turn-created in-flight promise and emit nothing, which made
   *     "a stderr line cannot be un-written" false for a window of one `GET /agent`.
   *
   * So `#run` never warns. Each entry point awaits the (possibly shared) promise and then decides
   * for itself, against an `announced` set the CALLER owns. Dedupe is therefore keyed on the CACHE
   * KEY — i.e. on the child instance — within one call: the same child seen twice in one call warns
   * once, a *different* serving child warns again, and the next call brings a fresh set so the note
   * still repeats per call exactly as C1 requires. A joiner announces on its own terms regardless
   * of who created the promise.
   */
  #announce(verdict: AgentFloorVerdict, key: string, announced?: Set<string>): void {
    if (verdict.state !== "unverified") return;
    if (announced !== undefined) {
      if (announced.has(key)) return;
      announced.add(key);
    }
    // The maintainer's constraint on the cannot-ask direction: proceed, but NEVER silently. The
    // structured `agentUnverified` can be ignored by a driver; a stderr line cannot be un-written.
    this.#warn(`modelguild: ${verdict.note}`);
  }

  /**
   * Verify the floor for `agent` on the child `serve` provides — taking a lease of this method's
   * own. `agentDefDirs` is used only to make a refusal actionable (it names the files to go and
   * look at); it is never read. `announced` scopes the stderr dedupe to one call (see `#announce`).
   */
  verify(
    serve: ServeProvider,
    agent: string,
    agentDefDirs: readonly string[] = [],
    opts: { announced?: Set<string> } = {},
  ): Promise<AgentFloorVerdict> {
    return serve.withServe((h) => this.verifyHandle(h, agent, agentDefDirs, opts));
  }

  /**
   * Verify against an ALREADY-HELD handle (issue #111, review A3).
   *
   * `verify` takes its own lease; this takes the caller's. It is what `preTurnCheck` uses from
   * inside `askViaAgent`'s lease, so the child inspected is provably the child that serves the
   * turn. Same cache, so on the shared long-lived child the pre-turn call is a hit and costs
   * nothing; under `GUILD_SERVE_PER_CALL=1` the handle is a different child with a different
   * `instanceId`, so it is a real check — which is exactly the gap A3 closes.
   */
  async verifyHandle(
    handle: ServeHandle,
    agent: string,
    agentDefDirs: readonly string[] = [],
    opts: { announced?: Set<string> } = {},
  ): Promise<AgentFloorVerdict> {
    const key = cacheKey(handle, agent);
    const hit = this.#cache.get(key);
    if (hit !== undefined) {
      const verdict = await hit;
      // A HIT IS ANNOUNCED TOO when it is not `verified`. Only `verified` verdicts are retained,
      // so the only way to hit a non-verified one is to join an in-flight promise — exactly the
      // concurrent case B1's secondary manifestation is about.
      this.#announce(verdict, key, opts.announced);
      return verdict;
    }
    const pending = this.#run(key, handle.baseUrl, agent, agentDefDirs);
    this.#cache.set(key, pending);
    const verdict = await pending;
    this.#announce(verdict, key, opts.announced);
    return verdict;
  }

  /**
   * A `PreTurnAgentCheck` bound to one agent and def-dir set — the seam `askViaAgent` calls
   * inside its own lease.
   *
   * **Only an `unhardened` verdict stops the turn**: `unverified` must not, because turning
   * "I could not ask" into a mid-turn abort would reverse C73's decided direction from inside the
   * transport. But an `unverified` verdict HERE must still reach the caller's result, because the
   * early gate may have said `verified` about a different child — that is what `onUnverified` is
   * for, and without it B1's silent case comes straight back.
   */
  preTurnCheck(
    agent: string,
    agentDefDirs: readonly string[],
    opts: { announced?: Set<string>; onUnverified?: (note: string) => void } = {},
  ): PreTurnAgentCheck {
    return {
      verify: async (handle) => {
        const verdict = await this.verifyHandle(handle, agent, agentDefDirs, {
          ...(opts.announced !== undefined ? { announced: opts.announced } : {}),
        });
        if (verdict.state === "unverified" && opts.onUnverified !== undefined) {
          opts.onUnverified(verdict.note);
        }
        return verdict.state === "unhardened"
          ? { ok: false, message: verdict.message }
          : { ok: true };
      },
    };
  }

  /**
   * The cached computation, shared by `verify` and `verifyHandle` so the two entry points cannot
   * drift on the retention rule.
   *
   * The entry is installed by the caller immediately after this returns, which is BEFORE the
   * first await inside `#compute` completes — so concurrent panel members share one request. A
   * non-`verified` verdict is dropped BEFORE this promise resolves, so nobody can await it and
   * then still find the failure cached.
   */
  #run(
    key: string,
    baseUrl: string,
    agent: string,
    agentDefDirs: readonly string[],
  ): Promise<AgentFloorVerdict> {
    return (async (): Promise<AgentFloorVerdict> => {
      try {
        const verdict = await this.#compute(baseUrl, agent, agentDefDirs);
        if (verdict.state !== "verified") this.#cache.delete(key);
        return verdict;
      } catch (err) {
        // `#compute` is guarded and does not throw; this is the belt-and-braces arm, and it
        // must still not throw INTO the call (C31) — an unexpected failure is "cannot tell".
        this.#cache.delete(key);
        const reason = err instanceof Error ? err.message : String(err);
        const verdict: AgentFloorVerdict = {
          state: "unverified",
          agent,
          note: unverifiedNote(agent, reason),
        };
        return verdict;
      }
    })();
  }

  async #compute(
    baseUrl: string,
    agent: string,
    agentDefDirs: readonly string[],
  ): Promise<AgentFloorVerdict> {
    // No warning here: announcing is the ENTRY POINT's job, against the caller's `announced` set.
    // Emitting from inside the cached computation is what made a shared promise decide another
    // call's stderr (review B1).
    return this.#classify(baseUrl, agent, agentDefDirs);
  }

  async #classify(
    baseUrl: string,
    agent: string,
    agentDefDirs: readonly string[],
  ): Promise<AgentFloorVerdict> {
    let agents: ResolvedAgent[];
    try {
      agents = await this.#list(baseUrl);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return { state: "unverified", agent, note: unverifiedNote(agent, reason) };
    }

    const found = agents.find((a) => a.name === agent);
    if (found === undefined) {
      const names = agents
        .map((a) => (typeof a.name === "string" ? a.name : "(unnamed)"))
        .join(", ");
      return {
        state: "unhardened",
        agent,
        message:
          `opencode did not resolve any agent named '${agent}'. Its def file was found on ` +
          `disk (the presence pre-check passed), so opencode is not applying that file: a def ` +
          `whose frontmatter opencode cannot parse, or one that is not where this serve child ` +
          `looks, resolves to nothing at all. Refusing up front rather than sending a message ` +
          `naming an agent opencode will answer HTTP 500 about mid-turn. ` +
          `opencode resolved: ${names || "(no agents at all)"}. ` +
          `${remedy(agent, agentDefDirs)}`,
      };
    }

    const parsed = parseResolvedPermissions(found.permission);
    if (!parsed.ok) {
      return { state: "unverified", agent, note: unverifiedNote(agent, parsed.reason) };
    }

    const action = effectiveAction(parsed.rules, FLOOR_PROBE);
    if (action === "deny") return { state: "verified", agent };

    return {
      state: "unhardened",
      agent,
      message:
        `The '${agent}' agent is NOT resolving with its default-deny floor. A tool the def ` +
        `never grants resolves to '${action ?? "(nothing matched)"}', not 'deny' ` +
        `(probe '${FLOOR_PROBE}', resolved last-match-wins over opencode's own answer for this ` +
        `agent; general catch-all rules in force: ${renderCatchAll(parsed.rules)}). ` +
        `Refusing to run: the def file on disk is not what is in force, so every tool this ` +
        `role denies — shell, edit, write, task, and anything a future opencode adds — is ` +
        `actually permitted, while the file still reads as hardened. ` +
        `THE USUAL CAUSE IS FRONTMATTER OPENCODE CANNOT PARSE, which is applied in NO part ` +
        `(probed on opencode 1.18.7): a duplicate YAML key at any depth — 'mode', ` +
        `'permission', 'description', or a key repeated INSIDE the permission map — and tab ` +
        `indentation each do it, silently, leaving the file looking correct. A merge conflict ` +
        `resolved by keeping both sides is the realistic way in. ` +
        `${remedy(agent, agentDefDirs)}`,
    };
  }
}

/**
 * The remedy text — and FIXING THE FILE IS NOT ENOUGH, which is why this says so.
 *
 * Probed on 1.18.7 (2026-07-30): a running `opencode serve` child never re-reads an agent def,
 * for the resolved config OR for enforcement. So the obvious remedy — edit the def, re-run
 * `init`, retry — leaves the same refusal in place, because the stale child is still serving.
 * And `OpencodeLifecycle.withServe` re-arms the idle timer on every entry, so a user retrying
 * in a tight loop keeps that child alive past `GUILD_SERVE_IDLE_MS` indefinitely. A remedy that
 * omits the fresh-child step sends the user round a loop that cannot terminate.
 */
function remedy(agent: string, agentDefDirs: readonly string[]): string {
  const where =
    agentDefDirs.length > 0
      ? `Check ${agentDefDirs.map((d) => `${d}/${agent}.md`).join(" or ")}`
      : `Check the '${agent}.md' def`;
  return (
    `${where} for a duplicate key or a tab-indented line; or delete it and re-run ` +
    `\`npx modelguild init\` to reinstall the shipped def (never-clobber means an EDITED def ` +
    `is skipped, so it has to be removed first). ` +
    `AND IF THE DEF IN FORCE IS THE GLOBAL ONE, RE-RUN IT AS 'npx modelguild init --global': a ` +
    `plain 'init' writes a PROJECT copy and leaves the bad global def in place for every other ` +
    `project. ` +
    `THEN GET A FRESH opencode serve CHILD. Fixing the file alone will NOT clear this: a running ` +
    `serve child never re-reads an agent def (probed on opencode 1.18.7), so the old config keeps ` +
    `being served — and every retry re-arms the idle timer, keeping the stale child alive. Two ` +
    `ways that work from where you are: (1) STOP CALLING ModelGuild until the serve idles out ` +
    `(GUILD_SERVE_IDLE_MS, default 600s) — the retry loop itself is what prevents this, so the ` +
    `fix is to wait rather than retry; (2) restart the MCP SERVER process, which for a stdio ` +
    `server means ending and restarting the client session — 're-adding' the server does not ` +
    `restart one that is already running. (GUILD_SERVE_PER_CALL=1 would give every call its own ` +
    `fresh child, but it is read ONCE when the server starts, so it is a setting to have in the ` +
    `server's environment beforehand, not an escape from this state.)`
  );
}

/**
 * The wording of the proceed-anyway note, in one place so the stderr line and the structured
 * field cannot drift. It states what was not established, and — deliberately — what is still
 * true, because a scary line about a check that could not run would push a reader toward
 * assuming a breach that has not been shown.
 */
function unverifiedNote(agent: string, reason: string): string {
  return (
    `could not verify that the '${agent}' agent's default-deny floor is in force — ${reason}. ` +
    `PROCEEDING: this check is a verification of a control opencode itself still enforces, and ` +
    `failing the call on a control-plane hiccup would convert a transient into an outage. What ` +
    `is NOT established for this call is that the def on disk is the def in force (issue #111, ` +
    `CONTRACT C73). ` +
    // R3 (review, 2026-07-30). The read paths lose only the guarantee above; an ARMED approval
    // bridge loses something sharper, and AGENTS.md names it as the worst failure this feature
    // can have, so it must be in the note rather than inferred by the reader.
    `AND IF THE APPROVAL BRIDGE IS ARMED (GUILD_APPROVE / GUILD_APPROVE_EGRESS), its gating may ` +
    `be NARROWER than the set of tools opencode will actually run: the bridge computes what to ` +
    `gate from the def SOURCE (C66's never-widen intersection), so on a def opencode is not ` +
    `applying, every tool the void newly permits runs UNGATED and UNPROMPTED while the run ` +
    `reports itself armed. ` +
    `If this persists, run \`modelguild/verify-guild-*.sh\` for the resolved-config proof.`
  );
}

/**
 * The process-wide checker the tools use by default. A per-process singleton so the cache
 * actually spans calls (the whole point of caching a per-child answer); tests construct their
 * own instance so one suite's cache never decides another's assertion.
 */
export const defaultAgentFloorChecker = new AgentFloorChecker();
