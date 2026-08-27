/**
 * log.ts — the ModelGuild evidence layer, ported from `log.sh`.
 *
 * WHY A PORT, NOT A REWRITE. The log is the ONLY data source that can be audited instead
 * of Claude's own summary, so its integrity is the whole honesty story. (The automated
 * witness that once read it retired at M12; the receipts remain, for the developer to read.)
 *
 * WHY THE WITNESS WENT AND THE LOG STAYED (maintainer, 2026-07-22 → M12). The *log* is
 * justified: receipts — the other model's actual words kept locally, which found real bugs.
 * The automated witness apparatus was model-recommended machinery the maintainer never
 * demanded, and the parity observation cuts against it (Claude-subagent summaries got no
 * witness and nobody proposed one). So the log is framed receipts-first, and a proposal to
 * re-add an automated auditor has to answer that parity question first.
 * The bash `log.sh` is the oracle (CONTRACT.md area D, C22–C35); this module mirrors its
 * schema, hashing, and verify semantics BYTE-FOR-BYTE so that:
 *   - a TS-written run passes `bash log.sh verify`, and
 *   - a bash-written run passes `verify()` here,
 * and the two writers can even share one run (identical lock protocol + line bytes).
 * The cross-verification is proven in test/log.test.ts, both directions, incl. negatives.
 *
 * WHAT IT IS NOT (inherited from log.sh): not tamper-proofing. The hash chain catches
 * accidental corruption cheaply; anything that can write the log can rewrite the chain.
 *
 * DELIBERATE DIVERGENCES FROM log.sh, each with a reason:
 *   - Prompts/responses are passed as in-memory STRINGS, not file paths. M5+ tools hold
 *     the text already (client.ts `finalAssistantText`), and sha256 of a JS string's
 *     UTF-8 equals sha256 of a file holding those bytes — so hashes cross-verify. The
 *     `$(cat)` trailing-newline scar log.sh warns about cannot recur: no capture step
 *     strips anything (client.ts invariant 2).
 *   - Write methods NEVER throw into the caller (C31 "logging must never fail the call
 *     it records"). They return a `{ ok }` result and warn to stderr on failure —
 *     including a lock timeout, a disk error, or an invalid argument. `verify`/`prune`
 *     are audit/maintenance paths and return results too.
 *
 * MIXED-WRITER RUNS ARE SUPPORTED (no log migration — same schema, mixed-origin
 * logs verify as one run). The `.lock` dir protocol and line format are identical to
 * bash, so bash and TS appends interleave safely; test/log.test.ts pins concurrent
 * distinct-turn behavior and bash↔TS coexistence in a single run.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  appendFileSync,
  writeFileSync,
  statSync,
  lstatSync,
  rmSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
  renameSync,
  readdirSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { isRegularFile } from "./fsguard.js";
import {
  buildEntryLine,
  canonicalStringify,
  recomputeEntryHash,
  sha256Hex,
  sha256HexBytes,
  lineHash,
  type JsonValue,
} from "./canonical.js";
// TYPE-ONLY, and deliberately so: it is erased at compile time, so the evidence layer keeps
// its runtime dependency set (node + fsguard + canonical) exactly as it was, while the
// diagnostics shape stays ONE definition rather than a copy here that drifts from the client's.
import type { TurnDiagnostics } from "./client.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PromptMode = "full" | "hash" | "off";
export type CaptureState = "complete" | "failed";
export type Verdict = "Adopt" | "Adapt" | "Reject" | "Defer";
/** Policy tiers (mirrors `policy.ts` `PolicyTier`; duplicated here to avoid a src-layer
 * import cycle — `config.ts` already imports from `log.ts`). */
export type PolicyTier = "allow" | "ask" | "deny";

/**
 * `tier` / `confirmed` on a `started`/`completed` entry — a DELIBERATE positive-direction
 * addition OVER the bash oracle (bash records neither). Without them, nothing can audit
 * whether an ask-tier model was consulted with claimed user approval. They
 * are OPTIONAL: emitted only when the caller supplies them, so allow-tier and legacy
 * (bash-written) entries carry neither key. Both verifiers accept entries with or without
 * these fields — bash `verify` recomputes `entry_hash` over `del(.entry_hash)` (the whole
 * object, no field whitelist), so extra keys are naturally hashed and never rejected, and
 * TS `verify` recomputes the same way. Cross-verification (both directions) is pinned in
 * test/log.test.ts and test/consult.test.ts.
 */
function policyFields(
  tier: PolicyTier | undefined,
  confirmed: boolean | undefined,
): { [k: string]: JsonValue } {
  const out: { [k: string]: JsonValue } = {};
  if (tier !== undefined) out.tier = tier;
  if (confirmed !== undefined) out.confirmed = confirmed;
  return out;
}

/**
 * `diagnostics` on a `completed` entry — WHY THE REFUSAL WAS MADE, in the receipts (issue #188).
 *
 * C74 has claimed since #173 that an `empty-answer`/`empty-delegation` is "self-diagnosing from
 * the receipts alone". It was not: the diagnostics existed only on the MCP tool result, i.e. in
 * whichever Claude Code transcript happened to make the call, while `calls.jsonl` — the only
 * durable artefact, and what "receipts" means everywhere else here — recorded `exit_code:1` and
 * a byte-exact empty `raw_response` and nothing about the cause. A corpus analysis reads
 * `calls.jsonl`; there was nothing there to read.
 *
 * REBUILT FIELD BY FIELD RATHER THAN SPREAD, for three reasons that all point the same way:
 * the payload must be `JsonValue` (an interface with optional members is not assignable to an
 * index signature); an absent number must stay ABSENT rather than become `null` or `0`, which
 * is the whole point of the shape (C74 — a real zero is the evidence); and a field added to
 * `TurnDiagnostics` later must not reach the log until someone decides it should, because the
 * one thing this must never carry is model CONTENT. `parts` is lengths only, by construction
 * (see `TurnPart`).
 *
 * NEVER THROWS (C31). A diagnostics object that cannot be built — a wrong-shaped value from a
 * caller, a non-finite number — yields `{}`, so the field is simply ABSENT and the entry is
 * the one that would have been written before this existed. Losing a diagnostic is a cost;
 * failing the call that carries it is not on the table.
 *
 * THE INNER KEYS STAY camelCase, AGAINST THIS FILE'S OWN snake_case CONVENTION, and that is a
 * decision rather than an oversight: the point of the field is that the receipt and the tool
 * result cannot disagree, which is a property a test asserts by DEEP-EQUALLING one against the
 * other. Rename a key here and that assertion is no longer available in either direction —
 * every reader would have to hold a translation table, and the drift this closes would reopen
 * one level down. The entry's own top-level fields are unaffected and stay snake_case.
 */
function diagnosticsField(d: TurnDiagnostics | undefined): { [k: string]: JsonValue } {
  if (d === undefined) return {};
  try {
    const out: { [k: string]: JsonValue } = {};
    if (typeof d.toolCallCount === "number" && Number.isFinite(d.toolCallCount)) {
      out.toolCallCount = d.toolCallCount;
    }
    const c = d.completion;
    if (c !== undefined && c !== null) {
      const comp: { [k: string]: JsonValue } = {};
      // Opaque by contract: `finish` has no enum in opencode's own schema (C74), so it is
      // carried as whatever string arrived and no vocabulary is asserted about it.
      if (typeof c.finish === "string") comp.finish = c.finish;
      if (typeof c.cost === "number" && Number.isFinite(c.cost)) comp.cost = c.cost;
      const t = c.tokens;
      if (t !== undefined && t !== null) {
        const tok: { [k: string]: JsonValue } = {};
        for (const k of ["input", "output", "reasoning", "cacheRead", "cacheWrite", "total"] as const) {
          const v = t[k];
          if (typeof v === "number" && Number.isFinite(v)) tok[k] = v;
        }
        if (Object.keys(tok).length > 0) comp.tokens = tok;
      }
      if (Object.keys(comp).length > 0) out.completion = comp;
    }
    if (d.partTypes !== undefined && d.partTypes !== null) {
      const pt: { [k: string]: JsonValue } = {};
      for (const k of Object.keys(d.partTypes)) {
        const v = d.partTypes[k];
        if (typeof v === "number" && Number.isFinite(v)) pt[k] = v;
      }
      if (Object.keys(pt).length > 0) out.partTypes = pt;
    }
    if (Array.isArray(d.parts) && d.parts.length > 0) {
      const parts: JsonValue[] = [];
      for (const p of d.parts) {
        if (p === undefined || p === null || typeof p.type !== "string") continue;
        const one: { [k: string]: JsonValue } = { type: p.type };
        if (typeof p.chars === "number" && Number.isFinite(p.chars)) one.chars = p.chars;
        parts.push(one);
      }
      if (parts.length > 0) out.parts = parts;
    }
    return Object.keys(out).length > 0 ? { diagnostics: out } : {};
  } catch {
    return {};
  }
}

/** Every write method returns this instead of throwing (C31). `ok:false` carries a
 * reason for diagnostics but is NEVER propagated as an exception into the tool call. */
export interface WriteResult {
  ok: boolean;
  error?: string;
}

/** `started` also reports the turn it stamped (position within the run). */
export interface StartedResult extends WriteResult {
  turn?: number;
}

/** `final` reports the calls.jsonl path (bash prints it on stdout). */
export interface PathResult extends WriteResult {
  path?: string;
}

/** Result of `verify`. `code` mirrors log.sh exit codes: 0 ok, 7 integrity failure. */
export interface VerifyResult {
  ok: boolean;
  code: 0 | 7;
  message: string;
}

/** The resolved `GUILD_LOG_RETENTION_DAYS` setting (C35 order: env > conf > default).
 *
 * `days` is the EFFECTIVE window: `0` means "pruning disabled" and is what an explicit
 * `0`, a negative number, AND an unparseable value all resolve to. The last case is a
 * DELIBERATE tightening over the pre-#23 code, which ran `parseInt` and so read
 * `GUILD_LOG_RETENTION_DAYS=fourteen` as NaN (prune: no-op) but `new-run` re-defaulted
 * it to 14 and deleted — two different answers to one typo, the deleting one silent.
 * Fail-safe wins: a value we cannot read is never a licence to delete. `valid:false`
 * carries the reason so `logs clean` can say so instead of guessing. */
export interface RetentionSetting {
  /** Effective retention window in days; 0 ⇒ disabled (nothing is pruned). */
  days: number;
  /** The configured string exactly as read (or the default when nothing was set). */
  raw: string;
  source: "env" | "conf" | "default";
  /** False when `raw` is not a whole number of days (a typo, not a policy). */
  valid: boolean;
}

/** One run directory removed (or, under `dryRun`, that WOULD be removed). */
export interface PrunedRun {
  runId: string;
  /** Age in whole days of the run's NEWEST content (see `prune`'s age rule). */
  ageDays: number;
  /** Total bytes of the run dir's contents (regular files only). */
  bytes: number;
}

/** Result of `prune` — data, never an exception (the C31 posture, extended to the
 * maintenance path exactly as `verify` extends it to the audit path). */
export interface PruneResult {
  /** The resolved logs root that was scanned — GUILD_LOG_DIR + partitioning applied.
   * Pruning NEVER looks outside this one directory, and never below its children. */
  dir: string;
  /** The window actually applied, in days. 0 ⇒ nothing was scanned. */
  days: number;
  /** Run-id-shaped directories examined. */
  scanned: number;
  /** Runs removed (or, under `dryRun`, that would be). */
  removed: PrunedRun[];
  /** Runs left alone because their newest content is inside the window. */
  kept: number;
  /** Runs skipped because they could not be read (unreadable/raced away). */
  skipped: number;
  /** Total bytes reclaimed (or that would be). */
  freedBytes: number;
  dryRun: boolean;
  /** Set when nothing was scanned or the scan aborted:
   *  `disabled` (retention 0/negative/unparseable), `no-log-dir` (nothing to clean),
   *  `error` (an IO failure — reported, never thrown). */
  reason?: "disabled" | "no-log-dir" | "error";
  /** Present with `reason:"error"`. */
  error?: string;
  /** Present when `retention()` reported `valid:false` and no explicit window was passed. */
  invalidSetting?: RetentionSetting;
}

// ---------------------------------------------------------------------------
// Environment / config resolution (env override > modelguild.conf.local > default),
// mirroring log.sh's cfg()/conf_get() exactly (C35).
// ---------------------------------------------------------------------------

export interface EvidenceLogOptions {
  /** Environment map; defaults to `process.env`. Injected for test isolation. */
  env?: NodeJS.ProcessEnv;
  /** Working directory (for project-key derivation under partitioning). Default cwd. */
  cwd?: string;
  /** The install's PRIMARY `modelguild/` dir — the default `logs/` root, mirroring bash
   * `here`. WRITES always land here (the most-specific root). Default: `<cwd>/modelguild`. */
  guildDir?: string;
  /** The LAYERED read roots, most-specific first (issue #19). The evidence knobs
   * (`GUILD_LOG*`) are read across all of them — global baseline with the project overlaid
   * on top — so a global `GUILD_LOG_PROMPTS=off` still binds in a project that does not
   * restate it. Defaults to `[guildDir]`, i.e. the pre-layering single-root behaviour.
   * Writes are unaffected: the log dir still derives from `guildDir` alone. */
  guildDirs?: string[];
}

/**
 * Parse one KEY's value from a `modelguild.conf.local`-style file, byte-identically to
 * log.sh's `conf_get` awk: strip leading whitespace on each line; skip `#`-comment and
 * `=`-less lines; key = text before the first `=` with ALL whitespace removed; value =
 * text after `=` with a trailing ` # comment` stripped, then trimmed, then ONE layer of
 * surrounding double quotes and then ONE layer of single quotes removed; LAST assignment
 * wins; empty value ⇒ treated as unset.
 */
export function confGet(contents: string, key: string): string {
  let val = "";
  for (const rawLine of contents.split("\n")) {
    const line = rawLine.replace(/^[\t ]+/, "");
    if (line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const lk = line.slice(0, eq).replace(/[\t ]/g, "");
    if (lk !== key) continue;
    let lv = line.slice(eq + 1);
    lv = lv.replace(/[\t ]+#.*/, ""); // strip trailing " # comment"
    lv = lv.replace(/^[\t ]+/, "").replace(/[\t ]+$/, ""); // trim
    lv = lv.replace(/^"/, "").replace(/"$/, ""); // one layer of "…"
    lv = lv.replace(/^'/, "").replace(/'$/, ""); // one layer of '…'
    val = lv;
  }
  return val;
}

/** Whitespace class matching awk `[[:space:]]` is broader than `[\t ]`, but log.sh's
 * key files use spaces/tabs; the `\r` a CRLF file would carry is handled by splitting
 * lines and trimming trailing whitespace, which covers the realistic cases. */

// ---------------------------------------------------------------------------
// Run-id grammar (issue #73)
//
// A run id is a DIRECTORY NAME under the resolved logs root — `#runDir` joins it, and
// everything the layer records lands inside: calls.jsonl, activity.jsonl,
// approvals.jsonl, meta.json, the delegate patches and a `reports/` subdirectory, every
// one of them at `path.join(logsRoot, runId)`. (Written by several callers, not by one —
// `#ensureRun` makes the directory and `reports/`, `newRun` writes meta.json, the entry
// methods append calls.jsonl. The COMMON factor is the join, which is what this grammar
// guards.) `latest` and `watchers/` are SIBLINGS of the run dir, not contents of it,
// which is exactly why they are reserved names below. Before this the id was taken
// verbatim from the caller (an MCP tool's `runId` input) or from `$GUILD_RUN_ID`, so
// `../../..` wrote outside the root.
//
// The grammar is deliberately STRICT rather than merely traversal-proof: every run id in
// the wild was minted by `newRun()` (`<UTC stamp>-<hex>`), so a conservative
// single-segment shape costs nothing real, and an allowlist does not have to enumerate
// what a filesystem finds special — but a hand-written label must be a conservative
// segment. Anything outside it is an ERROR, never a fresh-run
// fallback — a caller who believes it threaded a run must not silently get a different one.
// ---------------------------------------------------------------------------

/** Max run-id length. The minted shape is 25 chars; 128 leaves room for a hand-written
 * label while keeping the joined component clear of any filesystem's name limit. */
export const RUN_ID_MAX_LENGTH = 128;

/** A run id is ONE conservative path segment: an alphanumeric first character, then
 * alphanumerics, `.`, `_` or `-`. That excludes — by construction, not by blocklist —
 * `/` and `\`, NUL and every other control character, a leading `.` (so `.`, `..` and
 * hidden dirs are out), and whitespace. */
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Names already taken by something else in the SAME logs root, so a run dir by one of
 * them collides: `latest` is the symlink `#ensureRun` maintains (the unlink and the symlink
 * both fail against a directory, leaving the pointer permanently broken), and `watchers` is
 * the approval bridge's presence dir (`watcherDirFor` in `src/approve.ts`) — a run there
 * would sit among the watcher heartbeat files (review finding F4).
 *
 * Compared **case-insensitively**: macOS's default APFS is case-insensitive, so `LATEST`
 * aliases `latest` there — and macOS is a platform this repo's CI covers explicitly. */
const RUN_ID_RESERVED = new Set(["latest", "watchers"]);

/** Render an offending value for an error message: echoed so the caller can see what it
 * sent, with control characters neutralized and the length capped.
 *
 * Rendering HOSTILE input is its whole job, so it must not throw (review finding F7):
 * `JSON.stringify` rejects a BigInt and a circular object, and a caller-controlled
 * `toString`/`toJSON` can throw as well. */
function showRunId(value: unknown): string {
  let s: string;
  try {
    s =
      typeof value === "string"
        ? value
        : value === null || value === undefined
          ? String(value)
          : (JSON.stringify(value) ?? String(value));
  } catch {
    try {
      s = String(value);
    } catch {
      s = `<unprintable ${typeof value}>`;
    }
  }
  // Escaped explicitly: control characters must never appear RAW in source.
  const flat = s.replace(/[\u0000-\u001f\u007f]/g, "?");
  return flat.length > 80 ? `${flat.slice(0, 80)}…` : flat;
}

const RUN_ID_RULE =
  "a run id is a single path segment: letters/digits/'.'/'_'/'-', starting with a letter " +
  `or digit, no '/', '\\', '..' or leading '.', at most ${RUN_ID_MAX_LENGTH} characters, ` +
  "and not the reserved names 'latest'/'watchers' (in any case) " +
  "(run ids are minted by the tools, e.g. 20260728T055956Z-7526f9dd — pass one back " +
  "verbatim, or omit it for a fresh run)";

/** Whether `value` is a usable run id. The single predicate every check goes through. */
export function isRunId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > RUN_ID_MAX_LENGTH) return false;
  if (!RUN_ID_RE.test(value)) return false;
  // `a..b` cannot traverse, but `..` is never something we mint and is what the report
  // names — refusing it outright keeps the rule to one sentence.
  if (value.includes("..")) return false;
  // Case-INSENSITIVE: see RUN_ID_RESERVED (a case-insensitive filesystem aliases them).
  return !RUN_ID_RESERVED.has(value.toLowerCase());
}

/**
 * Validate a run id supplied as tool INPUT, returning a result rather than throwing —
 * the same shape (and the same posture) as `parsePerCallTimeoutMs` in `config.ts`, so an
 * MCP handler turns it into a clear tool input error instead of an exception. An explicit
 * ask that is wrong is an error, not a silent default.
 */
export function parseRunId(
  value: unknown,
): { ok: true; value: string } | { ok: false; error: string } {
  if (isRunId(value)) return { ok: true, value };
  return { ok: false, error: `runId '${showRunId(value)}' is invalid — ${RUN_ID_RULE}.` };
}

/** Throwing form, for the internal choke point. `source` names where the bad value came
 * from (the `runId` argument vs the `GUILD_RUN_ID` env var) so the failure is diagnosable
 * and the operator is sent to the right knob. */
export function assertRunId(value: unknown, source: string): string {
  if (isRunId(value)) return value;
  throw new Error(`modelguild: ${source} '${showRunId(value)}' is invalid — ${RUN_ID_RULE}.`);
}

/**
 * Resolve an MCP tool's optional `runId` argument: `undefined` when absent, the id when
 * usable, an error message (prefixed with the tool name) when present-but-invalid — the
 * `runId` counterpart of `config.ts`'s `parsePerCallTimeoutMs` + `resolveTimeoutArg`.
 *
 * FAIL LOUD, NEVER FALL BACK (issue #73). The handlers previously read
 * `typeof a.runId === "string" ? a.runId : undefined`, which both let a traversing id
 * (`../../..`) reach the evidence layer as a directory name AND silently turned a
 * non-string one into "mint a fresh run" — a caller that believes it threaded a run must
 * not quietly be given a different one. An EMPTY string keeps its existing meaning of
 * "absent" (it is not a run id anyone was ever handed), which is how every tool module
 * already treated it.
 *
 * It lives here rather than in `src/server.ts` so it is unit-testable: importing that
 * file constructs the MCP server and connects the stdio transport at module top level.
 */
export function resolveRunIdArg(
  tool: string,
  raw: unknown,
): { value: string | undefined } | { error: string } {
  if (raw === undefined || raw === "") return { value: undefined };
  const parsed = parseRunId(raw);
  return parsed.ok ? { value: parsed.value } : { error: `${tool}: ${parsed.error}` };
}

export class EvidenceLog {
  readonly #env: NodeJS.ProcessEnv;
  readonly #cwd: string;
  readonly #guildDir: string;
  /** Conf files that contribute, LEAST-specific first (read order for last-wins overlay). */
  readonly #confFiles: string[];
  #confContents: string | undefined;

  constructor(opts: EvidenceLogOptions = {}) {
    this.#env = opts.env ?? process.env;
    this.#cwd = opts.cwd ?? process.cwd();
    this.#guildDir = opts.guildDir ?? path.join(this.#cwd, "modelguild");
    // Conf resolution mirrors log.sh, LAYERED (issue #19): GUILD_CONF is a single-FILE
    // override; otherwise every layer's <root>/modelguild.conf.local that exists.
    const roots =
      opts.guildDirs && opts.guildDirs.length > 0 ? opts.guildDirs : [this.#guildDir];
    const confEnv = this.#env.GUILD_CONF;
    if (confEnv) this.#confFiles = [confEnv];
    else {
      const found: string[] = [];
      // Most-specific first here, then reversed: the read order must put the project LAST
      // so `confGet`'s last-assignment-wins makes the project key override the global one.
      for (const root of roots) {
        const local = path.join(root, "modelguild.conf.local");
        // `isRegularFile`, not `existsSync` (issue #162): a FIFO here satisfied `existsSync`
        // and `#confRead`'s `readFileSync` then blocked forever, which no `catch` reaches.
        // `EvidenceLog` resolves the conf chain itself rather than through `src/config.ts`,
        // so the gate has to be stated in both places — keep them the same predicate.
        if (isRegularFile(local) && !found.includes(local)) found.push(local);
      }
      this.#confFiles = found.reverse();
    }
  }

  #confRead(): string {
    if (this.#confContents === undefined) {
      const parts: string[] = [];
      for (const file of this.#confFiles) {
        // The gate again for the `$GUILD_CONF` override, which is taken unchecked above.
        if (!isRegularFile(file)) continue; // issue #162 — non-regular ⇒ no value
        try { parts.push(readFileSync(file, "utf8")); } catch { /* unreadable ⇒ no value */ }
      }
      // `\n` join so a layer without a trailing newline cannot fuse into the next one.
      this.#confContents = parts.join("\n");
    }
    return this.#confContents;
  }

  /** cfg(KEY, default) — env (non-empty) > conf file > default. */
  #cfg(key: string, def: string): string {
    return this.#cfgWithSource(key, def).value;
  }

  /** cfg() plus WHICH TIER answered — same resolution, one extra fact. `logs clean`
   * needs it to tell a user "14 days (default)" from "14 days (from your conf)"; the
   * value itself is computed identically so the two can never disagree.
   *
   * TIER, NOT LAYER. Since #19 the conf tier is every root layer's `modelguild.conf.local`
   * concatenated (project last, so it wins) and read as ONE document — so `"conf"` honestly
   * means "some conf layer set this" and does not claim to say which. Naming the layer would
   * mean re-scanning the files separately, i.e. a second resolver free to disagree with the
   * first about what actually binds; `doctor` already prints the layer chain for the operator
   * who needs to know where a value came from. */
  #cfgWithSource(key: string, def: string): { value: string; source: "env" | "conf" | "default" } {
    const e = this.#env[key];
    if (e !== undefined && e !== "") return { value: e, source: "env" };
    const c = confGet(this.#confRead(), key);
    if (c !== "") return { value: c, source: "conf" };
    return { value: def, source: "default" };
  }

  #disabled(): boolean {
    return this.#cfg("GUILD_LOG", "on") === "off";
  }

  #promptMode(): PromptMode {
    const m = this.#cfg("GUILD_LOG_PROMPTS", "full");
    return m === "hash" || m === "off" ? m : "full";
  }

  /** The base log root, honoring an explicit GUILD_LOG_DIR and opt-in partitioning. */
  #logDir(): string {
    const explicit = this.#cfg("GUILD_LOG_DIR", "");
    if (explicit !== "") return explicit;
    const base = path.join(this.#guildDir, "logs");
    // Partition only when the root is OUR default (no explicit GUILD_LOG_DIR in env
    // OR conf), mirroring log.sh's guard exactly.
    const envLd = this.#env.GUILD_LOG_DIR;
    const confLd = confGet(this.#confRead(), "GUILD_LOG_DIR");
    if (
      this.#cfg("GUILD_LOG_PARTITION", "") === "1" &&
      (envLd === undefined || envLd === "") &&
      confLd === ""
    ) {
      return path.join(base, this.#projectKey());
    }
    return base;
  }

  /** A filesystem-safe token for the CWD's project — git top-level else CWD, as a
   * sanitized basename plus a 12-hex prefix of sha256(absolute root) so two repos that
   * share a basename never collide (log.sh `_project_key`). Never throws: a failing git
   * falls back to CWD, and the hash always succeeds under node crypto. */
  #projectKey(): string {
    let root = "";
    try {
      const r = spawnSync("git", ["rev-parse", "--show-toplevel"], {
        cwd: this.#cwd,
        encoding: "utf8",
      });
      if (r.status === 0 && typeof r.stdout === "string") root = r.stdout.trim();
    } catch {
      /* git absent — fall back below */
    }
    if (!root) root = this.#cwd;
    let base = path.basename(root) || "project";
    base = base.replace(/[^A-Za-z0-9._-]/g, "_") || "project";
    const hash = sha256Hex(root).slice(0, 12) || "0";
    return `${base}-${hash}`;
  }

  // --- run resolution ------------------------------------------------------
  /**
   * The run directory for an ALREADY-VALIDATED run id (everything reaches here through
   * `#resolveRun`). The containment assertion is belt-and-braces, not the guarantee: the
   * grammar in `#resolveRun` is what makes escape impossible, and this only catches a
   * future caller that found a way around it (issue #73).
   */
  #runDir(runId: string): string {
    const base = this.#logDir();
    const rd = path.join(base, runId);
    const rel = path.relative(base, rd);
    if (rel.length === 0 || rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(
        `modelguild: refusing a run directory outside the logs root (run id '${showRunId(runId)}', root ${base}).`,
      );
    }
    return rd;
  }

  /**
   * Resolve the run id to use: the caller's, else `$GUILD_RUN_ID`, else a fresh minted one.
   *
   * THE CHOKE POINT (issue #73). Both supplied paths are validated here, and an invalid
   * one THROWS rather than falling back to a fresh run: this value becomes a directory
   * name under the logs root, and a caller who believes it threaded a run must never
   * silently be given a different one (nor write outside the root). Write methods still
   * honour C31 — their own try/catch turns the throw into an `ok:false` + stderr warning,
   * never an exception into the tool call — and the MCP layer refuses an invalid `runId`
   * as a tool INPUT error before it ever gets here (`resolveRunIdArg`, used by every tool
   * handler in `src/server.ts`).
   */
  #resolveRun(runId?: string): string {
    if (runId) return assertRunId(runId, "runId");
    const ambient = this.#env.GUILD_RUN_ID;
    if (ambient) return assertRunId(ambient, "GUILD_RUN_ID");
    return `${nowStamp()}-${randHex()}`;
  }

  /**
   * Create the run dir and point `latest` at it.
   *
   * THE `latest` REFRESH IS ATOMIC, AND SKIPPED WHEN IT IS ALREADY RIGHT (issue #80).
   * `#ensureRun` runs on EVERY append, and the old refresh was `ln -sfn`'s pair —
   * `unlinkSync` then `symlinkSync` — which leaves a window in which `latest` does not
   * exist at all. That is not theoretical: `modelguild watch` re-resolves `latest` on
   * every poll, and with two Claude Code sessions open on one project a hammering reader
   * caught the link absent 108 times in 86k reads (test/log.test.ts case 18a, which fails
   * on the old code). `rename(2)` over the existing link replaces it in one step, so a
   * concurrent reader sees the old target or the new one — never nothing. The
   * already-correct early-out is the other half: a single session now touches the link
   * once per run instead of once per entry, so the window is not merely narrower, it is
   * almost never entered.
   *
   * ATOMICITY IS `rename(2)`'s, AND THAT IS A PLATFORM PROPERTY: POSIX specifies the
   * replacement as atomic, and CI exercises this on Linux only (the macOS job runs the
   * shell lints, not the node suites). It is relied on, not proven here on macOS.
   */
  #ensureRun(runId: string): string {
    const rd = this.#runDir(runId);
    mkdirSync(path.join(rd, "reports"), { recursive: true });
    const latest = path.join(this.#logDir(), "latest");
    if (readlinkSafe(latest) === runId) return rd; // already ours — no churn at all
    // Unique per WRITER, not merely per process: `process.pid` alone collides across pid
    // namespaces, and this repo's own devcontainer story (a host workspace bind-mounted
    // into containers) is exactly how two writers get the same pid on one logs root —
    // whereupon A's cleanup unlink deletes B's in-flight temp link, B's rename fails, and
    // B silently drops into the non-atomic fallback below. The random suffix removes the
    // class. Within ONE process these calls are synchronous and cannot interleave.
    const tmpLink = path.join(this.#logDir(), `.latest.${process.pid}.${randHex()}.tmp`);
    try {
      symlinkSync(runId, tmpLink);
      renameSync(tmpLink, latest);
    } catch {
      // Fallback for a filesystem that cannot rename over a symlink (or has no symlinks
      // at all). It reopens the window the atomic path exists to close, which is exactly
      // why it is the fallback and not the default.
      try {
        rmSync(tmpLink, { force: true });
      } catch {
        /* best-effort */
      }
      try {
        if (existsSync(latest) || isSymlink(latest)) unlinkSync(latest);
      } catch {
        /* best-effort */
      }
      try {
        symlinkSync(runId, latest);
      } catch {
        /* best-effort — a symlink-less FS must not fail the call (C31) */
      }
    }
    return rd;
  }

  // --- locked append -------------------------------------------------------
  /**
   * Append one entry under the run's `.lock` dir, computing prev_hash (and, for
   * `started`, the turn) INSIDE the lock — the same race log.sh had when turn was
   * counted outside it (three concurrent panel calls all claimed turn 1).
   *
   * The lock is a `mkdir` on `<file>.lock`, identical to bash: atomic and portable, and
   * interoperable with bash writers on the same run. A lock older than ~1 min is a
   * crashed writer's and is stolen; after ~10s of contention we DROP this entry rather
   * than risk a torn unlocked append (a missing entry is a bounded gap `verify` reports;
   * a torn line poisons the record around it).
   */
  async #appendLocked(
    file: string,
    payload: { [key: string]: JsonValue },
    withTurn: boolean,
  ): Promise<{ ok: boolean; turn?: number }> {
    const lock = `${file}.lock`;
    const acquired = await acquireLock(lock);
    if (!acquired) {
      process.stderr.write(
        "modelguild: log lock busy for 10s — DROPPING this entry rather than risk a torn append (verify will show the gap).\n",
      );
      return { ok: false };
    }
    try {
      let prev = "";
      let existing = "";
      if (existsSync(file)) {
        existing = readFileSync(file, "utf8");
        const lines = existing.split("\n").filter((l) => l.length > 0);
        if (lines.length > 0) prev = lineHash(lines[lines.length - 1]);
      }
      const full: { [key: string]: JsonValue } = { ...payload, prev_hash: prev };
      let turn: number | undefined;
      if (withTurn) {
        // turn = count of started entries so far + 1, counted INSIDE the lock. Match
        // bash's grep of the literal substring `"status":"started"`.
        const count = countOccurrences(existing, '"status":"started"');
        turn = count + 1;
        full.turn = turn;
      }
      const { line } = buildEntryLine(full);
      appendFileSync(file, line + "\n");
      return { ok: true, turn };
    } finally {
      releaseLock(lock);
    }
  }

  // --- entry base ----------------------------------------------------------
  #base(runId: string, type: string, status: string | null): { [key: string]: JsonValue } {
    return {
      timestamp: nowStamp8601(),
      run_id: runId,
      type,
      status: status === "" || status === null ? null : status,
    };
  }

  // =========================================================================
  // Read-only helpers (no logging side effects)
  // =========================================================================

  /** The run directory for `runId` (or the resolved ambient/fresh run). */
  dir(runId?: string): string {
    return this.#runDir(this.#resolveRun(runId));
  }

  /** The calls.jsonl path for `runId`. */
  path(runId?: string): string {
    return path.join(this.#runDir(this.#resolveRun(runId)), "calls.jsonl");
  }

  /** Whether the evidence layer is on (GUILD_LOG != "off"). Read-only; no side
   * effects. Exposed for diagnostics (guild_status / doctor) so the "logging on/off"
   * report reuses the SAME cfg() resolution as every write path, rather than a second
   * copy that could drift from C35's env>conf>default order. */
  enabled(): boolean {
    return !this.#disabled();
  }

  /** The effective log root after GUILD_LOG_DIR + partitioning resolution — the exact
   * directory writes land under. Read-only; for the same diagnostic reason as `enabled`. */
  logDir(): string {
    return this.#logDir();
  }

  /** The resolved retention setting (C35 order), including its source and whether the
   * configured value was readable at all. Read-only; no side effects. The single
   * resolver for BOTH prune paths (`new-run`, `logs clean`, server start) so they can
   * never disagree about the window — the pre-#23 code resolved it twice, differently. */
  retention(): RetentionSetting {
    const { value: raw, source } = this.#cfgWithSource(
      "GUILD_LOG_RETENTION_DAYS",
      String(DEFAULT_RETENTION_DAYS),
    );
    const trimmed = raw.trim();
    const valid = /^[+-]?\d+$/.test(trimmed);
    const n = valid ? parseInt(trimmed, 10) : NaN;
    return { days: valid && n > 0 ? n : 0, raw, source, valid };
  }

  /** The most recent run's id (via the `latest` symlink). Returns undefined if none. */
  latest(): string | undefined {
    const l = path.join(this.#logDir(), "latest");
    // ONE readlink, not isSymlink-then-readlinkSync: the two-call form can disagree about
    // a path that changed between them, which is the whole reason `readlinkSafe` exists.
    const target = readlinkSafe(l);
    if (target === undefined) return undefined;
    try {
      const name = path.basename(target);
      // The symlink's TARGET is data on disk, not something we minted this process — and
      // `runWatch` joins this straight onto the logs root without going through `dir()`,
      // so a `latest` pointing at `..` would make the watcher tail above the root (review
      // finding F5). Anything that is not a run id is "no latest run", not a path.
      if (!isRunId(name)) return undefined;
      // AND the run must still BE there (issue #80). `prune` deletes run dirs and only
      // then drops a dangling `latest`, and a SECOND session can be pruning while this
      // one reads — so the link names a deleted run for a window a reader really does hit
      // (test/log.test.ts case 18b caught it). `runWatch` joins this name onto the logs
      // root and tails the file under it, so a name with no directory behind it is "no
      // latest run", not a run to follow. This check — not the unlink in
      // `#dropDanglingLatest` — is where the guarantee lives: with it, the worst a raced
      // drop can do is leave NO pointer, never a pointer to nothing.
      return existsSync(path.join(this.#logDir(), name)) ? name : undefined;
    } catch {
      return undefined;
    }
  }

  // =========================================================================
  // Mutating subcommands
  // =========================================================================

  /** Mint a FRESH run id (deliberately ignoring an ambient GUILD_RUN_ID — asking for a
   * new run and getting the current one would silently merge two audit units), create
   * its dir, write meta.json, prune old runs, and return the id. Empty string when
   * logging is disabled. Never throws. */
  newRun(command = "ask"): string {
    if (this.#disabled()) return "";
    try {
      const rid = `${nowStamp()}-${randHex()}`;
      const rd = this.#ensureRun(rid);
      try {
        const meta = canonicalStringify({
          run_id: rid,
          command,
          started_at: nowStamp8601(),
        });
        writeFileSync(path.join(rd, "meta.json"), meta + "\n");
      } catch {
        /* meta is best-effort */
      }
      // Retention (C32). No argument ⇒ prune() resolves the window itself via
      // retention(), the SAME resolver `logs clean` and the server-start hook use.
      this.prune();
      return rid;
    } catch (err) {
      warn("new-run", err);
      return "";
    }
  }

  /** Record a durable intent to make a call, BEFORE capture setup (C22). This is the
   * pre-marker that makes a crash-before-`started` gap visible to verify. */
  async expect(args: {
    callId: string;
    command?: string;
    model?: string;
    agent?: string;
    run?: string;
  }): Promise<WriteResult> {
    if (!args.callId) return fail("expect: callId is required");
    if (this.#disabled()) return { ok: true };
    try {
      const rid = this.#resolveRun(args.run);
      const rd = this.#ensureRun(rid);
      const payload = {
        ...this.#base(rid, "expected-call", "expected"),
        call_id: args.callId,
        command: args.command ?? "",
        model: nullIfEmpty(args.model),
        agent: args.agent ?? "",
      };
      const r = await this.#appendLocked(path.join(rd, "calls.jsonl"), payload, false);
      return { ok: r.ok };
    } catch (err) {
      warn("expect", err);
      return { ok: false, error: String(err) };
    }
  }

  /** Record the start of a model call and stamp its turn (C22/C23/C26). Returns the
   * turn. Prompt privacy per GUILD_LOG_PROMPTS: full ⇒ text + digest; hash ⇒ digest
   * only; off ⇒ neither. */
  async started(args: {
    callId: string;
    command?: string;
    model?: string;
    agent?: string;
    session?: string;
    prompt?: string;
    /** Policy tier the call was made under (C1–C7). Optional, positive-direction
     * addition over bash (see the `#policyFields` note) — absent on legacy/allow entries. */
    tier?: PolicyTier;
    /** Whether the human approved an ask-tier call. Optional; see `#policyFields`. */
    confirmed?: boolean;
    /**
     * THE READ ROOT the turn actually ran against (issue #96, review finding M2) — the
     * directory the `opencode serve` child serving this call was rooted at, when it was NOT
     * the project the server was launched in.
     *
     * Why it belongs in the receipts and not only on the tool result: after #96 the same
     * prompt and the same `raw_response` are AMBIGUOUS about which tree the answer describes,
     * and this log is the durable, hash-chained thing you read when Claude's account of an
     * exchange is in question. `activity.jsonl` is explicitly not the evidence log (C59) and
     * is not a substitute. It rides on `started` because that is the entry that records what
     * was asked; the pairing is by `call_id`, so a reader has it for the whole call.
     *
     * WRITTEN ONLY WHEN SUPPLIED, exactly like `incomplete_detail`/`scaffold_changed` (C29):
     * a call with no worktree target emits an entry byte-identical to one written before this
     * field existed, so no existing run, fixture or `verify()` branch changes shape.
     */
    readRoot?: string;
    /**
     * THE WRITE ROOT the turn actually EDITED (issue #107) — the tree `guild_delegate`'s
     * snapshot, both trees, the recorded patch and the recovery hint are all anchored at,
     * which is by construction the same directory the serve child was rooted at.
     *
     * ITS OWN FIELD, NOT A REUSE OF `read_root`, and the reason is what a receipt is FOR.
     * `read_root` is the claim "the answer describes this tree"; `write_root` is the claim
     * "this tree was MUTATED". Folding them together would make the honest question a reader
     * of the log asks — *which trees did a model change?* — return every read-only consult
     * that ever named a worktree, and would leave the two claims indistinguishable in exactly
     * the archive you consult when Claude's account of an exchange is in doubt. They are also
     * not always the same shape of thing: a read root widens what can egress, a write root
     * widens what can be destroyed, and SECURITY.md treats them separately.
     *
     * Same optional-field rule as `read_root` (C29): written ONLY when a target was resolved,
     * so an untargeted delegation's entry is byte-identical to one written before this field
     * existed, and no `verify()` branch changes. It rides on `started` for the same reason
     * `read_root` does — that is the entry recording what was asked — and the `delegate-diff`
     * entry is paired to it by `call_id`, so the tree and the patch are read together.
     */
    writeRoot?: string;
    /**
     * THIS CALL IS A SECOND ATTEMPT AT AN EARLIER ONE (issue #187) — the `call_id` of the
     * attempt it is retrying, in the same run.
     *
     * Without it a retried panel member and two independent calls to the same model are
     * byte-identical in the receipts, and "this answer needed a second attempt" is a different
     * claim from "this answer came first time" — the same reason `answer_channel` exists.
     *
     * The link is FORWARD-ONLY and cannot be otherwise: the first attempt's three entries are
     * already written (and hash-chained) before the retry is decided, so the retry names its
     * predecessor and the predecessor never names its successor.
     *
     * Same optional-field rule as `read_root`/`write_root` (C29): written ONLY on a retry, so
     * an ordinary call's entry is byte-identical to one written before this field existed, and
     * no `verify()` branch changes — the retry is a full, separate `call_id` with its own
     * expected/started/completed lifecycle, which is exactly what C24 requires of it.
     */
    retryOf?: string;
    run?: string;
  }): Promise<StartedResult> {
    if (this.#disabled()) return { ok: true };
    try {
      const rid = this.#resolveRun(args.run);
      const rd = this.#ensureRun(rid);
      const mode = this.#promptMode();
      const hasPrompt = args.prompt !== undefined;
      const promptHash = hasPrompt && mode !== "off" ? sha256Hex(args.prompt as string) : "";
      const payload = {
        ...this.#base(rid, "call", "started"),
        call_id: args.callId,
        command: args.command ?? "",
        model: nullIfEmpty(args.model),
        agent: args.agent ?? "",
        session_id: nullIfEmpty(args.session),
        prompt_mode: mode,
        // full ⇒ the prompt text (empty string if none was supplied, matching log.sh's
        // rawfile of an empty temp file); otherwise null.
        prompt: mode === "full" ? (args.prompt ?? "") : null,
        prompt_hash: nullIfEmpty(promptHash),
        ...policyFields(args.tier, args.confirmed),
        // Absent unless a non-default read root was actually used — see `readRoot` above.
        ...(args.readRoot !== undefined && args.readRoot.length > 0
          ? { read_root: args.readRoot }
          : {}),
        // Absent unless a non-default WRITE root was actually used — see `writeRoot` above.
        ...(args.writeRoot !== undefined && args.writeRoot.length > 0
          ? { write_root: args.writeRoot }
          : {}),
        // Absent unless this call is a retry of an earlier one — see `retryOf` above.
        ...(args.retryOf !== undefined && args.retryOf.length > 0
          ? { retry_of: args.retryOf }
          : {}),
      };
      const r = await this.#appendLocked(path.join(rd, "calls.jsonl"), payload, true);
      return { ok: r.ok, turn: r.turn };
    } catch (err) {
      warn("started", err);
      return { ok: false, error: String(err) };
    }
  }

  /**
   * Record the completion of a model call (C22/C25). `raw_response` is stored in FULL,
   * byte-exact.
   *
   * CARRIED DECISION (M2 review) — present-empty vs absent response: a `complete` state
   * with NO `response` (undefined) downgrades to `failed` (mirrors log.sh's missing
   * response-file downgrade). A `response` of `""` is a PRESENT-but-empty answer: it
   * stays `complete`, with raw_response `""` and response_hash = sha256("") — the same
   * distinction log.sh draws between a missing file and an empty file.
   */
  async completed(args: {
    callId: string;
    exit?: number;
    turn?: number;
    session?: string;
    command?: string;
    model?: string;
    agent?: string;
    captureState: CaptureState;
    response?: string;
    /** Policy tier / human-approval, mirrored from `started` for the same audit reason
     * (see `#policyFields`). Both optional; absent on legacy/allow entries. */
    tier?: PolicyTier;
    confirmed?: boolean;
    /**
     * WHICH CHANNEL `raw_response` CAME OFF, when it was not the ordinary one (issue #168).
     *
     * `"reasoning"` says the model produced no text and the extractor promoted its reasoning to
     * be the answer, so a reader of these receipts can tell "the model's answer" from "the
     * model's chain-of-thought, promoted because there was no answer" — which `raw_response`
     * alone renders identically. Optional and absent on every ordinary call, so an entry
     * written for a normal turn is byte-identical to one written before this field existed
     * (C29's optional-field rule).
     */
    answerChannel?: string;
    /**
     * WHY THIS CALL WAS REFUSED, in the receipts (issue #188, extended by #191).
     *
     * The same object the tool result's `error.diagnostics` carries — not a summary of it and
     * not a re-derivation, so the durable record and the transcript cannot disagree. Written
     * only on a turn that produced nothing, so every ordinary entry is byte-identical to one
     * written before this field existed (C29's optional-field rule). See `diagnosticsField`
     * for what is copied, why lengths and never content, and why it cannot throw.
     */
    diagnostics?: TurnDiagnostics;
    run?: string;
  }): Promise<WriteResult> {
    if (args.captureState !== "complete" && args.captureState !== "failed") {
      return fail("completed: captureState must be complete|failed");
    }
    if (this.#disabled()) return { ok: true };
    try {
      const rid = this.#resolveRun(args.run);
      const rd = this.#ensureRun(rid);
      let capture: CaptureState = args.captureState;
      let response = args.response;
      // complete + missing response ⇒ downgrade to failed (present-empty stays complete).
      if (capture === "complete" && response === undefined) capture = "failed";
      let rawResponse: string;
      let responseHash: string;
      if (capture === "failed") {
        rawResponse = "";
        responseHash = "";
      } else {
        rawResponse = response as string; // may be "" (present-empty)
        responseHash = sha256Hex(rawResponse);
      }
      const payload = {
        ...this.#base(rid, "call", "completed"),
        call_id: args.callId,
        command: args.command ?? "",
        model: nullIfEmpty(args.model),
        agent: args.agent ?? "",
        session_id: nullIfEmpty(args.session),
        turn: args.turn === undefined ? null : args.turn,
        exit_code: args.exit ?? 0,
        capture_state: capture,
        raw_response: rawResponse,
        response_hash: nullIfEmpty(responseHash),
        ...policyFields(args.tier, args.confirmed),
        ...(args.answerChannel !== undefined && args.answerChannel.length > 0
          ? { answer_channel: args.answerChannel }
          : {}),
        ...diagnosticsField(args.diagnostics),
      };
      const r = await this.#appendLocked(path.join(rd, "calls.jsonl"), payload, false);
      return { ok: r.ok };
    } catch (err) {
      warn("completed", err);
      return { ok: false, error: String(err) };
    }
  }

  /** Record Claude's final user-facing answer (C29). Returns the calls.jsonl path. */
  async final(text: string, run?: string): Promise<PathResult> {
    if (this.#disabled()) return { ok: true };
    try {
      const rid = this.#resolveRun(run);
      const rd = this.#ensureRun(rid);
      const file = path.join(rd, "calls.jsonl");
      const payload = {
        ...this.#base(rid, "claude-final", null),
        text,
        response_hash: nullIfEmpty(sha256Hex(text)),
      };
      const r = await this.#appendLocked(file, payload, false);
      return { ok: r.ok, path: file };
    } catch (err) {
      warn("final", err);
      return { ok: false, error: String(err) };
    }
  }

  /** Record Claude's claimed disposition of a model's point — a CLAIM to audit, not a
   * fact (C29). Verdict restricted to Adopt|Adapt|Reject|Defer. */
  async disposition(args: {
    model?: string;
    point: string;
    verdict: Verdict;
    why?: string;
    run?: string;
  }): Promise<WriteResult> {
    if (!args.point || !args.verdict) return fail("disposition: point and verdict are required");
    if (!["Adopt", "Adapt", "Reject", "Defer"].includes(args.verdict)) {
      return fail(`disposition: verdict must be Adopt|Adapt|Reject|Defer (got '${args.verdict}')`);
    }
    if (this.#disabled()) return { ok: true };
    try {
      const rid = this.#resolveRun(args.run);
      const rd = this.#ensureRun(rid);
      const payload = {
        ...this.#base(rid, "claude-disposition", null),
        claim: true,
        model: nullIfEmpty(args.model),
        point: args.point,
        verdict: args.verdict,
        why: nullIfEmpty(args.why),
      };
      const r = await this.#appendLocked(path.join(rd, "calls.jsonl"), payload, false);
      return { ok: r.ok };
    } catch (err) {
      warn("disposition", err);
      return { ok: false, error: String(err) };
    }
  }

  /** Record a Claude subagent's guild turn — a CLAIM, not captured evidence (C29/C30):
   * claim:true, captured:false, text in `claimed_response` (never `raw_response`). */
  async subagentVoice(args: {
    response: string;
    model?: string;
    label?: string;
    prompt?: string;
    run?: string;
  }): Promise<WriteResult> {
    if (args.response === undefined || args.response === null) {
      return fail("subagent-voice: response is required");
    }
    if (this.#disabled()) return { ok: true };
    try {
      const rid = this.#resolveRun(args.run);
      const rd = this.#ensureRun(rid);
      const mode = this.#promptMode();
      const hasPrompt = args.prompt !== undefined;
      const promptHash = hasPrompt && mode !== "off" ? sha256Hex(args.prompt as string) : "";
      const payload = {
        ...this.#base(rid, "subagent-voice", null),
        claim: true,
        captured: false,
        transport: "claude-subagent",
        model: nullIfEmpty(args.model),
        label: nullIfEmpty(args.label),
        prompt_mode: mode,
        prompt: mode === "full" ? (args.prompt ?? "") : null,
        prompt_hash: nullIfEmpty(promptHash),
        claimed_response: args.response,
        response_hash: nullIfEmpty(sha256Hex(args.response)),
      };
      const r = await this.#appendLocked(path.join(rd, "calls.jsonl"), payload, false);
      return { ok: r.ok };
    } catch (err) {
      warn("subagent-voice", err);
      return { ok: false, error: String(err) };
    }
  }

  /** Record what a delegated model actually changed — machine evidence, claim:false, the
   * patch hashed and folded into the integrity contract (C29). `patchFile` must already
   * exist inside the run dir (ask.sh writes it there); the entry stores its basename and
   * verify resolves it under the run dir. */
  async diff(args: {
    callId: string;
    patchFile: string;
    base?: string;
    after?: string;
    complete?: boolean;
    reason?: string;
    run?: string;
    /** Tamper signal (M8): the serve-runtime scaffolding (`.opencode/node_modules/**` + its
     * manifests — excluded from the ignored fingerprint) changed during the call. Optional,
     * like tier/confirmed: absent on bash-written and pre-M8 entries; both verifiers tolerate
     * its presence and absence (it is not a verified invariant, just recorded evidence). */
    scaffoldChanged?: boolean;
  }): Promise<WriteResult> {
    if (!args.patchFile || !existsSync(args.patchFile)) {
      return fail("diff: patchFile must exist");
    }
    if (this.#disabled()) return { ok: true };
    try {
      const rid = this.#resolveRun(args.run);
      const rd = this.#ensureRun(rid);
      const buf = readFileSync(args.patchFile);
      const text = buf.toString("utf8");
      const filesChanged = countOccurrences2(text, /^diff --git /gm);
      const payload = {
        ...this.#base(rid, "delegate-diff", null),
        call_id: args.callId ?? "",
        patch: path.basename(args.patchFile),
        base_tree: args.base ?? "",
        after_tree: args.after ?? "",
        files_changed: filesChanged,
        patch_bytes: buf.byteLength,
        claim: false,
        capture_complete: args.complete ?? true,
        incomplete_reason: nullIfEmpty(args.reason),
        // Optional tamper signal — only written when provided, so bash-written / pre-M8
        // entries omit it and stay byte-identical; both verifiers fold it into the hash chain
        // like any other payload field without asserting on it.
        ...(args.scaffoldChanged === undefined ? {} : { scaffold_changed: args.scaffoldChanged }),
        response_hash: nullIfEmpty(sha256HexBytes(buf)),
      };
      const r = await this.#appendLocked(path.join(rd, "calls.jsonl"), payload, false);
      return { ok: r.ok };
    } catch (err) {
      warn("diff", err);
      return { ok: false, error: String(err) };
    }
  }

  /**
   * Record that a delegate capture produced NO patch artifact at all — the patch-less
   * `delegate-diff` entry (issue #74, 2026-07-28).
   *
   * WHY THIS EXISTS. `diff()` above requires an existing patch file, because its whole job is
   * to hash one into the integrity contract. But the write path has a case where there IS no
   * patch to hash: the capture machinery itself threw (`capture-crashed` — an unwritable run
   * dir, a patch path that is not a writable file, a git plumbing call that blew up mid-diff).
   * Before this method the delegate `catch` simply returned, so **no `delegate-diff` entry was
   * written at all** and the run verified CLEAN — a crashed capture was indistinguishable in
   * the log from a delegation that changed nothing. That is the one failure the evidence layer
   * exists to prevent, and it is the opposite of the six snapshot incomplete-reasons, which do
   * reach `diff()` with `complete:false` and fail integrity loudly.
   *
   * ENTRY SHAPE — deliberately the SAME field set as `diff()`, so a reader sees one entry
   * shape, with the artifact fields emptied: `patch: null`, `patch_bytes: 0`,
   * `files_changed: 0`, `after_tree: ""`, and **no `response_hash`** (null). That last one is
   * load-bearing in both directions under `verify()`:
   *   - `capture_complete: false` trips the capture-completeness check ⇒ the run FAILS with
   *     code 7. That is the POINT: a crashed capture must not verify clean.
   *   - the referenced-artifact check is gated on a non-empty `response_hash`, so a null hash
   *     means verify never resolves `patch` and never reports a MISSING artifact. The entry
   *     fails for the true reason (capture incomplete), not for a patch it never claimed to
   *     have. A half-written `diff-<call_id>.patch` may still be on disk from the crash; it is
   *     deliberately NOT referenced (its bytes are not a record of anything) and deliberately
   *     NOT deleted (deleting evidence during a failure is worse than leaving it).
   *
   * `reason` is REQUIRED: a patch-less entry with no reason is uninterpretable. `detail` is the
   * optional crash text (bounded and sanitized by `boundedDetail` — see the C25 scar it exists
   * to avoid), included ONLY when it survives as non-empty, the same optional-field pattern as
   * `scaffold_changed`. Exactly two shapes exist: the field absent, or a non-empty string.
   */
  async diffUncaptured(args: {
    callId: string;
    base?: string;
    /** Why there is no patch — the `incompleteReason` the tool result also carries. */
    reason: string;
    /** Bounded free text (the crash message). Optional; omitted from the payload when absent. */
    detail?: string;
    run?: string;
    scaffoldChanged?: boolean;
  }): Promise<WriteResult> {
    if (!args.reason || args.reason.length === 0) {
      return fail("diffUncaptured: reason is required (a patch-less entry must say why)");
    }
    if (this.#disabled()) return { ok: true };
    try {
      const rid = this.#resolveRun(args.run);
      const rd = this.#ensureRun(rid);
      const detail = args.detail === undefined ? "" : boundedDetail(args.detail);
      const payload = {
        ...this.#base(rid, "delegate-diff", null),
        call_id: args.callId ?? "",
        patch: null,
        base_tree: args.base ?? "",
        after_tree: "",
        files_changed: 0,
        patch_bytes: 0,
        claim: false,
        capture_complete: false,
        incomplete_reason: args.reason,
        ...(detail === "" ? {} : { incomplete_detail: detail }),
        ...(args.scaffoldChanged === undefined ? {} : { scaffold_changed: args.scaffoldChanged }),
        response_hash: null,
      };
      const r = await this.#appendLocked(path.join(rd, "calls.jsonl"), payload, false);
      return { ok: r.ok };
    } catch (err) {
      warn("diffUncaptured", err);
      return { ok: false, error: String(err) };
    }
  }

  // =========================================================================
  // verify — the integrity contract (C24/C27/C28). Returns a result; never throws
  // for an integrity failure (code 7) — that is data, not an exception.
  // =========================================================================
  verify(runId?: string): VerifyResult {
    // An unusable run id (issue #73) is an integrity FAILURE reported as data, not an
    // exception — same posture as the read error below, and it names the rule broken.
    let rid: string;
    let rd: string;
    try {
      rid = this.#resolveRun(runId);
      rd = this.#runDir(rid);
    } catch (err) {
      return { ok: false, code: 7, message: `verify: ${String(err)}` };
    }
    const file = path.join(rd, "calls.jsonl");
    if (!existsSync(file)) {
      return { ok: false, code: 7, message: `verify: no log at ${file}` };
    }
    // Reading the log is IO that can fail (a directory in place of the file, a permission
    // error, or the file raced away between existsSync and here). An MCP handler calls
    // verify(); it must get a failed RESULT, never an exception (C31 posture extended to
    // the audit path).
    let content: string;
    try {
      content = readFileSync(file, "utf8");
    } catch (err) {
      warn("verify(read)", err);
      return { ok: false, code: 7, message: `verify: cannot read ${file}: ${String(err)}` };
    }
    // 1. Clean JSONL: newline-terminated line count must equal parseable-value count.
    //    "Parseable" here means jq-parseable, NOT merely JSON.parse-able. jq (bash's
    //    verifier) REJECTS a lone UTF-16 surrogate escape (e.g. `\ud800`) as invalid
    //    JSON and errors the whole stream; JS's JSON.parse ACCEPTS it, yielding an
    //    ill-formed string. Counting only JSON.parse success would let a log with a lone
    //    surrogate pass TS verify while bash verify fails it — a false-clean in exactly
    //    the direction this project exists to kill (verified: jq -s exits 5 on `\ud800`).
    //    So a line that parses but carries a lone surrogate is treated as UNclean.
    const nLines = (content.match(/\n/g) || []).length;
    const rawLines = content.split("\n").filter((l) => l.length > 0);
    const parsed: Array<{ [k: string]: JsonValue }> = [];
    let parseOk = true;
    for (const l of rawLines) {
      try {
        const value = JSON.parse(l) as JsonValue;
        if (containsLoneSurrogate(value)) parseOk = false;
        parsed.push(value as { [k: string]: JsonValue });
      } catch {
        parseOk = false;
      }
    }
    if (!parseOk || parsed.length !== nLines) {
      return fail7(file, `is not clean JSONL (${nLines} lines, ${parseOk ? parsed.length : -1} parsed).`);
    }

    // 2a. expected-call ids: unique, non-empty strings.
    const expected = parsed.filter((e) => e.type === "expected-call");
    const badExpected: string[] = [];
    const seen = new Map<string, number>();
    for (const e of expected) {
      const cid = e.call_id;
      if (typeof cid !== "string" || cid === "") {
        badExpected.push("missing or invalid call_id");
      } else {
        seen.set(cid, (seen.get(cid) ?? 0) + 1);
      }
    }
    for (const [cid, n] of seen) if (n > 1) badExpected.push(`duplicate call_id ${cid}`);
    if (badExpected.length > 0) {
      return fail7Raw(
        `INTEGRITY FAIL: expected-call entries require unique, non-empty string call_id values:\n  ${badExpected.join("\n  ")}`,
      );
    }

    // 2b. A run is empty only if it has NEITHER a lifecycle call NOR a well-formed
    // subagent voice (an all-Anthropic exchange of subagent voices is a real exchange).
    const nExpected = expected.filter(
      (e) => typeof e.call_id === "string" && e.call_id !== "",
    ).length;
    const nVoices = parsed.filter(
      (e) => e.type === "subagent-voice" && typeof e.claimed_response === "string",
    ).length;
    if (nExpected === 0 && nVoices === 0) {
      return fail7Raw("INTEGRITY FAIL: run contains no model lifecycle calls or subagent voices.");
    }

    // 2c. Per call_id cardinality: EXACTLY one expected, started, completed — both
    // directions (an orphaned completed is as fatal as an orphaned started).
    const ids = new Set<string>();
    for (const e of parsed) if (typeof e.call_id === "string") ids.add(e.call_id);
    const badCard: string[] = [];
    for (const id of ids) {
      const eN = parsed.filter((e) => e.type === "expected-call" && e.call_id === id).length;
      const sN = parsed.filter(
        (e) => e.type === "call" && e.status === "started" && e.call_id === id,
      ).length;
      const cN = parsed.filter(
        (e) => e.type === "call" && e.status === "completed" && e.call_id === id,
      ).length;
      if (eN !== 1 || sN !== 1 || cN !== 1) {
        badCard.push(`${id}|expected=${eN},started=${sN},completed=${cN}`);
      }
    }
    if (badCard.length > 0) {
      return fail7Raw(
        `INTEGRITY FAIL: every call_id requires exactly one expected, started, and completed entry:\n  ${badCard.join("\n  ")}`,
      );
    }

    // 3. Hash chain + per-entry self-check + capture/prompt/response payload checks.
    let prev = "";
    for (let idx = 0; idx < rawLines.length; idx++) {
      const line = rawLines[idx];
      const e = parsed[idx];
      const i = idx + 1;
      const gotPrev = typeof e.prev_hash === "string" ? e.prev_hash : "";
      if (gotPrev !== prev) {
        return fail7Raw(`INTEGRITY FAIL: prev_hash mismatch at line ${i} (log corrupted or rewritten).`);
      }
      const storedHash = typeof e.entry_hash === "string" ? e.entry_hash : "";
      if (storedHash === "" || storedHash !== recomputeEntryHash(e)) {
        return fail7Raw(`INTEGRITY FAIL: entry_hash mismatch at line ${i} (entry payload altered or unprotected).`);
      }
      // capture completeness
      let capture: string;
      if (e.type === "call" && e.status === "completed") {
        capture = typeof e.capture_state === "string" ? e.capture_state : "missing";
      } else if (e.type === "delegate-diff") {
        capture = e.capture_complete ? "complete" : "failed";
      } else {
        capture = "complete";
      }
      if (capture !== "complete") {
        return fail7Raw(`INTEGRITY FAIL: line ${i} records incomplete evidence capture (${capture}).`);
      }
      // prompt-mode/hash consistency (only for started entries)
      const pmode =
        e.type === "call" && e.status === "started"
          ? typeof e.prompt_mode === "string"
            ? e.prompt_mode
            : "missing"
          : "none";
      const ph = typeof e.prompt_hash === "string" ? e.prompt_hash : "";
      if (pmode === "full") {
        const promptText = typeof e.prompt === "string" ? e.prompt : "";
        if (ph === "" || sha256Hex(promptText) !== ph) {
          return fail7Raw(`INTEGRITY FAIL: prompt_hash mismatch at line ${i} (the recorded prompt does not match its digest).`);
        }
      } else if (pmode === "hash") {
        if (!/^[0-9a-f]{64}$/.test(ph)) {
          return fail7Raw(`INTEGRITY FAIL: invalid prompt_hash at line ${i}.`);
        }
      } else if (pmode === "off") {
        if (ph !== "") {
          return fail7Raw(`INTEGRITY FAIL: prompt hashing is present despite off mode at line ${i}.`);
        }
      } else if (pmode === "none") {
        /* not a started entry */
      } else {
        return fail7Raw(`INTEGRITY FAIL: invalid prompt_mode at line ${i}.`);
      }
      // response_hash payload check
      const rh = typeof e.response_hash === "string" ? e.response_hash : "";
      if (rh !== "") {
        if (e.type === "delegate-diff") {
          // `basename` on the READ side too (review finding F6): `diff()` stores a basename,
          // but the value being joined here comes from the FILE, so an edited entry could
          // otherwise point the audit at an arbitrary path. Same join-a-component shape as
          // issue #73; the hash chain would flag the edit, but the audit must not read
          // outside the run dir on its way to saying so.
          const pf = path.join(rd, path.basename(typeof e.patch === "string" ? e.patch : ""));
          if (!existsSync(pf)) {
            return fail7Raw(`INTEGRITY FAIL: line ${i} references patch '${path.basename(pf)}' which is MISSING — the record points at evidence that no longer exists.`);
          }
          if (sha256HexBytes(readFileSync(pf)) !== rh) {
            return fail7Raw(`INTEGRITY FAIL: patch '${path.basename(pf)}' does not match its digest (line ${i}) — the recorded diff was altered.`);
          }
        } else {
          const payloadText =
            e.type === "claude-final"
              ? typeof e.text === "string"
                ? e.text
                : ""
              : e.type === "subagent-voice"
                ? typeof e.claimed_response === "string"
                  ? e.claimed_response
                  : ""
                : typeof e.raw_response === "string"
                  ? e.raw_response
                  : "";
          if (sha256Hex(payloadText) !== rh) {
            return fail7Raw(`INTEGRITY FAIL: response_hash mismatch at line ${i} (the recorded answer does not match its digest).`);
          }
        }
      }
      prev = lineHash(line);
    }

    return {
      ok: true,
      code: 0,
      message: `ok: ${file} — ${nLines} entries, every expected call has exactly one started/completed pair, captures and hashes intact.`,
    };
  }

  /**
   * Delete run dirs older than `days` (default: the resolved `retention()` window).
   * 0 / negative / unparseable disables. Returns a `PruneResult`; never throws (C31).
   *
   * SCOPE — three fences, all load-bearing, none of them decoration:
   *   1. Only the ONE resolved logs root (`#logDir()`, i.e. `GUILD_LOG_DIR` +
   *      partitioning) is read, and only its DIRECT children. Nothing above it, and no
   *      recursive descent looking for runs.
   *   2. A child must match the minted run-id shape (log.sh's `-name '[0-9]*Z-*'`), so a
   *      user's own directory parked in the logs root survives (C32).
   *   3. A child must be a real directory by `lstat` — a SYMLINK is never followed and
   *      never removed. (`statSync` follows links: a run-id-shaped symlink into $HOME
   *      would have passed `isDirectory()`. `rmSync` would only have unlinked the link,
   *      not its target, so this was not a live bug — but the check costs nothing and
   *      the shape of the mistake is the one that matters here.)
   *
   * AGE RULE — the NEWEST mtime anywhere inside the run dir (the dir itself included),
   * not the dir's own mtime. Both were considered; newest-content wins because the run
   * dir's own mtime tracks entry creation/removal in its top level, not writes THROUGH
   * it: `calls.jsonl` is appended for the life of a run without ever restamping its
   * parent. That a `.lock` dir is made and removed beside it on every append does
   * currently bump the parent — but that is an incidental artifact of the lock protocol,
   * not something the retention rule should quietly depend on. Reading the content
   * directly is a couple of `lstat`s on a handful of small files, and it cannot be
   * invalidated by a change to how the lock works.
   */
  prune(days?: number, opts: { dryRun?: boolean } = {}): PruneResult {
    const dryRun = opts.dryRun === true;
    const res: PruneResult = {
      dir: "",
      days: 0,
      scanned: 0,
      removed: [],
      kept: 0,
      skipped: 0,
      freedBytes: 0,
      dryRun,
    };
    try {
      let window: number;
      if (days === undefined) {
        const setting = this.retention();
        window = setting.days;
        if (!setting.valid) res.invalidSetting = setting;
      } else {
        window = Number.isFinite(days) && days > 0 ? days : 0;
      }
      res.days = window;
      res.dir = this.#logDir();
      if (window <= 0) {
        res.reason = "disabled";
        return res;
      }
      if (!existsSync(res.dir)) {
        res.reason = "no-log-dir";
        return res;
      }
      const now = Date.now();
      const cutoff = now - window * 86_400_000;
      for (const name of readdirSync(res.dir)) {
        if (!RUN_DIR_RE.test(name)) continue; // fence 2
        const full = path.join(res.dir, name);
        try {
          const st = lstatSync(full); // fence 3: lstat, so a symlink is not a directory
          if (!st.isDirectory()) continue;
          res.scanned++;
          const scan = scanRunDir(full, st.mtimeMs);
          if (scan.newestMs >= cutoff) {
            res.kept++;
            continue;
          }
          // `maxRetries` is for the multi-session case (issue #80): a second session's
          // retention pass removing the same tree, or an `#ensureRun`/`acquireLock`
          // mkdir landing inside it mid-walk, surfaces as ENOTEMPTY/EBUSY — which would
          // otherwise be caught below as `skipped` with the directory left PARTLY
          // emptied. Retrying finishes the job in the ordinary case; if it still fails
          // the run is still old and still in scope, so the next pass completes it.
          if (!dryRun) rmSync(full, { recursive: true, force: true, maxRetries: 3 });
          res.removed.push({
            runId: name,
            ageDays: Math.floor((now - scan.newestMs) / 86_400_000),
            bytes: scan.bytes,
          });
          res.freedBytes += scan.bytes;
        } catch {
          res.skipped++; // unreadable or raced away — never fatal
        }
      }
      if (!dryRun && res.removed.length > 0) this.#dropDanglingLatest();
      return res;
    } catch (err) {
      warn("prune", err);
      res.reason = "error";
      res.error = String(err);
      return res;
    }
  }

  /**
   * After a prune, drop a `latest` symlink whose target no longer exists (C32).
   *
   * THIS IS HYGIENE, NOT THE GUARANTEE — the opposite of how it was first written up.
   * Since `latest()` requires the run dir to exist, a dangling pointer already reads as
   * "no latest run"; all the unlink buys is that a human listing the logs root does not
   * find a pointer to nothing. It is kept for that, and because C32 specifies it.
   *
   * ITS RESIDUAL RACE, STATED HONESTLY (corrected by review, 2026-07-28). The re-read
   * below narrows the window in which this could unlink a pointer another session just
   * repointed at a live run of its own; it does not close it — there is no
   * unlink-if-target-matches syscall. **There is no backstop for the remainder.** An
   * earlier version of this comment (and of C34) said "the next append repoints the link
   * regardless", which is FALSE precisely when the racing append was the run's LAST one —
   * the `completed` of the final call, i.e. the ordinary way a run ends. Then `latest`
   * stays absent until some later run starts, and `modelguild watch` says "no runs yet"
   * about a run that finished fine. Sub-microsecond window and no evidence at risk, but
   * a real outcome, and not one to paper over with a backstop that does not exist.
   */
  #dropDanglingLatest(): void {
    try {
      const l = path.join(this.#logDir(), "latest");
      const target = readlinkSafe(l);
      if (target === undefined) return; // not a symlink ⇒ not ours to remove
      if (existsSync(l)) return; // existsSync FOLLOWS the link ⇒ target present
      if (readlinkSafe(l) !== target) return; // repointed under us ⇒ not the link we judged
      unlinkSync(l);
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Enforce log retention once, at MCP-server start (issue #23).
 *
 * NON-FATAL BY CONSTRUCTION: `prune` already returns data instead of throwing, and this
 * wrapper catches anything the construction itself could raise. A broken logs dir must
 * never stop the server from serving.
 *
 * SKIPPED when `GUILD_LOG=off`. A user who turned logging off to FREEZE what is on disk
 * should not have the server delete it on the next start; disk hygiene for a log nobody
 * is writing is not urgent enough to override that. `logs clean` still cleans in that
 * state, because there the user asked for it in so many words.
 */
export function enforceRetentionOnStart(opts: EvidenceLogOptions = {}): PruneResult | null {
  try {
    const log = new EvidenceLog(opts);
    if (!log.enabled()) return null;
    return log.prune();
  } catch (err) {
    warn("retention-on-start", err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// module-level helpers
// ---------------------------------------------------------------------------

/** The shipped retention window, in days (C32). Documented in README.md, SECURITY.md,
 * CONTRACT.md C32 and `modelguild.conf.example` — change all five together. */
export const DEFAULT_RETENTION_DAYS = 14;

/** A minted run-id directory: starts with a digit and contains `Z-` (log.sh's
 * `-name '[0-9]*Z-*'`). The prune fence that spares a user's own dirs. */
const RUN_DIR_RE = /^[0-9].*Z-/;

/** Depth cap for the run-dir walk. A run dir is flat plus `reports/`; anything deeper is
 * not ours, and an unbounded walk on a surprise tree (or a link loop) is not something a
 * maintenance path should be able to hang on. */
const SCAN_MAX_DEPTH = 8;

/**
 * The newest mtime (ms) and total regular-file bytes inside `dir`, `dir` itself included.
 * `lstat` throughout, and directory symlinks are counted but NOT descended, so the walk
 * cannot leave the run dir or loop.
 *
 * A read error on an entry is skipped rather than thrown: a run we can only partly read
 * still yields a lower-bound-newest mtime, and erring toward "newer" means erring toward
 * KEEPING the run — the safe direction for a function whose caller deletes things.
 */
function scanRunDir(dir: string, seedMs: number, depth = 0): { newestMs: number; bytes: number } {
  let newestMs = seedMs;
  let bytes = 0;
  if (depth >= SCAN_MAX_DEPTH) return { newestMs, bytes };
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return { newestMs, bytes };
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    try {
      const st = lstatSync(full);
      if (st.mtimeMs > newestMs) newestMs = st.mtimeMs;
      if (st.isDirectory()) {
        const sub = scanRunDir(full, st.mtimeMs, depth + 1);
        if (sub.newestMs > newestMs) newestMs = sub.newestMs;
        bytes += sub.bytes;
      } else if (st.isFile()) {
        bytes += st.size;
      }
    } catch {
      /* skip unreadable entry */
    }
  }
  return { newestMs, bytes };
}

/** `date -u +%Y-%m-%dT%H:%M:%SZ` then `tr -d ':-'` ⇒ `YYYYMMDDTHHMMSSZ`. */
function nowStamp(): string {
  return nowStamp8601().replace(/[:-]/g, "");
}

/** `date -u +%Y-%m-%dT%H:%M:%SZ` (no milliseconds). */
function nowStamp8601(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Short random hex — `od -An -tx1 -N4 /dev/urandom` ⇒ 8 hex chars. */
function randHex(): string {
  return randomBytes(4).toString("hex");
}

function nullIfEmpty(s: string | undefined): JsonValue {
  return s === undefined || s === "" ? null : s;
}

/** The symlink target at `p`, or undefined when `p` is not a symlink (or unreadable).
 * One call instead of `isSymlink` + `readlinkSync`, so the two cannot disagree about a
 * path that changed between them. */
function readlinkSafe(p: string): string | undefined {
  try {
    return readlinkSync(p);
  } catch {
    return undefined;
  }
}

function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle === "") return 0;
  let count = 0;
  let pos = 0;
  for (;;) {
    const i = haystack.indexOf(needle, pos);
    if (i === -1) break;
    count++;
    pos = i + needle.length;
  }
  return count;
}

function countOccurrences2(haystack: string, re: RegExp): number {
  return (haystack.match(re) || []).length;
}

function warn(where: string, err: unknown): void {
  process.stderr.write(`modelguild: log ${where} failed (best-effort, call unaffected): ${String(err)}\n`);
}

/** True if any string in a parsed JSON value is NOT well-formed UTF-16 — i.e. carries a
 * lone/unpaired surrogate. Detected by a UTF-8 round-trip: a well-formed string encodes
 * and decodes to itself, while a lone surrogate is replaced by U+FFFD and breaks
 * equality. This is what makes TS's cleanliness check match jq, which rejects a lone
 * `\uXXXX` surrogate escape outright (verified: `jq -s` exits 5 on `\ud800`). */
function containsLoneSurrogate(value: JsonValue): boolean {
  if (typeof value === "string") {
    return Buffer.from(value, "utf8").toString("utf8") !== value;
  }
  if (Array.isArray(value)) {
    return value.some(containsLoneSurrogate);
  }
  if (value !== null && typeof value === "object") {
    for (const k of Object.keys(value)) {
      // Keys are strings too; a lone surrogate in a key is just as invalid to jq.
      if (Buffer.from(k, "utf8").toString("utf8") !== k) return true;
      if (containsLoneSurrogate((value as { [key: string]: JsonValue })[k])) return true;
    }
  }
  return false;
}

/**
 * Bound and SANITIZE a synthesized free-text evidence field (`incomplete_detail`) to at most
 * `max` CODE POINTS, dropping any unpaired surrogate.
 *
 * This is the C25/jq scar pointed at our own writes. A naive `s.slice(0, max)` cuts UTF-16
 * code UNITS, so a text whose astral character straddles the boundary is truncated INTO a lone
 * high surrogate. `verify` would then fail the run with "is not clean JSONL" instead of the
 * capture-completeness failure the entry exists to raise — and worse, `jq` errors the ENTIRE
 * `calls.jsonl` stream on a lone surrogate, so a field added to protect the receipts would
 * have damaged the file holding them. Iterating with the spread operator walks code points, so
 * a surrogate PAIR is never split; the explicit unpaired-surrogate drop covers one that was
 * already unpaired in the input (a crash message quoting a path with an invalid name).
 *
 * SANITIZING IS ONLY LEGITIMATE BECAUSE THIS FIELD IS OURS. `raw_response` / `claimed_response`
 * are receipts of another party's words and are recorded byte-exact precisely so verify can
 * catch what they contain (test 2b pins that a lone surrogate in a model reply FAILS). This
 * field is a diagnostic string this process composes from an Error; nothing is lost by making
 * it well-formed, and a mangled one would misreport why the run failed.
 */
function boundedDetail(s: string, max = 1000): string {
  const out: string[] = [];
  for (const cp of s) {
    if (out.length >= max) break;
    const c = cp.codePointAt(0) as number;
    if (c >= 0xd800 && c <= 0xdfff) continue; // unpaired surrogate (a pair yields one cp > 0xFFFF)
    out.push(cp);
  }
  return out.join("");
}

function fail(msg: string): WriteResult {
  process.stderr.write(`modelguild: log ${msg}\n`);
  return { ok: false, error: msg };
}

function fail7(file: string, msg: string): VerifyResult {
  return { ok: false, code: 7, message: `INTEGRITY FAIL: ${file} ${msg}` };
}
function fail7Raw(msg: string): VerifyResult {
  return { ok: false, code: 7, message: msg };
}

// ---------------------------------------------------------------------------
// lock (mkdir-based, stale steal, ~10s give-up), shared protocol with bash.
// ---------------------------------------------------------------------------

/**
 * Stale-lock steal threshold: 120s, NOT 60s.
 *
 * log.sh steals with `find "$lock" -mmin +1`, and its comment calls that "older than a
 * minute" — but that comment MISLABELS find's rounding. `-mmin +1` means the age in
 * WHOLE minutes is strictly greater than 1, i.e. age ≥ 2 minutes, i.e. > 120s. Measured
 * on this runner: a lock mtime'd 61s ago → no match, 105s ago → no match, 130s ago →
 * match. So bash actually steals at ~120s. We match the OBSERVED bash behavior, not its
 * comment. DO NOT "correct" this back to 60s — that would make TS steal a lock bash
 * still considers live, and the two writers would diverge on a shared run. (The bash
 * source is deliberately left unchanged; this comment is the record.)
 */
const LOCK_STALE_MS = 120_000;
const LOCK_POLL_MS = 50;
const LOCK_MAX_TRIES = 200; // ~10s

/** Acquire `<file>.lock` by mkdir. Returns false after ~10s of contention (caller then
 * DROPS the entry). Async so the wait yields the event loop rather than blocking a
 * server; the mkdir itself is atomic, so concurrent in-process appends serialize too. */
async function acquireLock(lock: string): Promise<boolean> {
  let tries = 0;
  for (;;) {
    try {
      mkdirSync(lock); // atomic: throws if it already exists
      return true;
    } catch {
      // Steal a stale lock (older than ~120s, matching bash's find -mmin +1; see the
      // LOCK_STALE_MS rationale) — a crashed writer's, not a live one's.
      try {
        const st = statSync(lock);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          try {
            rmSync(lock, { recursive: true, force: true });
          } catch {
            /* another writer won the steal — retry */
          }
          continue;
        }
      } catch {
        // lock vanished between mkdir and stat — retry immediately
        continue;
      }
      tries++;
      if (tries > LOCK_MAX_TRIES) return false;
      await sleep(LOCK_POLL_MS);
    }
  }
}

function releaseLock(lock: string): void {
  try {
    rmSync(lock, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
