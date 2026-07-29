/**
 * The opt-in approval bridge (issue #20, slice 4 of DESIGN-live-visibility.md).
 *
 * WHAT IT IS. Slices 1–3 made a guild call *watchable*: `src/activity.ts` streams what the
 * external model is DOING as it happens. This slice turns "see what it did" into "see what
 * it is ABOUT to run, and answer" — for the tools whose agent actually holds the gated
 * tool. It is **default OFF** and arms only when the developer sets `GUILD_APPROVE`
 * (write path) or `GUILD_APPROVE_EGRESS` (read paths' web egress).
 *
 * THE HONEST BOUND, FIRST, BECAUSE IT IS THE POINT (design §1, maintainer Q3). **An
 * approved `bash` is an approved shell.** The prompt shows a command string; a one-liner
 * can `cat .env`, `curl` it out, spawn `opencode --agent build`, or rewrite history, and
 * the processes it spawns raise no further requests. This bridge buys ATTENTION and an
 * INTERRUPT, not containment. The human **diff review** stays the write path's review
 * point (`/guild:delegate` step 3, SECURITY.md, CONTRACT.md C49). Anyone reading an
 * approval prompt as a containment guarantee has been misled — every place this feature is
 * described has to say so, not just this comment.
 *
 * HOW `ask` IS INJECTED WITHOUT TOUCHING AN AGENT DEF (probe P2, GREEN; re-verified on
 * opencode 1.18.7 for this slice). `POST /session` accepts `permission: PermissionRule[]`
 * (`{permission, pattern, action}`); the ruleset is APPENDED AFTER the agent def's resolved
 * array and evaluated last-match-wins, so it MERGES and can override in BOTH directions.
 * The hardened defs therefore stay byte-identical — `check-agent-permissions.sh` and
 * `verify-guild-*.sh` keep asserting exactly what they assert today.
 *
 * THAT FIELD IS opencode's **v1** PERMISSION SURFACE, AND THIS BRIDGE IS PINNED TO v1 BY
 * DECISION (issue #93; maintainer, 2026-07-29) — do NOT move it onto the v2 endpoints, which
 * do not consult the ruleset stored on the session. **The evidence, the expiry condition and
 * the revisit preconditions live in ONE place: the `V1 PIN` block in `src/client.ts`**, next
 * to the endpoints themselves. They are deliberately not restated here — this record having
 * been copied around is precisely how one wrong claim about it reached five files at once
 * (see the correction noted in that block). The re-probe is runnable:
 * `bash modelguild/verify-permission-surface.sh`.
 *
 * TWO INVARIANTS, BOTH MECHANICAL, BOTH LOAD-BEARING BECAUSE OF THAT MERGE:
 *
 *   1. **NEVER EMIT `allow`.** The one-line ruleset that proved the merge in probe P2 was
 *      `[{bash, *, allow}]` — and it handed a WORKING SHELL to the read-only `guild-read`
 *      agent. A ruleset that can re-open a denied tool is a privilege escalation dressed
 *      as a safety feature. `assertOnlyAskRules` runs on the constructed ruleset here, and
 *      `createSession` asserts it AGAIN at the wire boundary (`src/client.ts`) so no future
 *      caller can route around this module.
 *
 *   2. **NEVER GATE A TOOL THE AGENT DOES NOT ALREADY ALLOW.** `ask` is not `allow`, but on
 *      a tool the def DENIES it is still a widening: `{bash, *, ask}` on `guild-read` would
 *      convert a denied tool into an approvable one, so a human keystroke could hand the
 *      read-only role a shell. Gated tools are therefore the INTERSECTION of the tier's
 *      tools with the allow-set PARSED FROM THE AGENT DEF IN FORCE (`resolveAgentAllowSet`).
 *      It was a hard-coded mirror of the three shipped defs until review finding H3 showed
 *      why that cannot work: a mirror is never compared to the def actually resolved, so a
 *      user-hardened `guild-build.md` denying `bash` still got `{bash,*,ask}` emitted. An
 *      unparseable def REFUSES to arm rather than falling back to a guess.
 *
 * AN UNANSWERED ASK HANGS — SO THE TIMEOUT AND THE UP-FRONT REFUSAL ARE LOAD-BEARING
 * (probe P3). Under `opencode serve` an `ask`-tier call emits `permission.asked` and then
 * WAITS indefinitely for an HTTP reply (it does NOT auto-reject on a non-TTY; that older
 * claim is refuted for the serve path). So: (a) an unanswered request is REJECTED after
 * `GUILD_APPROVE_TIMEOUT_MS` — fail-closed, and the reject message reaches the model
 * verbatim, which it reasons around rather than aborting; (b) arming with no channel that
 * can answer would DEADLOCK the turn, so `armApproval` REFUSES up front, before
 * `log.expect()` — the same gap-parity discipline as the `agent-def-missing` refusal.
 *
 * TWO ANSWERING CHANNELS, AND opencode IS THE ARBITER.
 *   1. **MCP elicitation** — a raw `elicitation/create` request (the SDK's `elicitInput()`
 *      helper gates on `elicitation.form`, which Claude Code's bare `{}` does not carry, so
 *      the helper throws before sending; `server.request` only asserts the capability
 *      EXISTS — probe P4, re-read in the installed SDK for this slice). Headless
 *      (`claude -p`) auto-answers `{"action":"cancel"}`, so **cancel maps to REJECT** and
 *      elicitation is not a usable channel for an unattended run.
 *   2. **The `modelguild watch --approve` terminal** — the channel that works headless. It
 *      replies to the loopback serve port ITSELF; this module never proxies its decision.
 *      Both channels may answer the same request: **first reply wins, opencode arbitrates**
 *      (a second reply to a settled permission id is a 404 — verified on 1.18.7), and the
 *      loser is recorded, not retried.
 *
 * A REFUSED REPLY IS NOT SELF-EXPLANATORY, SO IT IS CHECKED (issue #97). That arbitration 404
 * is byte-identical to the 404 a REMOVED reply endpoint would give — and `permission.respond`,
 * the approve half, is the only operation opencode 1.18.7 marks `deprecated`. Its removal would
 * fail every approval while rejections kept landing: the developer says yes, nothing happens,
 * the turn stalls to `GUILD_MESSAGE_TIMEOUT_MS`. So **any non-2xx opencode actually answers** —
 * not the 404 alone, since a removed route can equally give 405/410/501 (widened by review,
 * 2026-07-29) — is followed by one bounded `GET /permission` (the same v1 snapshot the #91
 * re-list reads, filtered to this session): **still open ⇒ the reply did not land**, counted
 * under `unsettled` with a latched `unsettledReason` naming the status observed; **not open ⇒
 * nothing is stuck**, and the cause is named only where the status supports it — a 404 is
 * `contested` (the documented race), anything else is `refused` (observed, undiagnosed);
 * **the check unable to answer ⇒ neither**, recorded as unconfirmed rather than guessed. A
 * reply that never came back at all is the one `undelivered` arm, untouched. It deliberately
 * does NOT feed `degraded`, which since #91 means "blind NOW" and clears when the stream and
 * the open-request list say so — a bridge that can see perfectly well but cannot deliver is a
 * different failure, and a `#relist` clearing it would erase it.
 *
 * THE BLIND WINDOW, AND WHAT SHRINKING IT DOES AND DOES NOT BUY (issue #91). This bridge
 * answers requests off the event stream, so losing that stream makes it blind: requests still
 * OPEN are rejected fail-closed (`#onDegraded`), but one raised WHILE blind was never seen at
 * all, and SSE has no replay — so it used to wait on `GUILD_MESSAGE_TIMEOUT_MS` (15 min) with
 * nothing prompted, rather than on `GUILD_APPROVE_TIMEOUT_MS` (120 s). On re-attach the bridge
 * now asks opencode what is still open (`GET /permission`, probed live on 1.18.7) and routes
 * its own session's requests as if the event had arrived, which makes the window the reconnect
 * backoff instead of the turn's backstop. **The guarantee is "recovered on reconnect", NEVER
 * "never missed":** the list is a snapshot of what is still OPEN, so a request raised and
 * settled by somebody else while this bridge was blind leaves nothing behind to recover, and
 * this bridge will never have seen it. `blindWindows` stays on the summary saying exactly that.
 *
 * NOTHING HERE MAY BE SELF-APPROVED BY THE DRIVER. There is deliberately **no tool input**
 * that pre-approves a permission request: a decision is only ever accepted from a channel
 * above. `test/approve.test.ts` asserts no tool's input schema carries an approval field.
 */

import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { listPendingPermissions, SHORT_HTTP_MS, type PendingPermission } from "./client.js";
import { confGet, coerceTimeoutMs } from "./config.js";
import {
  normalizeServeEvent,
  ServeEventBus,
  type ActivityEvent,
  type BusHandlers,
} from "./activity.js";

// ---------------------------------------------------------------------------
// Knobs
// ---------------------------------------------------------------------------

/**
 * `GUILD_APPROVE` — the write-path tier.
 *
 * - `off` (DEFAULT) — nothing is gated. The external write path is then LESS gated than
 *   Claude Code's own default permission mode; PARITY permits asymmetry in the permissive
 *   direction (see the parity note at the foot of this file).
 * - `write` — gate the file-mutation tools (`edit`/`write`/`patch`).
 * - `all` — additionally gate `bash`, i.e. everything `guild-build` can do. This is the
 *   tier the honest bound is about: approving one `bash` call approves a shell.
 */
export type ApprovalTier = "off" | "write" | "all";

/**
 * `GUILD_APPROVE_EGRESS` — a SEPARATE, opt-in, default-off knob offering `ask` on
 * `webfetch`/`websearch` for the READ paths (`guild-read`/`guild-research`).
 *
 * PROVENANCE, because this one needs it (maintainer decision, 2026-07-28, answering design
 * open question 8): the read paths are deliberately NOT fenced — the 2026-07-22 realignment
 * removed the secret-glob and grep/glob denials as vendor-asymmetry bias, and a read-only
 * external agent gets a Claude review subagent's tools. The ONE ratified harness difference
 * that survives is that **a read on those paths egresses to a third-party vendor**, whereas
 * a Claude subagent's read stays inside Anthropic. This knob is the single place that
 * difference is allowed to buy something — and it buys an **offered, opt-in** gate, never a
 * fence: default `off`, no new harness difference claimed, nothing removed from the path.
 */
export type ApprovalEgress = "off" | "ask";

export interface ApprovalSettings {
  tier: ApprovalTier;
  egress: ApprovalEgress;
  /** Unanswered ⇒ reject after this many ms (fail-closed). */
  timeoutMs: number;
}

/** Default approval wait. 120s: long enough to read a command and decide, short enough that
 * an unattended run fails closed well inside the 15-minute model-turn budget it shares
 * (`GUILD_MESSAGE_TIMEOUT_MS`) rather than eating most of it. */
export const DEFAULT_APPROVE_TIMEOUT_MS = 120_000;

const TIER_VALUES: readonly string[] = ["off", "write", "all"];
const EGRESS_VALUES: readonly string[] = ["off", "ask"];

/**
 * Tool sets per tier. `write` is file mutation; `all` adds `bash`.
 *
 * JUDGMENT CALL, RECORDED (2026-07-28). The maintainer's Q2 note glossed `write` as
 * "edit/write/patch/bash" and `all` as "also gate bash" — which cannot both hold, since it
 * would make `all` a synonym for `write` and leave Q3 ("`all` EXISTS, with the honest bound
 * documented") deciding nothing. Q3's whole rationale is that an approved `bash` is an
 * approved shell, so `bash` is what `all` adds; that is also the design's own §3.3 wording.
 * Implemented that way, in ONE table, so flipping it is a one-line change if the maintainer
 * meant the other reading.
 */
const TIER_TOOLS: Record<ApprovalTier, readonly string[]> = {
  off: [],
  write: ["edit", "write", "patch"],
  all: ["edit", "write", "patch", "bash"],
};

/** What `GUILD_APPROVE_EGRESS=ask` gates — the web tools, on the paths that have them. */
const EGRESS_TOOLS: readonly string[] = ["webfetch", "websearch"];

/** Every tool any tier could ever ask to gate — the only keys the def parser is consulted
 * about, so an unrelated permission entry can never affect arming. */
const CANDIDATE_TOOLS: readonly string[] = ["edit", "write", "patch", "bash", ...EGRESS_TOOLS];

/**
 * `edit` IS LOAD-BEARING IN EVERY TIER AND MUST NEVER BE REMOVED FROM ONE.
 *
 * PROBED on opencode 1.18.7 during review: the `write` permission key is **inert** — a
 * ruleset of `[{write,*,ask}]` alone gated nothing, while `[{edit,*,ask}]` alone blocked a
 * `write` tool call. opencode routes the whole write/patch family through the `edit` key, so
 * `edit` is the key that actually gates file mutation. `write`/`patch` are emitted anyway
 * (harmless, and correct if a future opencode splits them), but they are not what bites.
 *
 * Consequence for anyone editing `TIER_TOOLS`: dropping `edit` from a tier would silently
 * un-gate file mutation while the tier still *looked* armed. Adding a tier without `edit`
 * has the same effect. `test/approve.test.ts` pins that every non-`off` tier contains it.
 */
const KEY_THAT_GATES_MUTATION = "edit";

/** Fail LOUDLY at module load if a tier ever loses `edit` — the failure it guards is silent
 * (a tier that looks armed and gates nothing), so a noisy assertion is the cheap half of the
 * protection; `test/approve.test.ts` pins the same rule. */
for (const [tier, tools] of Object.entries(TIER_TOOLS)) {
  if (tier !== "off" && !tools.includes(KEY_THAT_GATES_MUTATION)) {
    throw new Error(
      `approval tier '${tier}' does not gate '${KEY_THAT_GATES_MUTATION}' — on opencode 1.18.7 ` +
        `that is the key that actually gates file mutation (the 'write' key is inert, probed), ` +
        `so this tier would look armed and gate nothing.`,
    );
  }
}

/**
 * The tools a permission key actually governs on opencode 1.18.7, for HONEST reporting.
 * The bridge emits one rule per tool name, but `edit` is what gates the family (see above),
 * so a prompt or a summary that named only the literal keys would understate what a single
 * approval covers. Surfaced through `effectiveGatedFamily`, never used to widen anything.
 */
const KEY_GOVERNS: Record<string, readonly string[]> = {
  edit: ["edit", "write", "patch"],
};

// ---------------------------------------------------------------------------
// The allow-set, READ FROM THE DEF IN FORCE (not from a hard-coded mirror)
// ---------------------------------------------------------------------------

/**
 * Parse the effective allow/deny for each candidate tool out of an opencode agent def's
 * `permission:` frontmatter block.
 *
 * WHY THIS EXISTS RATHER THAN A TABLE (review finding H3, 2026-07-28). This module used to
 * carry a hard-coded `AGENT_ALLOW_SETS` mirror of the three shipped defs, and invariant 2
 * was enforced against *that*. It was never compared to the def actually in force — so with
 * `GUILD_AGENT_DIR` pointing at a user-hardened `guild-build.md` that DENIES `bash`, the
 * bridge still emitted `{bash,*,ask}` and converted a tool the user had denied into an
 * approvable one. A mirror cannot hold invariant 2; only the def can. The mirror is gone.
 *
 * SEMANTICS, matching opencode's own last-match-wins resolution (the same rule
 * `check-agent-permissions.sh` lints and `verify-guild-*.sh` proves against a live serve):
 * the LAST entry whose key matches a tool decides it. `"*"` matches every tool, so a `"*"`
 * appearing after a named key overrides that key, and a named key after `"*"` overrides the
 * floor. With no `"*"` at all, opencode's built-in default is `allow`.
 *
 * A NESTED SUBMAP (`read:` with per-path globs) is resolved by its own `"*"` entry, which is
 * the tool-level answer; a submap with no `"*"` is UNRESOLVED and treated as **not allowed**
 * — this parser only ever decides whether the bridge may gate a tool, so every ambiguity
 * resolves toward gating less.
 *
 * Tolerant by design (it is a lint-grade line parser, not a YAML engine) but NOT silent:
 * a def with no frontmatter or no `permission:` block returns `ok:false`, and the caller
 * refuses to arm rather than guessing.
 */
export interface AgentAllowSet {
  /** Tools that resolve to `allow` for this agent, among `CANDIDATE_TOOLS`. */
  allow: Set<string>;
  /** The def file the answer came from — named in every refusal so it is checkable. */
  file: string;
}

export function parseAgentPermissions(
  defText: string,
): { ok: true; allow: Set<string> } | { ok: false; reason: string } {
  const lines = defText.split(/\r?\n/);
  // Frontmatter: the block between the first `---` and the next `---`.
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      start = i;
      break;
    }
  }
  if (start === -1) return { ok: false, reason: "no YAML frontmatter (`---`) found" };
  let end = -1;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) return { ok: false, reason: "frontmatter is not closed by a second `---`" };

  const fm = lines.slice(start + 1, end);
  let permIdx = -1;
  for (let i = 0; i < fm.length; i++) {
    if (/^permission:\s*(#.*)?$/.test(fm[i])) {
      permIdx = i;
      break;
    }
  }
  if (permIdx === -1) return { ok: false, reason: "no `permission:` block in the frontmatter" };

  const isSkippable = (l: string): boolean => l.trim() === "" || /^\s*#/.test(l);
  const indentOf = (l: string): number => l.length - l.replace(/^\s+/, "").length;
  const unquote = (s: string): string => s.replace(/^["']|["']$/g, "");

  /** `key: value` / `key:` at a given indent, or undefined. */
  const entryOf = (l: string): { key: string; value: string | undefined } | undefined => {
    const m = /^\s*("[^"]*"|'[^']*'|[^\s:#]+)\s*:\s*(.*?)\s*(?:#.*)?$/.exec(l);
    if (m === null) return undefined;
    const value = m[2].length > 0 ? unquote(m[2]) : undefined;
    return { key: unquote(m[1]), value };
  };

  // Collect the block's own entries (and, for a submap, that submap's `"*"`).
  interface Rule {
    key: string;
    action: string;
  }
  const rules: Rule[] = [];
  let baseIndent = -1;
  for (let i = permIdx + 1; i < fm.length; i++) {
    const line = fm[i];
    if (isSkippable(line)) continue;
    const indent = indentOf(line);
    if (baseIndent === -1) baseIndent = indent;
    if (indent < baseIndent) break; // dedented out of the permission block
    if (indent > baseIndent) continue; // a submap's inner lines, handled below
    const e = entryOf(line);
    if (e === undefined) continue;
    if (e.value !== undefined) {
      rules.push({ key: e.key, action: e.value });
      continue;
    }
    // A SUBMAP (`read:` + per-path globs). Its tool-level answer is its own `"*"`; with
    // none, leave it unresolved so it resolves toward NOT allowed below.
    let sub: string | undefined;
    for (let j = i + 1; j < fm.length; j++) {
      const inner = fm[j];
      if (isSkippable(inner)) continue;
      if (indentOf(inner) <= baseIndent) break;
      const ie = entryOf(inner);
      if (ie !== undefined && ie.key === "*" && ie.value !== undefined) {
        sub = ie.value;
        break;
      }
    }
    rules.push({ key: e.key, action: sub ?? "unresolved" });
  }

  if (rules.length === 0) return { ok: false, reason: "the `permission:` block has no entries" };

  // LAST MATCH WINS. Track the index of the last `"*"` and of the last named rule per tool.
  let starAction: string | undefined;
  let starIndex = -1;
  const named = new Map<string, { action: string; index: number }>();
  rules.forEach((r, index) => {
    if (r.key === "*") {
      starAction = r.action;
      starIndex = index;
    } else {
      named.set(r.key, { action: r.action, index });
    }
  });

  const allow = new Set<string>();
  for (const tool of CANDIDATE_TOOLS) {
    const n = named.get(tool);
    // opencode's own built-in default is `allow` when no `"*"` is declared at all.
    const effective = n !== undefined && n.index > starIndex ? n.action : (starAction ?? "allow");
    if (effective === "allow") allow.add(tool);
  }
  return { ok: true, allow };
}

/** Locate the agent's def in the SAME dirs the tools' presence pre-check uses, and read its
 * effective allow-set. Fail-closed: unreadable or unparseable ⇒ an error the caller turns
 * into a refusal naming the file, never a guess. */
export function resolveAgentAllowSet(
  agent: string,
  agentDefDirs: readonly string[],
): { ok: true; set: AgentAllowSet } | { ok: false; reason: string } {
  for (const dir of agentDefDirs) {
    const file = path.join(dir, `${agent}.md`);
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const parsed = parseAgentPermissions(text);
    if (!parsed.ok) {
      return {
        ok: false,
        reason: `could not read the permission map from the '${agent}' agent def at ${file}: ${parsed.reason}`,
      };
    }
    return { ok: true, set: { allow: parsed.allow, file } };
  }
  return {
    ok: false,
    reason: `the '${agent}' agent def was not found in any of: ${agentDefDirs.join(", ")}`,
  };
}

export type ApprovalKnobResult =
  | { ok: true; settings: ApprovalSettings }
  | { ok: false; error: string };

/**
 * Resolve the approval knobs: env override > `modelguild.conf.local` > default (C35).
 *
 * AN UNRECOGNIZED TIER IS AN ERROR, NOT A SILENT DEFAULT — the opposite of `GUILD_ACTIVITY`,
 * deliberately. `GUILD_ACTIVITY` is capability-neutral, so a typo failing toward recording
 * costs nothing. Here a typo resolving to `off` would leave the developer believing every
 * edit is gated while none is — a false sense of a guarantee, which is the worst failure
 * this feature can have. So `GUILD_APPROVE=writ` refuses the call and names the accepted
 * values (mirroring `parsePerCallTimeoutMs`'s strict per-call path).
 *
 * The TIMEOUT is lenient by the same logic: an unusable value falls back to the default,
 * which is still fail-closed — it can only change HOW LONG the developer has to answer.
 */
export function resolveApprovalSettings(opts: {
  env?: NodeJS.ProcessEnv;
  confContents?: string;
} = {}): ApprovalKnobResult {
  const env = opts.env ?? process.env;
  const conf = opts.confContents ?? "";
  const pick = (key: string): string => {
    const fromEnv = env[key];
    if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
    return confGet(conf, key);
  };

  const rawTier = pick("GUILD_APPROVE").trim().toLowerCase();
  const tier = rawTier === "" ? "off" : rawTier;
  if (!TIER_VALUES.includes(tier)) {
    return {
      ok: false,
      error:
        `GUILD_APPROVE is '${rawTier}', which is not one of ${TIER_VALUES.join(" | ")}. ` +
        `Refusing the call rather than guessing: a typo silently resolving to 'off' would ` +
        `leave you believing the model's edits are gated when they are not. Fix the value ` +
        `(env or modelguild/modelguild.conf.local) and retry.`,
    };
  }

  const rawEgress = pick("GUILD_APPROVE_EGRESS").trim().toLowerCase();
  const egress = rawEgress === "" ? "off" : rawEgress;
  if (!EGRESS_VALUES.includes(egress)) {
    return {
      ok: false,
      error:
        `GUILD_APPROVE_EGRESS is '${rawEgress}', which is not one of ${EGRESS_VALUES.join(" | ")}. ` +
        `Refusing rather than guessing, for the same reason as GUILD_APPROVE.`,
    };
  }

  const rawTimeout = pick("GUILD_APPROVE_TIMEOUT_MS");
  const timeoutMs =
    rawTimeout.length === 0
      ? DEFAULT_APPROVE_TIMEOUT_MS
      : (coerceTimeoutMs(rawTimeout) ?? DEFAULT_APPROVE_TIMEOUT_MS);

  return {
    ok: true,
    settings: { tier: tier as ApprovalTier, egress: egress as ApprovalEgress, timeoutMs },
  };
}

// ---------------------------------------------------------------------------
// The ruleset builder
// ---------------------------------------------------------------------------

/** One opencode `PermissionRule` (`POST /session` → `permission`), verified against
 * opencode 1.18.7's `/doc`: `{permission, pattern, action}`, action ∈ allow|deny|ask. */
export interface SessionPermissionRule {
  permission: string;
  pattern: string;
  action: "ask";
}

/** Thrown when a constructed ruleset would violate invariant 1 or 2. It is a PROGRAMMING
 * error, not a user error — hence a throw rather than a result, so it can never be
 * swallowed into "the bridge quietly did nothing". */
export class ApprovalRulesetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalRulesetError";
  }
}

/**
 * The tools this bridge would gate: the tier's tools (plus the egress tools when that knob
 * is armed), INTERSECTED with the allow-set read from the agent def **in force**.
 *
 * The intersection IS invariant 2. `ask` on a tool the def denies would convert a denied
 * tool into an approvable one — a human keystroke from a capability the role does not have —
 * so a tool the def does not allow is never gated, whatever the tier says.
 */
export function gatedToolsFor(allowSet: ReadonlySet<string>, settings: ApprovalSettings): string[] {
  const wanted: string[] = [...TIER_TOOLS[settings.tier]];
  if (settings.egress === "ask") wanted.push(...EGRESS_TOOLS);
  // Ordered by the TIER's declaration so the ruleset (and every test that pins it) is stable.
  return wanted.filter((t) => allowSet.has(t));
}

/**
 * What an approval of `tool` actually covers on opencode 1.18.7, for honest reporting.
 * `edit` gates the whole write/patch family (probed), so a prompt naming only "edit" would
 * understate it. Never used to decide what is gated — only what is SAID about it.
 */
export function effectiveGatedFamily(tools: readonly string[]): string[] {
  const out = new Set<string>();
  for (const t of tools) {
    out.add(t);
    for (const g of KEY_GOVERNS[t] ?? []) out.add(g);
  }
  return [...out];
}

/**
 * ASSERT INVARIANT 1 on a constructed ruleset, before it can be sent.
 *
 * Exported and called twice on purpose: here (construction) and at the wire boundary in
 * `src/client.ts` `createSession`. One check would be enough if this module were the only
 * possible caller — it is not, and the failure mode (one `allow` line handing a shell to
 * the read-only agent) is bad enough to be worth the second, cheap look.
 */
export function assertOnlyAskRules(rules: readonly { action: string; permission: string }[]): void {
  for (const r of rules) {
    if (r.action !== "ask") {
      throw new ApprovalRulesetError(
        `refusing to send a session permission rule with action '${r.action}' for ` +
          `'${r.permission}': the approval bridge may ONLY narrow. A session ruleset MERGES ` +
          `over the agent def (last-match-wins), so an 'allow' here would re-open a tool the ` +
          `hardened def denies — a privilege escalation dressed as a safety feature.`,
      );
    }
    if (r.permission.length === 0) {
      throw new ApprovalRulesetError("refusing to send a permission rule with an empty tool name.");
    }
  }
}

/**
 * Build the ruleset for one call. Returns `[]` when nothing is gated for this agent — which
 * is the normal answer for a read path under `GUILD_APPROVE` alone (`guild-read` holds none
 * of `edit`/`write`/`patch`/`bash`, so the intersection is empty and the read paths are
 * untouched unless the separate egress knob is on).
 */
export function buildApprovalRuleset(opts: {
  agent: string;
  settings: ApprovalSettings;
  /** The allow-set read from the def IN FORCE (`resolveAgentAllowSet`) — never a mirror. */
  allowSet: ReadonlySet<string>;
}): SessionPermissionRule[] {
  const tools = gatedToolsFor(opts.allowSet, opts.settings);
  const rules: SessionPermissionRule[] = tools.map((permission) => ({
    permission,
    pattern: "*",
    action: "ask",
  }));
  assertOnlyAskRules(rules);
  // Invariant 2, asserted rather than merely implemented by `gatedToolsFor`.
  for (const r of rules) {
    if (!opts.allowSet.has(r.permission)) {
      throw new ApprovalRulesetError(
        `refusing to gate '${r.permission}' on agent '${opts.agent}': that tool is DENIED by ` +
          `the agent def in force, and an 'ask' rule would convert a denied tool into an ` +
          `approvable one — a human keystroke away from a capability the role does not have.`,
      );
    }
  }
  return rules;
}

/**
 * THE ONE predicate for "is the session opencode is about to run in genuinely gated?".
 *
 * Shipped and tested through a single implementation (review finding M10: there used to be
 * two — a `rulesetSatisfies` the tests pinned and a `storedCarriesRules` the product
 * actually used, so the tested one proved nothing). `src/client.ts` calls this through an
 * injected callback, which is how it stays free of any import from this module.
 *
 * It checks TWO things, because a subset check alone was not enough (review finding M7 —
 * probed): every required `ask` rule is present, **and** the stored ruleset carries no rule
 * that WIDENS the agent. A continued session whose ruleset also held `{bash,*,allow}` passed
 * the old subset check and ran on a widened session while reporting itself "armed". So any
 * stored rule whose action is not `ask` for a tool outside the def's allow-set is a refusal.
 *
 * What it does NOT claim: it cannot see rules opencode applied from anywhere other than the
 * session record, and it is a check on the ruleset, not on opencode's resolved behaviour
 * (that is `verify-guild-*.sh`'s job, against a live serve).
 */
export function checkStoredRuleset(
  stored: unknown,
  required: readonly SessionPermissionRule[],
  allowSet: ReadonlySet<string>,
): { ok: true } | { ok: false; reason: string } {
  if (required.length === 0) return { ok: true };
  if (!Array.isArray(stored)) {
    return { ok: false, reason: "the session carries no permission ruleset at all" };
  }
  const have = stored as Array<Record<string, unknown>>;
  for (const req of required) {
    const found = have.some(
      (s) =>
        s.permission === req.permission && s.pattern === req.pattern && s.action === req.action,
    );
    if (!found) {
      return {
        ok: false,
        reason: `the session's ruleset does not carry the required rule {${req.permission}, ${req.pattern}, ask}`,
      };
    }
  }
  for (const s of have) {
    const action = typeof s.action === "string" ? s.action : "";
    const permission = typeof s.permission === "string" ? s.permission : "";
    if (action === "ask") continue;
    // A non-`ask` rule is only acceptable for a tool the def ALREADY allows — anything else
    // is the session having been widened past the agent's own permission map.
    if (!allowSet.has(permission)) {
      return {
        ok: false,
        reason:
          `the session's ruleset carries {${permission}, ${String(s.pattern)}, ${action}} for a ` +
          `tool the agent def does NOT allow — that session has been WIDENED past the agent's ` +
          `permission map, so running in it would not be the gated call you asked for`,
      };
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Watcher presence — how the server knows a terminal can answer
// ---------------------------------------------------------------------------

/** Sub-directory of the evidence log root holding watcher presence files. It sits beside
 * `logs/<run>/` rather than inside a run: a watcher is started BEFORE the run exists. */
export const WATCHER_DIR = "watchers";
/** How often `modelguild watch --approve` touches its presence file. */
export const WATCHER_HEARTBEAT_MS = 5_000;
/** A presence file older than this is STALE and ignored — four missed beats, so a busy host
 * never evicts a healthy watcher, and a `SIGKILL`ed one disappears within ~20s. */
export const WATCHER_STALE_MS = 20_000;

export interface WatcherPresence {
  file: string;
  pid: number;
  mode: string;
  ageMs: number;
}

export function watcherDirFor(logDir: string): string {
  return path.join(logDir, WATCHER_DIR);
}

/**
 * Every LIVE approval watcher: a presence file whose mtime is within `WATCHER_STALE_MS` and
 * whose recorded `mode` is `approve`.
 *
 * `mode` is load-bearing: a plain `modelguild watch` cannot prompt for a decision, so
 * counting it as an answering channel would arm the bridge into a deadlock. Only
 * `--approve` writes `mode: "approve"`.
 *
 * TWO LIVENESS TESTS, NOT ONE (review finding L9). A fresh mtime alone is a weak signal —
 * a `SIGKILL`ed or `SIGINT`ed watcher can leave a file that still looks recent for up to
 * `WATCHER_STALE_MS`. So the recorded **pid** is checked too (`process.kill(pid, 0)`), and a
 * presence file whose process is gone is treated as dead **and unlinked** rather than left
 * to age out. `EPERM` counts as alive (the process exists, it is simply not ours).
 *
 * FAILURE MODES, STATED (they are the cost of this being a file and not a socket):
 *   - the pid check is only meaningful on the SAME host, which is the only place this is
 *     used; and a recycled pid could in principle look alive, which is why the mtime window
 *     still applies — both must pass;
 *   - a watcher tailing a DIFFERENT log dir than the server resolves (another cwd, another
 *     `GUILD_LOG_DIR`) is invisible here, so the call is refused up front naming the exact
 *     directory that was searched — a wrong-terminal mistake reads as a refusal, not a hang;
 *   - `GUILD_LOG=off` writes no run dir, so there is nowhere to publish a request: the watch
 *     channel is then unavailable by construction and `armApproval` says so;
 *   - if a watcher dies in the window between this check and the request, nothing answers and
 *     the fail-closed timeout rejects — bounded and named, never silent.
 */
function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else — alive for our purposes.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function liveApprovalWatchers(
  logDir: string,
  now: number = Date.now(),
): WatcherPresence[] {
  const dir = watcherDirFor(logDir);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: WatcherPresence[] = [];
  for (const name of names) {
    if (!name.endsWith(".watcher")) continue;
    const file = path.join(dir, name);
    let ageMs: number;
    try {
      ageMs = now - statSync(file).mtimeMs;
    } catch {
      continue;
    }
    let pid = 0;
    let mode = "";
    let readable = true;
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as { pid?: unknown; mode?: unknown };
      pid = typeof raw.pid === "number" ? raw.pid : 0;
      mode = typeof raw.mode === "string" ? raw.mode : "";
    } catch {
      readable = false;
    }
    const dead = !readable || !pidAlive(pid);
    if (dead || ageMs > WATCHER_STALE_MS) {
      // REAP rather than merely ignore: a corpse left in the directory is the thing that
      // makes the next arming decision wrong, and nothing else ever cleans it up.
      if (dead) {
        try {
          unlinkSync(file);
        } catch {
          /* best-effort; ignoring it is still correct */
        }
      }
      continue;
    }
    if (mode !== "approve") continue;
    out.push({ file, pid, mode, ageMs });
  }
  return out;
}

export interface WatcherHeartbeat {
  file: string;
  stop(): void;
}

/**
 * Announce (and keep announcing) that an approval-capable watcher is attached. Called by
 * `modelguild watch --approve`; the file is removed on stop and on process exit.
 */
export function startWatcherHeartbeat(
  logDir: string,
  opts: { intervalMs?: number; mode?: string } = {},
): WatcherHeartbeat {
  const dir = watcherDirFor(logDir);
  const file = path.join(dir, `${process.pid}-${Math.random().toString(36).slice(2, 8)}.watcher`);
  const mode = opts.mode ?? "approve";
  const payload = JSON.stringify({ pid: process.pid, mode, started: new Date().toISOString() });
  const beat = (): void => {
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, `${payload}\n`);
    } catch {
      /* presence is best-effort; the server simply refuses to arm without it */
    }
  };
  beat();
  const timer = setInterval(beat, opts.intervalMs ?? WATCHER_HEARTBEAT_MS);
  if (typeof timer.unref === "function") timer.unref();
  let stopped = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    try {
      unlinkSync(file);
    } catch {
      /* best-effort */
    }
  };
  process.once("exit", stop);
  // SIGNALS NEED THEIR OWN HANDLERS (review finding L8, reproduced): Ctrl-C does NOT run
  // `exit` listeners, and a `finally` in the CLI never runs either — so a SIGINT'd watcher
  // used to leave its presence file behind, and the server would arm believing a terminal
  // was listening for up to WATCHER_STALE_MS. Retract, then RE-RAISE with the default
  // disposition so the process still dies from the signal (and reports the right status)
  // rather than this handler quietly swallowing it.
  const onSignal = (sig: NodeJS.Signals): void => {
    stop();
    process.removeListener(sig, onSignal);
    try {
      process.kill(process.pid, sig);
    } catch {
      // A platform that will not re-raise must still not leave the watcher running.
      process.exit(130);
    }
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  process.once("SIGHUP", onSignal);
  return { file, stop };
}

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

/** What this module needs of the MCP elicitation channel, narrowed to a shape a test can
 * satisfy — so `approve.ts` imports nothing from the MCP SDK and stays unit-testable. */
export interface ElicitationRequester {
  /** Did the connected client advertise the `elicitation` capability at initialize? */
  available: boolean;
  /** Issue a RAW `elicitation/create`. Resolves the client's action; MUST NOT reject
   * (an implementation maps a transport failure to `"cancel"`, which is a REJECT here). */
  ask(opts: { message: string; timeoutMs: number }): Promise<ElicitationAction>;
}

export type ElicitationAction = "accept" | "decline" | "cancel";

/**
 * Build an `ElicitationRequester` over an MCP server's raw request function.
 *
 * `send` is supplied by `src/server.ts` (it closes over `server.request(...)` with
 * `ElicitResultSchema`), so the SDK dependency stays there.
 *
 * THE FORM HAS NO FIELDS, AND THAT IS THE UX FIX (maintainer feedback from a live
 * interactive test, 2026-07-28). The first version asked for a single boolean `approve`
 * field, which Claude Code's TUI renders as a **checkbox you must space-select and then
 * submit** — two non-obvious steps to say yes to a prompt whose whole value is being
 * answerable in one keypress. With an EMPTY `requestedSchema`, the client's own
 * **Accept / Decline** buttons ARE the decision. Everything the developer needs to read
 * therefore moves into the `message` (see `elicitationMessage`), because there are no
 * fields left to carry it.
 *
 * PROBED, not assumed (2026-07-28, this worktree, `claude -p` + a raw
 * `elicitation/create`, the same method as the Slice 0 P4 probe): an empty
 * `{type:"object", properties:{}}` is **accepted and answered** by Claude Code exactly like
 * the boolean and enum forms — all three returned `{"action":"cancel"}` headlessly, none
 * errored. It is also valid per the SDK's own `ElicitRequestFormParamsSchema`, whose
 * `properties` is a `z.record` (an empty record is a record) with `required` optional. The
 * single-enum fallback was therefore not needed.
 *
 * THE ACCEPT RULE CHANGED WITH THE SHAPE. The old code demanded `content.approve === true`
 * and treated an `accept` without it as a DECLINE — correct then, because a checkbox left
 * unchecked and submitted was a real "accept the form, say no". **That case cannot exist
 * now:** there is no field to leave unset, so an `accept` is unambiguously the Accept
 * button. Keeping the rule would have turned every real approval into a rejection. It is
 * removed, and this paragraph is why.
 *
 * WHAT DID NOT CHANGE — the fail-closed property, which is now stated as a positive rule:
 * **ONLY the literal action `"accept"` approves.** `"decline"` rejects; `"cancel"` (which
 * headless clients auto-answer within milliseconds) keeps its abstain-or-reject handling in
 * the bridge; and **any other value — an unknown action string, a missing action, a
 * malformed result, a transport failure, a timeout — is treated as `"cancel"`**, never as
 * consent. A channel whose entire job is consent must never infer it.
 */
export function makeElicitationRequester(opts: {
  capabilities: { elicitation?: unknown } | undefined;
  send: (
    params: { message: string; requestedSchema: unknown },
    timeoutMs: number,
  ) => Promise<{ action?: unknown; content?: unknown }>;
}): ElicitationRequester {
  const available = opts.capabilities?.elicitation !== undefined;
  return {
    available,
    async ask({ message, timeoutMs }): Promise<ElicitationAction> {
      if (!available) return "cancel";
      try {
        const res = await opts.send(
          {
            message,
            // NO FIELDS: the client's Accept/Decline buttons are the decision. See the
            // block comment — this shape is probed-accepted, and it is what makes the
            // prompt answerable in one keypress.
            requestedSchema: { type: "object", properties: {} },
          },
          timeoutMs,
        );
        // Positive matching ONLY. Written as an explicit allowlist rather than
        // `!== "accept" ? ... : ...` so that adding a future action to the protocol cannot
        // accidentally fall into the approving branch.
        if (res.action === "accept") return "accept";
        if (res.action === "decline") return "decline";
        return "cancel";
      } catch {
        return "cancel";
      }
    },
  };
}

/**
 * The text the developer actually reads before pressing Accept or Decline.
 *
 * IT CARRIES EVERYTHING, because the form has no fields to carry anything (see
 * `makeElicitationRequester`): what is about to run, on whose behalf, the sanitized detail,
 * the honest bound, and — where they apply — the two scope notes that would otherwise
 * mislead. Exported so the tests pin the wording; a prompt that reads like a containment
 * guarantee is the one way this feature can actively mislead someone.
 *
 * Every model-controlled fragment (`tool`, `detail`) is sanitized by its caller before it
 * reaches here, and sanitized again here, because this string is rendered in a terminal UI.
 */
export function elicitationMessage(opts: {
  command: string;
  model: string;
  tool: string;
  detail: string;
  timeoutMs: number;
}): string {
  const tool = oneLine(opts.tool, 40);
  const detail = oneLine(opts.detail, 300);
  const lines: string[] = [];
  lines.push(`ModelGuild approval — ${oneLine(opts.command, 40)} (${oneLine(opts.model, 60)})`);
  lines.push("");
  lines.push(`Run ${tool}${detail ? `: ${detail}` : ""}?`);
  lines.push("");
  if (tool === "bash") {
    // The single most misleading thing this prompt could imply, said at the point of decision.
    lines.push(
      "Approving bash approves a SHELL for this call: it can read any file (including " +
        "credentials), reach the network, and spawn processes that raise no further prompts.",
    );
  } else if (tool === "edit") {
    // Probed on opencode 1.18.7: the `write` permission key is inert and `edit` gates the
    // whole write/patch family, so "edit" understates what one approval covers.
    lines.push("Approving 'edit' covers this agent's write/patch family, not a single file op.");
  }
  lines.push(
    "This is visibility and an interrupt, NOT containment — the diff review is still the " +
      "review point.",
  );
  lines.push("");
  lines.push(
    `Accept = run it once. Decline = reject it (the model is told, and continues). ` +
      `No answer within ~${Math.round(opts.timeoutMs / 1000)}s = rejected, fail-closed.`,
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// The per-call bridge
// ---------------------------------------------------------------------------

/**
 * How a request was settled.
 *   - `elicitation` — the MCP client's own prompt answered it.
 *   - `external`    — somebody else answered opencode first, normally the
 *                     `modelguild watch --approve` terminal, which replies to the serve
 *                     port directly rather than through this process.
 *   - `timeout`     — nobody answered inside `GUILD_APPROVE_TIMEOUT_MS` (fail-closed).
 *   - `degraded`    — the event stream was lost while armed, so this bridge could no longer
 *                     see or answer requests and rejected what was open (review finding M6).
 *   - `closed`      — the bridge was torn down (turn ended/failed) with the request open.
 */
export type ApprovalDecidedBy = "elicitation" | "timeout" | "external" | "degraded" | "closed";

export interface ApprovalSummary {
  /** True when a non-empty ruleset was actually sent for this call. */
  armed: boolean;
  tier: ApprovalTier;
  egress: ApprovalEgress;
  /** The tools moved to `ask` for this call (already intersected with the def's allow-set). */
  gatedTools: string[];
  /**
   * What an approval of `gatedTools` ACTUALLY covers on opencode 1.18.7. Probed during
   * review: the `write` permission key is inert and `edit` gates the whole write/patch
   * family, so the literal key list understates the blast radius of one approval. Reported
   * separately rather than by quietly rewriting `gatedTools`, so both truths are visible.
   */
  effectiveTools: string[];
  /** Channels that could answer at arm time, in preference order. */
  channels: string[];
  timeoutMs: number;
  /** Distinct permission requests observed (asked, or replied-to without a seen ask). */
  requests: number;
  /**
   * OUTCOMES, COUNTED FROM EVIDENCE, NOT FROM INTENT (review finding M5). A decision is
   * counted only once opencode ACCEPTED the reply (2xx) or reported one on the event stream.
   * A reply that 404'd or never left the process counts under `contested` / `unsettled` /
   * `undelivered` instead — the old code incremented before the POST and could claim
   * `rejected: 1` for a reply that never landed.
   */
  approved: number;
  rejected: number;
  /** Rejected specifically because nobody answered in time (a subset of `rejected`). */
  timedOut: number;
  /** Answered by somebody other than this process (a subset of approved+rejected). */
  externallyAnswered: number;
  /**
   * A **404** that was not confirmed to have left the request open — the documented lost race
   * (somebody else answered first and opencode arbitrated), or a 404 whose cause could not be
   * established because the open-request check could not answer (it failed, or it returned an
   * entry that could not be attributed and might have been this one). Not an outcome.
   *
   * 404 ONLY. A non-404 refusal that leaves nothing open is `refused` — see there.
   *
   * NARROWED BY EVIDENCE (issue #97). Every 404 landed here until this bridge learned to ask
   * `GET /permission` whether the id is still open; the confirmed-still-open ones now go to
   * `unsettled` instead. The per-request record carries `still_open: false | null`, so "absent
   * from the open list" and "the check could not be made" stay distinguishable in the evidence
   * even though both sit in this one number.
   *
   * ONE THING IT STILL CANNOT SEE, stated so the narrowing is not read as more than it is: the
   * list consulted is the **v1** open-request snapshot (CONTRACT C69a), so a request raised on
   * another permission surface is absent from it and reads as `still_open: false` — true of
   * that list, and not the same claim as "somebody else answered". The record's note says so
   * rather than asserting the race outright.
   */
  contested: number;
  /**
   * opencode ANSWERED and refused this reply with a non-2xx that was **not** a 404, and the
   * request was not confirmed still open. Not an outcome, and deliberately not a diagnosis.
   *
   * WHY IT IS NOT `contested` (review, 2026-07-29). `contested` carries the lost-race reading,
   * and that reading belongs to the 404 — the status a settled or unknown request id answers.
   * A 405 (route gone but the path still matches), a 410 (retired), a 501 (proxied or
   * rewritten) or a transient 5xx say nothing about a race; booking them there would re-create
   * over `contested` exactly the overload issue #97 removed from it. What is known is what the
   * name says: opencode refused the reply, and nothing is known to be stuck. The record carries
   * the actual `http_status`, which is where the detail lives.
   *
   * WHY IT IS NOT `undelivered` either: opencode answered. `undelivered` is reserved for the
   * case where nothing came back at all.
   */
  refused: number;
  /**
   * Our reply never reached opencode — the request threw and there is no status to reason
   * from, so opencode's state is genuinely unknown. Not an outcome.
   *
   * NARROWED TO WHAT IT ALWAYS CLAIMED (review, 2026-07-29). Every non-2xx that was not a 404
   * used to land here too, under a note asserting "this reply did not reach opencode" — false
   * of a 410 or a 405, where opencode received it and refused it. Those now go through the
   * still-open check like any other answered refusal, and end in `unsettled` or `refused`.
   * This counter is the transport-failure arm alone.
   */
  undelivered: number;
  /**
   * DISTINCT REQUESTS THIS BRIDGE ANSWERED THAT OPENCODE REFUSED (any non-2xx it returned —
   * 404, 405, 410, 501, 5xx) AND STILL LISTS AS OPEN (issue #97). The developer's decision was taken and dropped: nothing runs (opencode
   * still holds the call at its `ask`), but nothing proceeds either, so the turn stalls to
   * `GUILD_MESSAGE_TIMEOUT_MS` instead of settling on the approval deadline.
   *
   * WHY IT IS NEITHER `contested` NOR `undelivered`. `contested` means somebody ELSE's answer
   * won — routine, healthy, nothing to act on. This is the opposite: nobody's answer won and
   * the request is verifiably still there. `undelivered` means the reply never reached opencode
   * at all, where opencode's state is unknown and the diagnosis is "the serve or the network is
   * down". Here the reply DID reach opencode, opencode answered it (404), and the request is
   * provably open — the diagnosis is "this reply endpoint no longer settles this request".
   * Folding it into either would make that number mean two different things at exactly the
   * moment its meaning matters.
   *
   * FED BY TWO OBSERVATIONS OF THE SAME CONDITION, deduplicated by permission id: a 404 whose
   * follow-up `GET /permission` still lists the id, and the re-list's own discovery that a
   * request this bridge already answered is still open (C68's existing "recorded, not retried"
   * case, which had no counter of its own).
   *
   * A NON-ZERO VALUE ON THE APPROVE PATH IS THE STATED EXPIRY CONDITION OF THE v1 PIN
   * (CONTRACT C69a): `POST /session/{id}/permissions/{permId}` is the one operation opencode
   * marks `deprecated`, and its removal fails every approval while rejections keep working — an
   * approval-only outage. `unsettledReason` names it, and the STATUS actually observed, at the
   * point it is first confirmed — the removal need not present as a 404 (405/410/501 are all
   * plausible shapes), which is why this counter is keyed on the answer, not on a status code.
   */
  unsettled: number;
  /**
   * Why the FIRST confirmed-undelivered decision could not be delivered, latched — the loud
   * half of `unsettled`, so a reader who does not diff counters still gets the diagnosis and
   * the next step. Null when nothing was ever confirmed undelivered.
   */
  unsettledReason: string | null;
  /** Elicitation cancelled while another live channel could still answer, so this bridge
   * deliberately did NOT settle the request (review finding H2). */
  abstained: number;
  /** Outcome counts by settler — `{elicitation: 1, timeout: 2, external: 1}`. */
  decidedBy: Record<string, number>;
  /**
   * The bridge is blind RIGHT NOW: the event stream was lost and has not been recovered. A
   * degraded bridge cannot SEE new requests, so a quiet `requests: 0` under `degraded: true`
   * means "we went blind", never "the model asked for nothing" — the same rule
   * `activity.degraded` states for the visibility layer.
   *
   * IT CAN NOW CLEAR (issue #91), and only on evidence: the bus re-attached, `GET /permission`
   * answered, everything it listed for this session was routed, and nothing this bridge had
   * already answered was still sitting open. Until then it stays set — a failed re-list leaves
   * it exactly where it was. Before #91 it latched for the life of the call, so every run that
   * survived a transport blip reported itself blind at the end when it could see perfectly
   * well.
   */
  degraded: boolean;
  /** Why the most recent blind window opened. RETAINED after recovery (it is the record of
   * what happened), so read it together with `degraded`, not instead of it. */
  degradedReason: string | null;
  /**
   * Distinct periods of UNRECOVERED blindness — **not** the number of times the stream
   * dropped. LATCHED: a re-list can clear `degraded`, it cannot make a window not have
   * happened, and this never returns to 0.
   *
   * WHAT IT ACTUALLY COUNTS, precisely, because the obvious reading is wrong (review finding
   * 2): it increments on each `false → true` transition of `degraded`, and `degraded` only
   * ever goes false on a clean re-list. So it is *(windows cleanly recovered from)* + *(1 if
   * blind now)*. Two things therefore merge into ONE window, both deliberately: the several
   * `onDegraded` calls one outage produces as reconnects fail (they are one outage, and
   * counting the retries would be noise), and two genuinely distinct outages separated by a
   * re-list that failed or came back unclean — because the bridge never regained sight in
   * between, so that is one continuous period of blindness however many times the socket
   * flapped inside it. If you want "how many times did the transport break", this is not that
   * number and never was; the internal `#blindEpoch` is, and it exists to guard `#relist`,
   * not to be reported.
   *
   * `degraded: false` with `blindWindows > 0` means the stream dropped and recovered — and it
   * is also the honest caveat on every counter above: a request raised AND settled by another
   * channel during a blind window leaves nothing open for the re-list to find, so the counts
   * can under-report that window. "Recovered on reconnect" is the guarantee; "never missed"
   * is not.
   */
  blindWindows: number;
  /** Requests recovered by re-listing opencode's open requests on re-attach rather than seen
   * on the stream (issue #91) — i.e. raised while this bridge was blind, and prompted anyway. */
  recovered: number;
  /** Where the request/decision record was written; null when nothing was written. */
  file: string | null;
  /** The honest bound, on the wire, so a reader of `structuredContent` cannot miss it. */
  note: string;
}

export interface ApprovalContext {
  runId: string;
  callId: string;
  model: string;
  agent: string;
  command: string;
}

/** The name of the per-run approval record, so the bridge and `modelguild watch` agree. */
export const APPROVALS_FILE = "approvals.jsonl";

const HONEST_BOUND =
  "Approval is visibility and an interrupt, NOT containment: an approved bash call is an " +
  "approved shell, and the processes it spawns raise no further requests. The human diff " +
  "review remains the review point.";

/**
 * One call's approval router. Structurally identical to `ActivityRecorder`'s attach seam
 * (`attach(baseUrl, sessionId) → detach`) so `src/client.ts` can hold both without knowing
 * what either does.
 *
 * EVERY method is best-effort about ITS OWN record-keeping (a failed append never breaks a
 * call), but NOT about the decision: a request this bridge cannot answer is rejected, never
 * left open.
 */
export class ApprovalBridge {
  readonly #settings: ApprovalSettings;
  readonly #gatedTools: string[];
  readonly #channels: string[];
  readonly #ctx: ApprovalContext;
  readonly #file: string | undefined;
  readonly #elicitation: ElicitationRequester | undefined;
  readonly #watchLogDir: string | undefined;
  readonly #fetchImpl: typeof fetch;
  readonly #armed: boolean;

  #bus: ServeEventBus | undefined;
  #unsubscribe: (() => void) | undefined;
  #baseUrl = "";
  #sessionId = "";
  #closed = false;
  #wrote = false;

  /** Open requests, by opencode permission id → the fail-closed timer. */
  #pending = new Map<string, NodeJS.Timeout>();
  /** Ids this bridge has already posted a reply for (prevents a double POST). NOT the
   * outcome record — a claimed reply can still 404 or fail in transit. */
  #claimed = new Set<string>();
  /** Every id ever seen, so `requests` counts distinct requests exactly once. */
  #seen = new Set<string>();
  /** The SETTLED outcome per id, recorded only from evidence (a 2xx reply, or opencode's own
   * `permission.replied`). This is what the counters are derived from. */
  #outcome = new Map<string, { decision: string; by: ApprovalDecidedBy }>();
  #approved = 0;
  #rejected = 0;
  #timedOut = 0;
  #external = 0;
  #contested = 0;
  #refused = 0;
  #undelivered = 0;
  /** Ids counted under `unsettled`, so the two observations that can detect the same stuck
   * request (a 404 whose re-check found it open; a re-list finding one we already answered)
   * count it exactly once — the same distinct-request discipline as `#seen`. */
  #unsettledIds = new Set<string>();
  #unsettledReason: string | null = null;
  #abstained = 0;
  #decidedBy: Record<string, number> = {};
  #degraded = false;
  #degradedReason: string | null = null;
  /** Distinct periods of unrecovered blindness — the reported number. See `ApprovalSummary`
   * for exactly what it does and does not count; it is NOT a count of stream drops, and it is
   * NOT the staleness guard (that is `#blindEpoch`, and conflating the two was a real bug). */
  #blindWindows = 0;
  /**
   * THE STALENESS GUARD for `#relist`: a monotonic counter bumped on EVERY degradation signal,
   * whether or not it opens a new window.
   *
   * IT MUST NOT BE `#blindWindows` (review finding 1, reproduced by the reviewer). That one
   * only moves on the `false → true` transition, and `degraded` only clears inside `#relist` —
   * so the exact case the guard exists for, a snapshot in flight across a SECOND drop while
   * still degraded, moved it not at all. The comparison passed on a stale snapshot and cleared
   * `degraded` from a view of the world older than the last outage, asserting sight the bridge
   * did not have. `#bus.connected` does not save it either: the reconnect backoff is 250ms–2s,
   * comfortably faster than a control-plane GET. A separate always-incrementing counter is the
   * whole fix.
   */
  #blindEpoch = 0;
  #recovered = 0;

  constructor(opts: {
    settings: ApprovalSettings;
    gatedTools: string[];
    channels: string[];
    context: ApprovalContext;
    armed: boolean;
    file?: string;
    elicitation?: ElicitationRequester;
    /** The log dir whose `watchers/` holds terminal presence. Consulted LIVE (not at arm
     * time) when deciding whether an elicitation `cancel` may abstain — see `#onAsked`. */
    watchLogDir?: string;
    /** Test seam: a stub `fetch` so the reply path is asserted without a real serve. */
    fetchImpl?: typeof fetch;
  }) {
    this.#settings = opts.settings;
    this.#gatedTools = [...opts.gatedTools];
    this.#channels = [...opts.channels];
    this.#ctx = opts.context;
    this.#armed = opts.armed;
    this.#file = opts.file;
    this.#elicitation = opts.elicitation;
    this.#watchLogDir = opts.watchLogDir;
    this.#fetchImpl = opts.fetchImpl ?? fetch;
  }

  /**
   * Subscribe to this session's permission events, and WAIT for the stream to be attached.
   *
   * THIS ONE THROWS, unlike the activity recorder's attach — and the asymmetry is the whole
   * point. A blind activity recorder costs a trace; a blind APPROVER costs the turn: it
   * would never see `permission.asked`, never reply, and the call would hang until
   * `GUILD_MESSAGE_TIMEOUT_MS` (probe P3: opencode waits, it does not auto-reject). Failing
   * the call with a message naming the reason is strictly better than a 15-minute silence.
   *
   * The wait is bounded by `SHORT_HTTP_MS` so a serve that accepts TCP and never answers
   * cannot wedge the call here either.
   */
  async attach(baseUrl: string, sessionId: string): Promise<() => void> {
    if (this.#closed) return () => {};
    this.#baseUrl = baseUrl;
    this.#sessionId = sessionId;
    let attached = false;
    try {
      const bus = ServeEventBus.acquire(baseUrl);
      this.#bus = bus;
      const handlers: BusHandlers = {
        onEvent: (e) => this.handleEvent(e),
        // A bridge that goes blind must SAY so and reject what is open (review finding M6).
        onDegraded: (reason) => this.degrade(reason),
        // …and when it can see again, go and find what it missed (issue #91). Fire-and-forget
        // by construction, with the rejection swallowed explicitly: the bus does not await
        // this, so an escape would be an unhandled rejection in a process that must stay up.
        // `#relist` already turns every failure it can name into a recorded degradation.
        onReattached: () => {
          void this.reattached().catch(() => {
            /* nothing a re-list can fail at may reach the call */
          });
        },
      };
      this.#unsubscribe = bus.subscribe(sessionId, handlers);
      // The activity recorder normally awaits this first (they share one refcounted bus), so
      // this usually resolves instantly — but with `GUILD_ACTIVITY=off` there is no recorder
      // and this is the ONLY wait, which is exactly when skipping it would drop the first
      // request of the turn.
      const ok = await Promise.race([
        bus.ready(),
        new Promise<false>((resolve) => {
          const t = setTimeout(() => resolve(false), SHORT_HTTP_MS);
          if (typeof t.unref === "function") t.unref();
        }),
      ]);
      attached = ok === true;
    } catch {
      attached = false;
    }
    if (!attached) {
      this.close();
      throw new Error(
        "the approval bridge is armed but could not attach to opencode's event stream, so it " +
          "would never SEE a permission request — and an unanswered request does not fail " +
          "closed under `opencode serve`, it HANGS the turn. Failing the call instead. " +
          "Check that the opencode serve child is healthy, or set GUILD_APPROVE=off.",
      );
    }
    return () => this.close();
  }

  /** Detach. Any request still open is REJECTED first — a bridge going away must never
   * leave the model waiting on a prompt nobody will ever see. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const [permissionId, timer] of [...this.#pending]) {
      clearTimeout(timer);
      this.#pending.delete(permissionId);
      this.#settleDetached(
        permissionId,
        "reject",
        "closed",
        "the ModelGuild approval bridge closed with this request unanswered (the turn ended " +
          "or failed) — rejected, fail-closed",
      );
    }
    try {
      this.#unsubscribe?.();
    } catch {
      /* best-effort */
    }
    try {
      this.#bus?.release();
    } catch {
      /* best-effort */
    }
    this.#unsubscribe = undefined;
    this.#bus = undefined;
  }

  summary(): ApprovalSummary {
    return {
      armed: this.#armed,
      tier: this.#settings.tier,
      egress: this.#settings.egress,
      gatedTools: [...this.#gatedTools],
      effectiveTools: effectiveGatedFamily(this.#gatedTools),
      channels: [...this.#channels],
      timeoutMs: this.#settings.timeoutMs,
      requests: this.#seen.size,
      approved: this.#approved,
      rejected: this.#rejected,
      timedOut: this.#timedOut,
      externallyAnswered: this.#external,
      contested: this.#contested,
      refused: this.#refused,
      undelivered: this.#undelivered,
      unsettled: this.#unsettledIds.size,
      unsettledReason: this.#unsettledReason,
      abstained: this.#abstained,
      decidedBy: { ...this.#decidedBy },
      degraded: this.#degraded,
      degradedReason: this.#degradedReason,
      blindWindows: this.#blindWindows,
      recovered: this.#recovered,
      file: this.#wrote ? (this.#file ?? null) : null,
      note: HONEST_BOUND,
    };
  }

  /**
   * The router's ONLY input: one normalized event from the bus.
   *
   * Public because it IS the real entry point — `attach` wires the bus straight to it — so a
   * test that drives it exercises the same code an event stream would, rather than reaching
   * past the router into private state and proving something else.
   */
  handleEvent(e: ActivityEvent): void {
    if (this.#closed) return;
    if (e.kind === "permission-asked") this.#onAsked(e);
    else if (e.kind === "permission-replied") this.#onReplied(e);
  }

  /** The bus's degradation signal, public for the same reason as `handleEvent`. */
  degrade(reason: string): void {
    this.#onDegraded(reason);
  }

  /**
   * The bus's re-attach signal (issue #91), public for the same reason as `handleEvent`, and
   * returning the in-flight re-list so a test can await it deterministically. Production
   * callers (the bus handler) ignore the promise — see `#relist` for why that is safe.
   */
  reattached(): Promise<void> {
    return this.#relist();
  }

  // --- internals ----------------------------------------------------------

  /**
   * The event stream was lost while this bridge is ARMED (review finding M6).
   *
   * Two things follow, and both are load-bearing. (1) Every request still open must be
   * REJECTED now: a blind bridge will never see its `permission.replied`, so leaving it open
   * means the model blocks on a prompt this process can no longer route. (2) The degradation
   * must be SURFACED, because a blind bridge also cannot see FUTURE requests — a later
   * `requests: 0` would otherwise read as "the model asked for nothing" when it means "we
   * went blind". The same rule the visibility layer states for `activity.degraded`.
   *
   * WHAT THIS DELIBERATELY DOES NOT DO: kill the turn. A stream drop is not evidence that the
   * model is doing anything wrong, the bus reconnects on its own, and (issue #91) the bridge
   * re-lists opencode's open requests when it does — so the window a request can be raised in
   * unseen is the reconnect backoff, with `GUILD_MESSAGE_TIMEOUT_MS` still the backstop behind
   * that. Aborting on a transport blip would trade a bounded delay for a lost turn.
   */
  #onDegraded(reason: string): void {
    if (this.#closed) return;
    // EVERY signal moves the epoch — including a repeat inside a window this bridge has not
    // recovered from. That is the whole of review finding 1: the reported window count cannot
    // double as the staleness guard, because it deliberately does not move here.
    this.#blindEpoch += 1;
    // A TRANSITION opens a new reported window; a repeat inside one (the bus degrades on every
    // failed reconnect attempt) does not. The count is what survives a later recovery.
    if (!this.#degraded) {
      this.#degraded = true;
      this.#blindWindows += 1;
      // The reason belongs to THIS window: it names what was actually lost, not the latest
      // retry — and not a previous window that has since been recovered from.
      this.#degradedReason = reason;
    }
    for (const [permissionId, timer] of [...this.#pending]) {
      clearTimeout(timer);
      this.#pending.delete(permissionId);
      this.#settleDetached(
        permissionId,
        "reject",
        "degraded",
        `ModelGuild lost opencode's event stream while this request was open (${reason}), so ` +
          `it could no longer be routed to a human — rejected, fail-closed`,
      );
    }
  }

  /**
   * THE RE-LIST (issue #91). The stream is back; ask opencode what it is still holding open
   * and route this session's requests as if their events had arrived.
   *
   * WHY IT IS NEEDED AT ALL. SSE has no replay. A request raised while this bridge was blind
   * is not in the reconnected stream, so before this it was never prompted, never recorded and
   * never rejected on the approval clock — it simply waited on `GUILD_MESSAGE_TIMEOUT_MS`
   * (15 min) instead of `GUILD_APPROVE_TIMEOUT_MS` (120 s). Nothing ran ungated meanwhile
   * (opencode holds the call at its `ask`), so the cost was a stall — but a silent 15-minute
   * stall in the one mode whose purpose is keeping a human in the loop is how a feature gets
   * switched off.
   *
   * WHAT IT DOES NOT PROMISE. `GET /permission` lists what is still OPEN. A request raised and
   * settled by another answerer during the blind window is gone from it, and this bridge will
   * never have seen it. **"Recovered on reconnect", never "never missed"** — which is why
   * `blindWindows` is latched on the summary even after `degraded` clears.
   *
   * THE SESSION FILTER IS LOAD-BEARING, NOT TIDINESS. The endpoint is global to the serve
   * child (its own `/doc`: "across all sessions"), and a `guild_panel` runs several sessions
   * on one child. Answering another member's request would be this bridge deciding on behalf
   * of a session it does not own. `listPendingPermissions` takes the session id as a required
   * argument so the filter cannot be forgotten, and the normalized event's own session id is
   * checked again here.
   *
   * IT MAY NOT THROW, EVER. It runs from a bus callback and from a promise the bus does not
   * await, so an escape would be an unhandled rejection in a process that must stay up — and
   * a stream failure must never become a call failure. A failed `GET /permission` is recorded
   * and leaves the bridge degraded, which is the truthful state: we still cannot say we can
   * see. It also NARROWS nothing and WIDENS nothing: every decision still goes through
   * `#onAsked` → the channels → `#settle`, so both mechanical invariants (never emit `allow`,
   * never gate a tool the def denies) are untouched — this path decides nothing at all.
   */
  async #relist(): Promise<void> {
    if (this.#closed || this.#baseUrl.length === 0 || this.#sessionId.length === 0) return;
    // THE STALENESS GUARD. Any degradation signal at all while the GET is in flight makes this
    // snapshot a view of a world older than the last outage, and it must not then be used to
    // assert sight. `#blindEpoch`, NOT `#blindWindows`: see the field comment — the reported
    // window count does not move on a second drop inside an unrecovered window, which is
    // precisely the case this guard exists for.
    const epoch = this.#blindEpoch;
    let listed: Awaited<ReturnType<typeof listPendingPermissions>>;
    try {
      listed = await listPendingPermissions({
        baseUrl: this.#baseUrl,
        sessionId: this.#sessionId,
        fetchImpl: this.#fetchImpl,
      });
    } catch (err) {
      this.#write({
        kind: "relist-failed",
        error: (err as Error).message,
        note:
          "the event stream re-attached but opencode's open-request list could not be read, " +
          "so a request raised while blind may still be unseen — this bridge stays degraded, " +
          "and such a request waits on the model-turn timeout",
      });
      return;
    }
    if (this.#closed) return;

    let recovered = 0;
    let unsettled = 0;
    let unusable = 0;
    for (const req of listed.pending) {
      // PER-ENTRY CONTAINMENT (review finding 4). One bad entry must not abort the entries
      // after it AND skip the records below, turning a recovery silently partial. Nothing here
      // is expected to throw — `normalizeServeEvent` is total for these inputs and `#write` is
      // already guarded — so this is the module's own per-item standard applied rather than a
      // known failure being caught; a throw counts as an unusable entry, which keeps the
      // bridge degraded.
      try {
        this.#relistOne(req, {
          recovered: () => (recovered += 1),
          unsettled: () => (unsettled += 1),
          unusable: () => (unusable += 1),
        });
      } catch (err) {
        unusable += 1;
        this.#write({
          kind: "relist-unusable",
          permission_id: req.id,
          error: (err as Error).message,
          note: "this entry threw while being routed; the rest of the list was still processed",
        });
      }
    }
    this.#recovered += recovered;

    // CLEARING `degraded` IS A CLAIM, so it is made only on evidence (issue #91): the stream
    // is attached again, opencode answered, everything it listed for this session is now
    // routed, and nothing we had already decided is still sitting open. Any of those missing
    // and the flag stays — an over-reported degradation costs a caveat, an under-reported one
    // costs the caller's trust in every counter beside it.
    //
    // `listed.malformed` is OUR session's unusable entries only, and `listed.unattributable`
    // the ones that name no session at all (review finding 3): another member's broken entry
    // must never gate this bridge's recovery, but one that could not be attributed might be
    // ours, so it still does.
    const clean =
      listed.malformed === 0 &&
      listed.unattributable === 0 &&
      unsettled === 0 &&
      unusable === 0 &&
      this.#blindEpoch === epoch &&
      this.#bus?.connected === true;
    this.#write({
      kind: "relist",
      pending: listed.pending.length,
      recovered,
      other_sessions: listed.otherSessions,
      malformed: listed.malformed,
      unattributable: listed.unattributable,
      unsettled,
      unusable,
      clean,
    });
    if (clean && this.#degraded) {
      this.#degraded = false;
      this.#write({
        kind: "stream-recovered",
        blind_windows: this.#blindWindows,
        note:
          "the event stream re-attached and opencode's open requests were re-listed clean, so " +
          "this bridge can see again. It does NOT mean nothing was missed: a request raised " +
          "AND settled by another answerer while blind leaves nothing to recover",
      });
    }
  }

  /** One re-listed entry. Split out of `#relist` purely so each entry can be contained
   * individually (review finding 4) without nesting the whole body in a `try`. */
  #relistOne(
    req: PendingPermission,
    count: { recovered: () => void; unsettled: () => void; unusable: () => void },
  ): void {
    const permissionId = req.id;
    if (this.#outcome.has(permissionId) || this.#claimed.has(permissionId)) {
      // WE ALREADY ANSWERED THIS ONE — typically the reject `#onDegraded` sent — and opencode
      // is still holding it, so that reply did not take effect. It is NOT re-prompted: putting
      // a request the developer has already answered back in front of them is exactly the bug
      // the dedup exists to prevent. Recorded instead, and it keeps the bridge degraded,
      // because a decision of ours is demonstrably unresolved.
      count.unsettled();
      // ...and it is the SAME condition the 404 re-check detects (issue #97): a decision this
      // bridge took that opencode did not act on. It goes to the same counter, deduplicated by
      // id, so `unsettled` means one coherent thing however it was discovered — this arm used
      // to be recorded in the log and counted nowhere, which is exactly the "a quiet counter
      // absorbs a systematic failure" shape #97 is about.
      this.#markUnsettled(
        permissionId,
        "opencode still lists a request this bridge had already answered as OPEN, so that " +
          "reply did not take effect",
      );
      this.#write({
        kind: "relist-unsettled",
        permission_id: permissionId,
        note:
          "this request was already answered by this bridge but opencode still lists it as " +
          "open — the reply did not take effect. NOT re-prompted (it has been decided once " +
          "already); it will settle on opencode's side or expire with the turn",
      });
      return;
    }
    // Already open here: it is on the approval clock and has been prompted. Nothing to do.
    if (this.#pending.has(permissionId)) return;

    // ONE NORMALIZER, NOT TWO. A `GET /permission` entry is field-for-field the `properties`
    // payload of a `permission.asked` frame (both captured from opencode 1.18.7), so it is
    // fed through the same function the stream path uses rather than hand-mapped into a
    // second shape that could drift from the one the tests pin.
    const e = normalizeServeEvent({ type: "permission.asked", properties: req });
    if (
      e === undefined ||
      e.kind !== "permission-asked" ||
      e.permissionId !== permissionId ||
      e.sessionId !== this.#sessionId
    ) {
      count.unusable();
      this.#write({
        kind: "relist-unusable",
        permission_id: permissionId,
        note: "opencode listed this request in a shape this build could not route",
      });
      return;
    }
    count.recovered();
    this.#write({
      kind: "relisted",
      permission_id: permissionId,
      note:
        "raised while this bridge was blind and recovered from opencode's open-request list " +
        "on re-attach; the approval timeout starts NOW, from when it was seen — not from " +
        "when opencode raised it",
    });
    // `detail` mirrors what the bus attaches to a streamed event, so the prompt the developer
    // reads is assembled from the same fields either way.
    this.handleEvent({ ...e, detail: req });
  }

  /** Is a channel OTHER than elicitation able to answer right now? Checked LIVE rather than
   * from the arm-time channel list, so a watcher that has since died correctly counts as
   * absent (and elicitation's cancel then settles, preserving fail-closed). */
  #otherChannelLive(): boolean {
    if (this.#watchLogDir === undefined) return false;
    try {
      return liveApprovalWatchers(this.#watchLogDir).length > 0;
    } catch {
      return false;
    }
  }

  #onAsked(e: ActivityEvent): void {
    const permissionId = e.permissionId;
    // No id ⇒ no way to reply. Recording it is all this bridge can honestly do; the model
    // will block until GUILD_MESSAGE_TIMEOUT_MS, which is why the id is required by the
    // opencode schema and why a build that omits it must be visible in the record.
    if (permissionId === undefined || permissionId.length === 0) {
      this.#write({ kind: "unroutable", summary: e.summary });
      return;
    }
    if (this.#outcome.has(permissionId) || this.#pending.has(permissionId)) return;
    this.#seen.add(permissionId);

    // Both are model-controlled strings heading for a terminal and an elicitation message,
    // so both are sanitized (control characters ⇒ U+FFFD) before they are rendered anywhere.
    const tool = oneLine(e.permissionTool ?? e.tool ?? "", 40);
    const detail = summarizePermission(e);
    const deadline = new Date(Date.now() + this.#settings.timeoutMs).toISOString();
    this.#write({
      kind: "asked",
      permission_id: permissionId,
      session_id: e.sessionId,
      base_url: this.#baseUrl,
      tool,
      detail,
      timeout_ms: this.#settings.timeoutMs,
      deadline,
    });

    // FAIL-CLOSED TIMER, armed FIRST so no later throw can leave a request unbounded.
    const timer = setTimeout(() => {
      this.#pending.delete(permissionId);
      this.#settleDetached(
        permissionId,
        "reject",
        "timeout",
        `no human answered within ${this.#settings.timeoutMs}ms — ModelGuild rejected this ` +
          `tool call (fail-closed). Continue without it, or explain what you needed it for.`,
      );
    }, this.#settings.timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    this.#pending.set(permissionId, timer);

    // Channel 1: elicitation. Fire-and-forget — its answer races the watch terminal and the
    // timeout, and `#settle` makes whoever lands first the winner.
    if (this.#elicitation?.available === true) {
      // ALL the context lives in the message: the form deliberately has no fields, so the
      // client's Accept/Decline buttons are the decision (see `makeElicitationRequester`).
      const message = elicitationMessage({
        command: this.#ctx.command,
        model: this.#ctx.model,
        tool,
        detail,
        timeoutMs: this.#settings.timeoutMs,
      });
      void this.#elicitation
        .ask({ message, timeoutMs: this.#settings.timeoutMs })
        .then((action) => {
          if (action === "accept") {
            this.#settleDetached(permissionId, "once", "elicitation");
            return;
          }
          if (action === "decline") {
            // An EXPLICIT no always settles, whatever else is listening.
            this.#settleDetached(
              permissionId,
              "reject",
              "elicitation",
              "the developer declined this tool call",
            );
            return;
          }
          // CANCEL. Headless Claude Code auto-answers `cancel` in milliseconds (probed), so
          // treating it as an immediate reject let elicitation PRE-EMPT the watch terminal:
          // with both channels believed present, every gated call auto-rejected before the
          // developer's window even opened (review finding H2, reproduced — settled in 49ms
          // against a 120s deadline). So a cancel ABSTAINS while another live channel could
          // still answer; the fail-closed timer is still running, so nothing is left open.
          // When elicitation is the SOLE channel, cancel still REJECTS — a cancel is never
          // consent, and fail-closed is preserved exactly where it was load-bearing.
          if (this.#otherChannelLive()) {
            this.#abstained += 1;
            this.#write({
              kind: "abstained",
              permission_id: permissionId,
              by: "elicitation",
              note:
                "the MCP client cancelled (headless clients auto-cancel), and a live " +
                "`modelguild watch --approve` terminal can still answer — deferring to it " +
                "rather than pre-empting it. The fail-closed timeout still applies.",
            });
            return;
          }
          this.#settleDetached(
            permissionId,
            "reject",
            "elicitation",
            "the approval prompt was cancelled (or auto-cancelled by a headless client) and " +
              "no other channel could answer — rejected, fail-closed",
          );
        })
        .catch(() => {
          /* makeElicitationRequester never rejects; a custom one that does is ignored and
             the timeout still settles the request */
        });
    }
  }

  /** opencode reported a reply — ours, or somebody else's (the watch terminal). */
  #onReplied(e: ActivityEvent): void {
    const permissionId = e.permissionId;
    if (permissionId === undefined) return;
    const timer = this.#pending.get(permissionId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.#pending.delete(permissionId);
    }
    // A reply for an id we never saw asked is still a REQUEST that happened (review finding
    // L11: counting only asks could report `requests: 0, approved: 1`).
    this.#seen.add(permissionId);
    if (this.#outcome.has(permissionId)) return; // already recorded (often our own 2xx)
    const reply = e.permissionReply ?? "?";
    // Reaching here means we have NOT recorded an outcome — so our own reply either never
    // went out or lost its race (a 404), and somebody else's answer is what opencode acted
    // on. Attribute it OUTSIDE this process in both cases: opencode's event is the authority
    // on who won, and claiming our own attempted decision here is precisely the lie review
    // finding M5 was about.
    this.#recordOutcome(permissionId, reply, "external", {
      note: "answered outside this server — normally the `modelguild watch --approve` terminal",
    });
  }

  /**
   * Record a SETTLED outcome exactly once, from evidence. Every counter in `summary()` is
   * derived here, so a reply that never landed can never be reported as a decision.
   */
  #recordOutcome(
    permissionId: string,
    decision: string,
    by: ApprovalDecidedBy,
    extra: Record<string, unknown> = {},
  ): void {
    if (this.#outcome.has(permissionId)) return;
    this.#outcome.set(permissionId, { decision, by });
    this.#seen.add(permissionId);
    if (decision === "reject") this.#rejected += 1;
    else this.#approved += 1;
    if (by === "timeout") this.#timedOut += 1;
    if (by === "external") this.#external += 1;
    this.#decidedBy[by] = (this.#decidedBy[by] ?? 0) + 1;
    this.#write({ kind: "decided", permission_id: permissionId, decision, by, ...extra });
  }

  /**
   * Reply to opencode, exactly once per permission id.
   *
   * TWO ENDPOINTS, EACH FOR A REASON (both probed on 1.18.7):
   *   - APPROVE → `POST /session/{sessionID}/permissions/{permissionID}` `{response:"once"}`.
   *     Session-scoped, so it cannot answer another session's request by mistake — the
   *     safer endpoint, and an approval is the direction where a mistake matters most.
   *   - REJECT  → `POST /permission/{requestID}/reply` `{reply:"reject", message}`. This is
   *     the only one that carries a MESSAGE, and the message reaches the model verbatim
   *     (probe P3): a rejection it can read and reason around beats a bare denial. The
   *     cross-session risk is bounded by the caller — `#handle` only ever sees events the
   *     bus routed to THIS session.
   *
   * THE OUTCOME IS RECORDED FROM THE RESPONSE, NOT FROM THE ATTEMPT (review finding M5): a
   * 2xx settles it, a transport failure (nothing came back) is `undelivered`, and ANY non-2xx
   * opencode answered is CHECKED rather than assumed (issue #97) — see the refusal branch
   * below. The old code counted before the POST and could claim a rejection that never landed.
   *
   * `always` is NEVER sent by this bridge. It persists past the call, so only a human
   * explicitly choosing it (at the watch terminal) may produce one.
   *
   * BOTH ARE v1 ENDPOINTS, AND THAT IS A DECISION (issue #93) — do not "modernize" either
   * onto the v2 permission endpoints. **These two endpoints cannot settle a v2 request at
   * all:** against a live pending v2 request both answer **404 `PermissionNotFoundError`**
   * (verified on 1.18.7), so a half-migrated bridge would prompt the developer, take their
   * answer, and be unable to deliver it, while the turn blocks to `GUILD_MESSAGE_TIMEOUT_MS`.
   * The refusal branch's still-open check does NOT rescue that case — the v1 list is the wrong
   * store for a v2 request, so it reads as absent (`still_open: false`); what catches a
   * half-migration is C69's stored-ruleset check and the pin itself, not a counter. **The
   * approve endpoint is also the one operation opencode marks `deprecated` in 1.18.7**; what
   * to do when it is removed is in the V1 PIN block in `src/client.ts`, which holds the whole
   * record. Re-probe with `bash modelguild/verify-permission-surface.sh`.
   */
  /**
   * `#settle`, fire-and-forget, with the rejection swallowed EXPLICITLY.
   *
   * Every caller is fire-and-forget — a fail-closed timer, `close()`, the degraded sweep, an
   * elicitation `.then` — so none of them is in a position to handle a rejection, and since
   * issue #91 one of those timers is armed from a bus callback. `#settle` is written not to
   * reject (its network call sits inside a `try`; `#write` and `#recordOutcome` are guarded),
   * so this is the module's stated posture applied rather than a known failure being caught:
   * nothing on the decision path may become an unhandled rejection in a process that has to
   * stay up. The promise is `void`-ed in exactly one place — here — so no call site can forget
   * to do it.
   */
  #settleDetached(
    permissionId: string,
    response: "once" | "reject",
    by: ApprovalDecidedBy,
    message?: string,
  ): void {
    void this.#settle(permissionId, response, by, message).catch(() => {
      /* a settle that fails has already recorded whatever it could; it must never escape */
    });
  }

  async #settle(
    permissionId: string,
    response: "once" | "reject",
    by: ApprovalDecidedBy,
    message?: string,
  ): Promise<void> {
    if (this.#claimed.has(permissionId) || this.#outcome.has(permissionId)) return;
    this.#claimed.add(permissionId);
    this.#seen.add(permissionId);
    const timer = this.#pending.get(permissionId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.#pending.delete(permissionId);
    }

    let status = 0;
    let error = "";
    try {
      const res =
        response === "once"
          ? await this.#post(
              `/session/${encodeURIComponent(this.#sessionId)}/permissions/${encodeURIComponent(permissionId)}`,
              { response: "once" },
            )
          : await this.#post(`/permission/${encodeURIComponent(permissionId)}/reply`, {
              reply: "reject",
              message: message ?? "rejected by ModelGuild",
            });
      status = res.status;
    } catch (err) {
      error = (err as Error).message;
    }

    if (status >= 200 && status < 300) {
      this.#recordOutcome(permissionId, response === "once" ? "once" : "reject", by, {
        message: message ?? null,
        http_status: status,
      });
      return;
    }
    // OPENCODE ANSWERED, AND REFUSED. **Any** non-2xx status it returned, not just a 404
    // (widened by review, 2026-07-29; the first cut of issue #97 keyed on 404 alone).
    //
    // WHAT IS OBSERVED: opencode will not accept this reply for this id. Two very different
    // situations produce that byte-identically, and until issue #97 this branch could not tell
    // them apart:
    //
    //   1. A GENUINE RACE — another answerer (normally the `modelguild watch --approve`
    //      terminal) got there first, opencode arbitrated, and their `permission.replied` is
    //      the authority. Routine and healthy; nothing is stuck. (This reading belongs to the
    //      404 specifically — it is the status a settled/unknown id answers.)
    //   2. THE REPLY DID NOT LAND — the request is still open and nobody's decision reached
    //      it. `POST /session/{id}/permissions/{permId}` is the ONE operation opencode marks
    //      `deprecated` on 1.18.7, so its removal fails every APPROVAL while rejections keep
    //      working: an approval-only outage in which the developer says yes, nothing happens,
    //      and the turn stalls to `GUILD_MESSAGE_TIMEOUT_MS`. A v2-issued request id 404s here
    //      for a related reason (still open, wrong store — see the V1 PIN in `src/client.ts`).
    //
    // WHY THE WHOLE NON-2xx RANGE AND NOT JUST 404 (review finding, 2026-07-29). A removed
    // route does not have to answer 404: a path that still matches the method table gives
    // **405**, a deliberately retired endpoint gives **410**, a proxy or rewritten API gives
    // **501**, and a serve mid-failure gives **5xx**. 404 is the LIKELIEST shape of the expiry
    // condition, not the only one — and the arm those other codes used to fall into was
    // `undelivered`, whose note ASSERTED "this reply did not reach opencode", which is simply
    // false when opencode answered 410. That is the same ambiguity this issue removed from
    // `contested`, one branch over. NO status is excluded: a 500 can leave the request open
    // exactly as a 410 can, the question asked is a question of fact rather than of status
    // semantics, and the price is one bounded, already-guarded GET on a path that has by
    // definition just failed.
    //
    // SO IT IS CHECKED, NOT ASSUMED. `GET /permission` — the same v1 snapshot the #91 re-list
    // reads, filtered to this session — answers whether the id is STILL OPEN. Still open ⇒ the
    // decision was not delivered, counted under `unsettled`, whose whole purpose is that a
    // quiet counter can never absorb a systematic approval failure. Not open ⇒ nothing is
    // stuck, and the CAUSE is only named where the status supports it: a 404 is `contested`
    // (the documented race), any other status is `refused` — observed, not diagnosed. The
    // check unable to answer (an unreachable serve, a garbage body, an entry we could not
    // attribute) is `still_open: null` and is never upgraded to a claim either way.
    //
    // THE CHECK IS NOT RESTRICTED TO THE APPROVE PATH even though only that endpoint carries a
    // known expiry condition: a reject refused while the request stays open leaves the model
    // blocked in exactly the same way.
    //
    // WHAT IS DELIBERATELY NOT DONE: a confirmed-undelivered APPROVAL is not retried as a
    // REJECT down the endpoint that still works. That would unstick the turn by inverting a
    // decision the developer did make into one they did not — this bridge may fail closed on
    // silence, never convert a human's yes into a no. It stalls visibly instead, counted and
    // named.
    if (status > 0) {
      const stillOpen = await this.#stillOpen(permissionId);
      if (stillOpen === true) {
        this.#markUnsettled(
          permissionId,
          `opencode answered HTTP ${status} to this bridge's '${response}' reply and still ` +
            `lists the request as OPEN, so the decision was not delivered` +
            (response === "once"
              ? ` — on the APPROVE endpoint (POST /session/{id}/permissions/{permId}), the one ` +
                `operation opencode 1.18.7 marks deprecated. If this repeats, approvals are ` +
                `failing while rejections still land: re-probe with ` +
                `\`bash modelguild/verify-permission-surface.sh\` and see CONTRACT C69a.`
              : `.`),
        );
        this.#write({
          kind: "not-delivered",
          permission_id: permissionId,
          attempted: response,
          by,
          http_status: status,
          still_open: true,
          note:
            `opencode refused this reply (HTTP ${status}) AND still lists the request as open ` +
            `— this is NOT the documented lost race: nobody's decision reached it. The request ` +
            `stays open until the model-turn timeout, and it is counted under \`unsettled\``,
        });
        return;
      }
      // NOT CONFIRMED OPEN. Nothing is known to be stuck — but the RACE reading is a 404's, so
      // it is claimed only for a 404. Stretching `contested` over a 410 would re-create exactly
      // the overload this change removed, so any other status is `refused`: observed, undiagnosed.
      if (status === 404) this.#contested += 1;
      else this.#refused += 1;
      this.#write({
        kind: "not-delivered",
        permission_id: permissionId,
        attempted: response,
        by,
        http_status: status,
        still_open: stillOpen,
        counted_as: status === 404 ? "contested" : "refused",
        note:
          stillOpen === false
            ? status === 404
              ? "opencode did not accept this reply for this request id (404) and does not list the request among its open ones — consistent with the documented lost race: another answerer settled it first, and their reply, not this one, was the decision. (The list read is the v1 open-request snapshot, so a request raised on a DIFFERENT permission surface would also read as absent here — see CONTRACT C69a.)"
              : `opencode refused this reply with HTTP ${status} and does not list the request among its open ones. Nothing is stuck, but no cause is claimed: the lost-race reading belongs to a 404, and this was not one. Counted as \`refused\` rather than stretched into \`contested\``
            : `opencode refused this reply (HTTP ${status}), and whether the request is still open could NOT be established — the open-request check failed, or opencode listed an entry that could not be attributed and might be this one. Recorded as unconfirmed rather than classified; either way this reply was NOT the decision`,
      });
      return;
    }
    // NOTHING CAME BACK AT ALL — the fetch threw, so opencode's state is genuinely unknown and
    // there is no status to reason from. This is the ONLY arm `undelivered` covers, and it is
    // left exactly as it was. (The still-open check is deliberately not run here: it would be
    // asking a serve we have just failed to reach, and a `null` answer would add nothing the
    // absent status does not already say.)
    this.#undelivered += 1;
    this.#write({
      kind: "not-delivered",
      permission_id: permissionId,
      attempted: response,
      by,
      http_status: null,
      error: error || null,
      note: "this reply did not reach opencode; the request may still be open until the model-turn timeout",
    });
  }

  /**
   * IS THIS REQUEST STILL OPEN? (issue #97) — `true` / `false` / `null` for "could not tell".
   *
   * The one extra observation that makes a refused reply diagnosable. It reads the SAME v1 snapshot the
   * #91 re-list reads (`GET /permission`, filtered to this session by `listPendingPermissions`,
   * whose session argument is mandatory precisely because the endpoint is global to the serve
   * child — on a panel, answering off another member's list would be this bridge deciding for a
   * session it does not own).
   *
   * IT MAY NOT THROW, EVER — same rule as the re-list. It is called from `#settle`, which every
   * caller fires and forgets, so an escape would be an unhandled rejection in a process that
   * must stay up, and a failed control-plane GET must never become a call failure. Every
   * failure answers `null`, which the caller records as "unconfirmed" rather than guessing.
   *
   * `null` ALSO COVERS AN AMBIGUOUS LIST, not just a failed one: an entry opencode listed for
   * this session without a usable `id` (`malformed`), or one naming no session at all
   * (`unattributable`), COULD be the request being asked about — so "absent from `pending`"
   * only means "gone" when the list had neither. Same conservatism as #91's `clean` rule: an
   * unreadable entry is a gap, never evidence.
   *
   * IT DECIDES NOTHING AND SENDS NOTHING. Both C66 invariants (never emit `allow`, never gate a
   * tool the def denies) are untouched by this path — it is a read.
   */
  async #stillOpen(permissionId: string): Promise<boolean | null> {
    if (this.#baseUrl.length === 0 || this.#sessionId.length === 0) return null;
    try {
      const listed = await listPendingPermissions({
        baseUrl: this.#baseUrl,
        sessionId: this.#sessionId,
        fetchImpl: this.#fetchImpl,
      });
      if (listed.pending.some((p) => p.id === permissionId)) return true;
      if (listed.malformed > 0 || listed.unattributable > 0) return null;
      return false;
    } catch {
      return null;
    }
  }

  /** Count a request whose decision opencode did not act on, once per id, and latch the FIRST
   * reason as the loud half of the counter. Both detections of the condition (the 404 re-check
   * and the re-list) funnel through here so `unsettled` cannot double-count or disagree with
   * itself. Guarded like every other record-keeper: it can never fail a call. */
  #markUnsettled(permissionId: string, reason: string): void {
    if (this.#unsettledIds.has(permissionId)) return;
    this.#unsettledIds.add(permissionId);
    if (this.#unsettledReason === null) this.#unsettledReason = reason;
  }

  async #post(pathname: string, body: unknown): Promise<{ status: number }> {
    if (this.#baseUrl.length === 0) return { status: 0 };
    const res = await this.#fetchImpl(`${this.#baseUrl}${pathname}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SHORT_HTTP_MS),
    });
    return { status: res.status };
  }

  #write(fields: Record<string, unknown>): void {
    if (this.#file === undefined) return;
    const line = {
      ts: new Date().toISOString(),
      run_id: this.#ctx.runId,
      call_id: this.#ctx.callId,
      command: this.#ctx.command,
      model: this.#ctx.model,
      agent: this.#ctx.agent,
      ...fields,
    };
    try {
      if (!this.#wrote) mkdirSync(path.dirname(this.#file), { recursive: true });
      appendFileSync(this.#file, `${JSON.stringify(line)}\n`);
      this.#wrote = true;
    } catch {
      /* the record is best-effort; a write failure never fails the call */
    }
  }
}

/** A one-line rendering of what is being asked for — the shell command, the path, whatever
 * opencode put in the request's `patterns`/`metadata`. This is what the developer reads
 * before answering, so it must never be empty when opencode said anything at all. */
export function summarizePermission(e: ActivityEvent): string {
  const d = (e.detail ?? {}) as Record<string, unknown>;
  const meta = (d.metadata ?? {}) as Record<string, unknown>;
  for (const key of ["command", "filePath", "path", "file", "url", "pattern", "title"]) {
    const v = meta[key];
    if (typeof v === "string" && v.length > 0) return oneLine(v);
  }
  const patterns = d.patterns;
  if (Array.isArray(patterns) && patterns.length > 0) {
    return oneLine(patterns.filter((p) => typeof p === "string").join(" "));
  }
  try {
    const json = JSON.stringify(meta);
    return json === undefined || json === "{}" ? "" : oneLine(json);
  } catch {
    return "";
  }
}

/**
 * Strip C0 and C1 control characters, replacing each with U+FFFD.
 *
 * SECURITY, not tidiness (review finding H1, probed 2026-07-28). Everything rendered in an
 * approval prompt — the tool name, the command string, the path — comes out of a permission
 * request the EXTERNAL MODEL's tool call produced. JavaScript's `\s` does **not** include
 * ESC (U+001B), so a whitespace collapse leaves ANSI escape sequences intact: a crafted
 * `metadata.command` carrying cursor-up + erase-line repaints the watcher's terminal so the
 * prompt the developer reads is not the request they are answering. The same string is
 * embedded in the elicitation message. Stripping controls BEFORE the whitespace collapse is
 * what makes the rendered prompt correspond to the request.
 *
 * U+FFFD rather than deletion, deliberately: a stripped byte stays VISIBLE as a replacement
 * character, so a tampering attempt reads as obviously mangled rather than quietly cleaned.
 */
export function sanitizeForDisplay(s: string): string {
  // C0 (\x00-\x1F, incl. ESC \x1B), DEL, and C1 (\x80-\x9F, the 8-bit CSI range).
  return s.replace(/[\u0000-\u001f\u007f-\u009f]/g, "\ufffd");
}

function oneLine(s: string, max = 200): string {
  const flat = sanitizeForDisplay(s).replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

// ---------------------------------------------------------------------------
// Arming — the up-front decision every tool makes before it logs anything
// ---------------------------------------------------------------------------

export type ApprovalRefusalKind = "approval-config" | "approval-channel-missing";

export interface ApprovalRefusal {
  kind: ApprovalRefusalKind;
  message: string;
}

/** What a tool threads into the lifecycle when the bridge is armed. `undefined` arming means
 * "nothing gated for this agent" — the default, and byte-identical behaviour to before. */
export interface ApprovalArming {
  settings: ApprovalSettings;
  ruleset: SessionPermissionRule[];
  gatedTools: string[];
  /** The def-derived allow-set this arming was computed against. Threaded to the WIRE so
   * invariant 2 is enforced there too (review finding M4), and to the stored-ruleset check
   * so a widened session is caught (M7). */
  allowSet: ReadonlySet<string>;
  /** The def file the allow-set was read from — named in messages so it is checkable. */
  agentDefFile: string;
  channels: string[];
  elicitation?: ElicitationRequester;
  /** THE predicate for "is the session opencode will run in genuinely gated?" — passed into
   * `askViaAgent` so `src/client.ts` needs no import from this module and there is exactly
   * one implementation, shipped and tested (review finding M10). */
  checkStored(stored: unknown): { ok: true } | { ok: false; reason: string };
  /** Build this call's bridge. */
  bridge(ctx: ApprovalContext): ApprovalBridge;
}

export type ArmApprovalResult =
  | { ok: true; arming?: ApprovalArming }
  | { ok: false; refusal: ApprovalRefusal };

/**
 * Resolve the knobs, read the allow-set from the agent def IN FORCE, work out what would be
 * gated, and — only if something would be — check that SOME channel can answer.
 *
 * REFUSING UP FRONT IS THE WHOLE POINT (probe P3). An `ask` with nobody listening does not
 * fail closed at opencode; it HANGS the turn until `GUILD_MESSAGE_TIMEOUT_MS` (15 min by
 * default). Deadlocking a delegate call because a terminal was not open is a far worse
 * outcome than a refusal naming the exact fix, and the refusal happens before `log.expect()`
 * so a refused call still logs nothing (C24 gap parity).
 *
 * THE ALLOW-SET COMES FROM THE DEF, NOT FROM A TABLE (review finding H3). If the def cannot
 * be found or parsed, this REFUSES: not arming would be defensible, but running the call
 * ungated while the developer has explicitly asked for gating is the false-safety failure
 * this whole feature exists to avoid. The message names the file so it is fixable.
 */
export function armApproval(opts: {
  agent: string;
  env: NodeJS.ProcessEnv;
  confContents: string;
  /** The dirs the tool's own def-presence pre-check already resolved (project, then the
   * opencode global agent dir) — the same resolution order opencode uses for `--agent`. */
  agentDefDirs: readonly string[];
  /** The evidence log — for `enabled()` (is there anywhere to publish a request?), its
   * `logDir()` (where watcher presence lives) and `dir(runId)` (where the record goes). */
  log: { enabled(): boolean; logDir(): string; dir(runId?: string): string };
  elicitation?: ElicitationRequester;
  /** Test seams. */
  now?: number;
  fetchImpl?: typeof fetch;
}): ArmApprovalResult {
  const knobs = resolveApprovalSettings({ env: opts.env, confContents: opts.confContents });
  if (!knobs.ok) {
    return { ok: false, refusal: { kind: "approval-config", message: knobs.error } };
  }
  const settings = knobs.settings;
  // Nothing requested ⇒ nothing to resolve. Reading the def only when the knob is on keeps
  // the default path byte-identical (and free).
  if (settings.tier === "off" && settings.egress === "off") return { ok: true };

  const resolved = resolveAgentAllowSet(opts.agent, opts.agentDefDirs);
  if (!resolved.ok) {
    return {
      ok: false,
      refusal: {
        kind: "approval-config",
        message:
          `The approval bridge is ARMED (GUILD_APPROVE=${settings.tier}` +
          `${settings.egress === "ask" ? ", GUILD_APPROVE_EGRESS=ask" : ""}) but ModelGuild ` +
          `could not determine what the '${opts.agent}' agent is actually allowed to do: ` +
          `${resolved.reason}. Refusing rather than guessing — the gated set is the ` +
          `INTERSECTION with that def's own allow-set, and gating a tool the def denies would ` +
          `turn a denied tool into an approvable one. Fix the def (or GUILD_AGENT_DIR), or ` +
          `set GUILD_APPROVE=off to run ungated.`,
      },
    };
  }
  const allowSet = resolved.set.allow;

  const gatedTools = gatedToolsFor(allowSet, settings);
  if (gatedTools.length === 0) return { ok: true };

  const ruleset = buildApprovalRuleset({ agent: opts.agent, settings, allowSet });

  // --- channel availability -------------------------------------------------
  const channels: string[] = [];
  if (opts.elicitation?.available === true) channels.push("elicitation");
  const logEnabled = opts.log.enabled();
  const logDir = opts.log.logDir();
  const watchers = logEnabled ? liveApprovalWatchers(logDir, opts.now) : [];
  if (watchers.length > 0) channels.push("watch");

  if (channels.length === 0) {
    const why = !logEnabled
      ? `GUILD_LOG=off, so there is no run directory to publish an approval request into ` +
        `(the watch channel needs one), and`
      : `no live \`modelguild watch --approve\` was found (searched ${watcherDirFor(logDir)}), and`;
    return {
      ok: false,
      refusal: {
        kind: "approval-channel-missing",
        message:
          `The approval bridge is ARMED (GUILD_APPROVE=${settings.tier}` +
          `${settings.egress === "ask" ? ", GUILD_APPROVE_EGRESS=ask" : ""}) and would gate ` +
          `${gatedTools.join("/")} on '${opts.agent}', but NOTHING can answer a request: ` +
          `${why} this MCP client did not advertise the elicitation capability. ` +
          `Refusing up front rather than arming: under \`opencode serve\` an unanswered ` +
          `permission request does NOT fail closed — it HANGS the turn until the model-turn ` +
          `timeout. Fix it by running \`npx modelguild watch --approve\` in another terminal ` +
          `(same project, and with logging on), or set GUILD_APPROVE=off to run ungated.`,
      },
    };
  }

  return {
    ok: true,
    arming: {
      settings,
      ruleset,
      gatedTools,
      allowSet,
      agentDefFile: resolved.set.file,
      channels,
      ...(opts.elicitation !== undefined ? { elicitation: opts.elicitation } : {}),
      checkStored(stored: unknown) {
        return checkStoredRuleset(stored, ruleset, allowSet);
      },
      bridge(ctx: ApprovalContext): ApprovalBridge {
        const bridgeOpts: ConstructorParameters<typeof ApprovalBridge>[0] = {
          settings,
          gatedTools,
          channels,
          context: ctx,
          armed: true,
        };
        if (logEnabled && ctx.runId.length > 0) {
          bridgeOpts.file = path.join(opts.log.dir(ctx.runId), APPROVALS_FILE);
        }
        // Elicitation is only wired when it is one of the channels that passed the check.
        if (channels.includes("elicitation") && opts.elicitation !== undefined) {
          bridgeOpts.elicitation = opts.elicitation;
        }
        // The bridge re-checks watcher presence LIVE when deciding whether an elicitation
        // cancel may abstain, so it needs the dir rather than the arm-time verdict.
        if (logEnabled) bridgeOpts.watchLogDir = logDir;
        if (opts.fetchImpl !== undefined) bridgeOpts.fetchImpl = opts.fetchImpl;
        return new ApprovalBridge(bridgeOpts);
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Diagnostics — what `doctor` and `guild_status` report about the bridge
// ---------------------------------------------------------------------------

/** The approval bridge's configuration as a health check sees it (review finding L12: both
 * diagnostics used to say nothing about it, so "why did my gated call refuse?" and "am I
 * actually gated?" had no token-free answer). */
export interface ApprovalDoctorInfo {
  /** The resolved tier, or null when the knob value is invalid (`error` then says why). */
  tier: ApprovalTier | null;
  egress: ApprovalEgress | null;
  timeoutMs: number | null;
  /** True when the knobs ask for gating at all (before any per-agent intersection). */
  requested: boolean;
  /** Live `modelguild watch --approve` terminals, and where they are looked for. */
  watchers: number;
  watcherDir: string;
  /** Set when the knob value is unusable — the same refusal a call would hit. */
  error: string | null;
}

export function approvalDoctorInfo(opts: {
  env?: NodeJS.ProcessEnv;
  confContents?: string;
  logDir: string;
}): ApprovalDoctorInfo {
  const watcherDir = watcherDirFor(opts.logDir);
  const knobs = resolveApprovalSettings({
    ...(opts.env !== undefined ? { env: opts.env } : {}),
    ...(opts.confContents !== undefined ? { confContents: opts.confContents } : {}),
  });
  let watchers = 0;
  try {
    watchers = liveApprovalWatchers(opts.logDir).length;
  } catch {
    /* a diagnostic must never throw */
  }
  if (!knobs.ok) {
    return {
      tier: null,
      egress: null,
      timeoutMs: null,
      requested: false,
      watchers,
      watcherDir,
      error: knobs.error,
    };
  }
  const s = knobs.settings;
  return {
    tier: s.tier,
    egress: s.egress,
    timeoutMs: s.timeoutMs,
    requested: s.tier !== "off" || s.egress !== "off",
    watchers,
    watcherDir,
    error: null,
  };
}

/* ---------------------------------------------------------------------------
 * PARITY (AGENTS.md → Conventions), recorded here because this module IS the restriction.
 *
 * FORCING QUESTION — would I impose this on an Anthropic subagent doing the same task?
 * YES, and Claude Code already does: in its default permission mode a subagent's
 * Edit/Write/Bash calls surface to the user for approval unless allowlisted. Offering the
 * same on the external write path is PARITY, not a fence.
 *
 * DIRECTION OF THE ASYMMETRY, honestly: with the knob OFF — the shipped default — the
 * external write path is LESS gated than the Claude path under its usual settings. That
 * asymmetry runs in the PERMISSIVE direction, which PARITY permits (default-deny applies to
 * restrictions). Turning it on reaches parity; it does not exceed it, because the gated set
 * is the same set Claude Code gates.
 *
 * NO NEW HARNESS DIFFERENCE IS CLAIMED. `GUILD_APPROVE_EGRESS` leans on the ALREADY-RATIFIED
 * one (reads on the external read paths egress to a third-party vendor) and spends it on an
 * OPT-IN, default-off gate rather than a fence — nothing is removed from the read paths.
 *
 * CAPABILITY COST, STATED: an armed run cannot complete unattended (that is why it is off by
 * default); a timeout-rejected mid-sequence edit can leave a PARTIAL change set (still
 * captured by the delegate snapshot/diff, still recoverable via `capture.recoveryHint`); the
 * gated run costs extra tokens when the model retries around a rejection; and the approval
 * wait is spent inside the SAME `GUILD_MESSAGE_TIMEOUT_MS` budget as the model turn, so a
 * long deliberation eats the turn's clock. And it buys less than it looks like it buys —
 * see HONEST_BOUND above.
 *
 * PROVENANCE: the ask is the MAINTAINER's (issue #20, day one). The tier set, `all`'s
 * existence, and the egress knob are the maintainer's decisions of 2026-07-28. The API facts
 * are probed (P2/P3/P4, re-verified on opencode 1.18.7). The never-emit-`allow` and
 * never-widen invariants, the up-front refusal, and the watcher-presence design are Claude's.
 * --------------------------------------------------------------------------- */
