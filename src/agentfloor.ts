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
 * THIS IS NOT A NEW FENCE. It verifies that the fence the def already declares is in force.
 * PARITY (AGENTS.md): you would want the same before running an Anthropic subagent under a
 * restricted tool set — "the restriction I configured is actually applied" is not a
 * restriction, it is the absence of a silent failure. Provenance: the defect came from
 * adversarial review of the #100 fix; the decision to verify-and-refuse is the MAINTAINER's
 * (Ben, 2026-07-29); the effective-action test, the sentinel probe, the caching shape and the
 * cannot-ask direction are Claude's.
 *
 * COST, STATED: one extra control-plane GET per call (cached per serve child, so a panel pays
 * it once), and a new refusal that stops work when the def in force is not the hardened one.
 * It also means the read/write tools now touch opencode BEFORE the approval pre-flight rather
 * than only at the turn — see the placement note in each tool.
 */

import { listAgents, type ResolvedAgent, type ServeProvider } from "./client.js";

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
    // A missing pattern is read as the general one. Every entry on 1.18.7 carries `pattern`,
    // so this is a tolerance for a future shape, not an observed case.
    const pattern = typeof rec.pattern === "string" ? rec.pattern : "*";
    rules.push({ permission: rec.permission, pattern, action: rec.action });
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
 * The check, with a cache PER SERVE CHILD.
 *
 * THE CACHE KEY IS THE CHILD'S BASE URL, and getting that wrong would be worse than not
 * caching at all. Since issue #96 there can be more than one `opencode serve` child (one per
 * read/write root, `ServePool`), and opencode resolves agents from the SERVE'S CWD — probed:
 * a serve rooted at a worktree of a repo whose main checkout holds `guild-read.md` does not
 * list that agent at all. So "is `guild-read` hardened?" is genuinely a per-child question,
 * and a cache keyed on the agent name alone would answer one child's question with another
 * child's evidence. The base URL is the child (its negotiated loopback port); a child that
 * dies and is revived on a fresh port therefore gets a fresh check.
 *
 * The cached value is the PROMISE, so a panel's concurrent members share one in-flight request
 * rather than racing three identical ones.
 *
 * NOTHING HERE THROWS. Every failure becomes an `unverified` verdict; C31's posture, applied
 * to a verification path — a control-plane hiccup must not become a failed call.
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
   * Verify the floor for `agent` on the child `serve` provides. `agentDefDirs` is used only to
   * make a refusal actionable (it names the files to go and look at); it is never read.
   */
  verify(
    serve: ServeProvider,
    agent: string,
    agentDefDirs: readonly string[] = [],
  ): Promise<AgentFloorVerdict> {
    return serve.withServe(async (h) => {
      const key = `${h.baseUrl} ${agent}`;
      const hit = this.#cache.get(key);
      if (hit !== undefined) return hit;
      const pending = this.#compute(h.baseUrl, agent, agentDefDirs);
      this.#cache.set(key, pending);
      return pending;
    });
  }

  async #compute(
    baseUrl: string,
    agent: string,
    agentDefDirs: readonly string[],
  ): Promise<AgentFloorVerdict> {
    const verdict = await this.#classify(baseUrl, agent, agentDefDirs);
    if (verdict.state === "unverified") {
      // The maintainer's constraint on this direction: proceed, but NEVER silently. This line
      // is the unconditional half — the structured note on the tool result can be ignored by a
      // driver, a stderr line cannot be un-written. Emitted once per (child, agent) because the
      // cache holds the computation, not just the answer.
      this.#warn(`modelguild: ${verdict.note}`);
    }
    return verdict;
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

function remedy(agent: string, agentDefDirs: readonly string[]): string {
  const where =
    agentDefDirs.length > 0
      ? `Check ${agentDefDirs.map((d) => `${d}/${agent}.md`).join(" or ")}`
      : `Check the '${agent}.md' def`;
  return (
    `${where} for a duplicate key or a tab-indented line; or delete it and re-run ` +
    `\`npx modelguild init\` to reinstall the shipped def (never-clobber means an EDITED def ` +
    `is skipped, so it has to be removed first).`
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
    `CONTRACT C73). If it persists, run \`modelguild/verify-guild-*.sh\` for the resolved-config ` +
    `proof.`
  );
}

/**
 * The process-wide checker the tools use by default. A per-process singleton so the cache
 * actually spans calls (the whole point of caching a per-child answer); tests construct their
 * own instance so one suite's cache never decides another's assertion.
 */
export const defaultAgentFloorChecker = new AgentFloorChecker();
