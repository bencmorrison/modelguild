/**
 * Config & model resolution port (CONTRACT.md area B, C8–C14).
 *
 * Oracle: `ask.sh` (`conf_get`, default-model precedence, the leading-`-`
 * refusal) and `panel-models.sh` (panel-set resolution + diversity warnings).
 *
 * `conf_get` is deliberately REUSED from `src/log.ts` (`confGet`) rather than
 * re-implemented: C11 requires the parser be byte-identical everywhere it appears, and
 * the surest way to hold that in the TS layer is a single implementation. `log.ts`'s
 * `confGet` already matches `ask.sh`'s awk (leading-ws strip on key, inline `# comment`
 * strip, one layer of surrounding quotes, last-assignment-wins) — verified against the
 * awk source. This module adds only what M4 needs on top: file/root resolution, the
 * default-model precedence chain, the flag-injection guard, and the panel set.
 */

import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { confGet } from "./log.js";
import { bashGlobMatch } from "./policy.js";
import { MESSAGE_HTTP_MS } from "./client.js";

export { confGet };

/* ---------------------------------------------------------------------------
 * Guild-root resolution — LAYERED (issue #19).
 *
 * The bash scripts resolved their config/policy/log siblings via `dirname "$0"` — one
 * directory, whichever install was running. The TS server first reproduced that as a
 * SINGLE-root, first-match chain (`$GUILD_ROOT` → `<cwd>/modelguild/` →
 * `~/.claude/modelguild/`), which meant a project's `modelguild/` SHADOWED the global one
 * entirely: install per-project and your carefully-set global model policy and preferences
 * silently stopped binding.
 *
 * Resolution is now LAYERED. The global install is the BASELINE; the project overrides and
 * extends it. `layeredRoots()` returns the read layers MOST-SPECIFIC FIRST:
 *     1. `<cwd>/modelguild/`      — the project layer (if it exists on disk)
 *     2. `~/.claude/modelguild/`  — the global baseline layer
 * and the consumers combine them per their own merge rule:
 *   - preferences (`modelguild.conf.local`): global read first, project overlaid on top —
 *     a project key wins, an unset key falls THROUGH to global (`readLayeredConfContents`).
 *   - model policy: project rules evaluated first, then global, then default-allow
 *     (`policyTierAcross` in policy.ts). The project can add a stricter deny or a looser
 *     allow on top of the global baseline.
 *
 * `$GUILD_ROOT` IS A SINGLE-ROOT OVERRIDE — DELIBERATE, NOT AN OVERSIGHT (decided for
 * issue #19). When it is set, `layeredRoots()` returns EXACTLY that one root: no global
 * baseline is layered under it. Rationale: the knob's whole purpose is "read config from
 * HERE and nowhere else" — a test fixture, a CI sandbox, a deliberately isolated root.
 * Silently layering `~/.claude/modelguild/` beneath it would make an explicitly-pinned root
 * non-hermetic and would surprise exactly the caller who was most explicit. The cost is
 * stated rather than hidden: with `$GUILD_ROOT` set you get NO global baseline, so a global
 * deny does not bind — `resolveRootWithConflict` surfaces that as a note when other roots
 * exist on disk. (`$GUILD_POLICY`/`$GUILD_CONF` behave the same way for the same reason:
 * an explicit FILE is the whole answer, not a top layer.)
 *
 * `resolveGuildRoot()` remains the PRIMARY root — `layeredRoots()[0]`, i.e. the
 * most-specific layer, falling back to the home root when nothing exists yet. It is what
 * WRITES use (the evidence log's `logs/` dir) and what `doctor`/`guild_status` report as
 * "the root in effect". Reads use the layers.
 *
 * TRUST: `$GUILD_ROOT` redirects where the policy AND config are read from, so it is a
 * control over the security policy. That grants NO new privilege: it is env-tier,
 * exactly like the already-conceded `$GUILD_POLICY` — anyone who can set process env
 * can already point policy resolution wherever they like, so redirecting the root is
 * the same authority by another lever, not an escalation. Note the cwd-relative project
 * layer: with no `$GUILD_ROOT`, which project layer applies depends on the process's CWD,
 * so the caller must invoke from the intended project.
 * --------------------------------------------------------------------------- */
export type RootSource = "env" | "project" | "home";

export interface GuildRoot {
  root: string;
  source: RootSource;
}

/**
 * The ordered READ layers, MOST-SPECIFIC FIRST. `$GUILD_ROOT` ⇒ exactly one layer (a
 * single-root override — see the block comment). Otherwise the project layer (when
 * `<cwd>/modelguild/` exists) sits above the global baseline (when
 * `~/.claude/modelguild/` exists). Never empty: with neither on disk it returns the home
 * root alone, so there is always a primary root to name and to write logs under.
 */
export function layeredRoots(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
  home: string = os.homedir(),
): GuildRoot[] {
  const override = env.GUILD_ROOT;
  if (override && override.length > 0) return [{ root: override, source: "env" }];
  const out: GuildRoot[] = [];
  const project = path.join(cwd, "modelguild");
  if (existsSync(project)) out.push({ root: project, source: "project" });
  const globalRoot = path.join(home, ".claude", "modelguild");
  if (existsSync(globalRoot)) out.push({ root: globalRoot, source: "home" });
  // Nothing on disk yet: the home root is still the primary (where an install would land).
  if (out.length === 0) out.push({ root: globalRoot, source: "home" });
  return out;
}

/**
 * The PRIMARY root — the most-specific layer. Writes (the evidence log's `logs/` dir) go
 * here, and this is the root `doctor`/`guild_status` name as "in effect". Identical to the
 * pre-layering single-root chain by construction (`layeredRoots()[0]`).
 */
export function resolveGuildRoot(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
  home: string = os.homedir(),
): GuildRoot {
  return layeredRoots(env, cwd, home)[0];
}

/**
 * Every root that exists on disk, precedence order — INCLUDING the ones `$GUILD_ROOT`
 * excludes from layering. `layeredRoots()` says what actually binds; this says what is
 * THERE, so `resolveRootWithConflict` can tell the user when an explicit `$GUILD_ROOT`
 * is leaving a real global baseline unlayered.
 */
export function candidateRoots(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
  home: string = os.homedir(),
): GuildRoot[] {
  const out: GuildRoot[] = [];
  const override = env.GUILD_ROOT;
  if (override && override.length > 0) out.push({ root: override, source: "env" });
  const project = path.join(cwd, "modelguild");
  if (existsSync(project)) out.push({ root: project, source: "project" });
  const home2 = path.join(home, ".claude", "modelguild");
  if (existsSync(home2)) out.push({ root: home2, source: "home" });
  return out;
}

/* ---------------------------------------------------------------------------
 * Agent-def-dir resolution + hardened-def presence (CONTRACT.md C16 lever).
 *
 * bash `ask.sh` computes `agent_def_dir="${GUILD_AGENT_DIR:-$(conf_get GUILD_AGENT_DIR)}"`
 * and falls back to the sibling `$(dirname "$0")/../.opencode/agent`, then checks
 * `[ -f "$agent_def_dir/<agent>.md" ]`. The TS server has no fixed sibling, so the
 * "sibling" here is the serve's PROJECT dir (`$GUILD_PROJECT_DIR` else cwd — the exact
 * value `lifecycle.ts` spawns `opencode serve` from) plus `.opencode/agent`.
 *
 * WHAT THIS ACTUALLY OBSERVES (the honest bound). This is a FILESYSTEM presence check of
 * the def FILE — the same and only lever bash's C16 uses. It does NOT — and cannot —
 * observe opencode's own `--agent` resolution: opencode resolves the agent from ITS OWN
 * config, independently. So if `GUILD_AGENT_DIR` points somewhere other than where
 * opencode actually resolves defs, this check and opencode can disagree (a caveat bash
 * carries too — AGENTS.md). It governs the tool's refusal decision ONLY, exactly as C16
 * says the bash check governs only the fallback decision.
 * --------------------------------------------------------------------------- */
export function resolveAgentDefDir(opts: {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  confContents?: string;
  /**
   * The directory the serve child will actually be spawned from (issue #96). Normally the
   * project dir — but a worktree-targeted read call re-roots the child at a validated
   * sibling worktree, and **opencode resolves agents from the SERVE's cwd, not from the git
   * repository**: probed live on 1.18.7 (2026-07-29), a serve rooted at a worktree of a repo
   * whose MAIN checkout holds `.opencode/agent/guild-read.md` does not list `guild-read` at
   * all (`GET /agent`), and a message naming it answers HTTP 500. So the presence pre-check
   * must follow the child, or it would pass on the project's copy and the turn would then
   * die on an unresolvable agent. Overrides the `$GUILD_PROJECT_DIR`/cwd sibling; still
   * loses to an explicit `GUILD_AGENT_DIR` (env or conf), which means "look here, nowhere
   * else" — with the caveat this block already carries, that such an override can disagree
   * with where opencode actually resolves defs.
   */
  projectDir?: string;
}): string {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const override = env.GUILD_AGENT_DIR;
  if (override && override.length > 0) return override;
  const fromConf = confGet(opts.confContents ?? "", "GUILD_AGENT_DIR");
  if (fromConf.length > 0) return fromConf;
  // The sibling: the project dir the serve is spawned from (matches lifecycle.ts).
  const projectDir =
    opts.projectDir && opts.projectDir.length > 0
      ? opts.projectDir
      : env.GUILD_PROJECT_DIR && env.GUILD_PROJECT_DIR.length > 0
        ? env.GUILD_PROJECT_DIR
        : cwd;
  return path.join(projectDir, ".opencode", "agent");
}

/** True iff the hardened agent's def file (`<agent>.md`) exists in the resolved dir. */
export function hardenedDefPresent(
  agent: string,
  agentDefDir: string,
): boolean {
  return existsSync(path.join(agentDefDir, `${agent}.md`));
}

/**
 * The ORDERED list of dirs to look for a hardened def in — mirroring opencode's own
 * `--agent` resolution so a GLOBAL install doesn't cause a FALSE refusal.
 *
 * With a global-only payload, the def lives in the opencode GLOBAL agent dir
 * (`${XDG_CONFIG_HOME:-~/.config}/opencode/agent/`), while the serve's PROJECT dir
 * `.opencode/agent/` is empty. `resolveAgentDefDir` returns only the project sibling, so a
 * project-only presence check would refuse even though opencode itself resolves the def
 * globally. This returns [project-sibling (or GUILD_AGENT_DIR override / conf), global
 * opencode dir], de-duped, so `hardenedDefPresentIn` matches wherever opencode actually
 * finds it. Still fail-closed: absent in BOTH ⇒ the tool refuses.
 */
export function resolveAgentDefDirs(opts: {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  confContents?: string;
  home?: string;
  xdgConfigHome?: string;
  /** Where the serve child will be rooted (issue #96) — see `resolveAgentDefDir`. */
  projectDir?: string;
}): string[] {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const primary = resolveAgentDefDir({
    env,
    cwd,
    confContents: opts.confContents,
    ...(opts.projectDir !== undefined ? { projectDir: opts.projectDir } : {}),
  });
  const home = opts.home ?? os.homedir();
  const xdg =
    opts.xdgConfigHome && opts.xdgConfigHome.length > 0
      ? opts.xdgConfigHome
      : env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.length > 0
        ? env.XDG_CONFIG_HOME
        : path.join(home, ".config");
  const global = path.join(xdg, "opencode", "agent");
  return primary === global ? [primary] : [primary, global];
}

/** First dir (in order) whose `<agent>.md` exists, else `{ present: false }`. Fail-closed. */
export function hardenedDefPresentIn(
  agent: string,
  agentDefDirs: string[],
): { present: boolean; dir?: string } {
  for (const d of agentDefDirs) {
    if (existsSync(path.join(d, `${agent}.md`))) return { present: true, dir: d };
  }
  return { present: false };
}

/* ---------------------------------------------------------------------------
 * Config-file resolution (C9): `$GUILD_CONF` if set, else `<root>/modelguild.conf.local`.
 * Parsed, NEVER sourced.
 * --------------------------------------------------------------------------- */
export function resolveConfFile(
  guildDir: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const override = env.GUILD_CONF;
  if (override && override.length > 0) return override;
  const local = path.join(guildDir, "modelguild.conf.local");
  return existsSync(local) ? local : undefined;
}

/** Contents of the resolved config file, or "" when there is none / it is unreadable.
 * (bash `conf_get` short-circuits on a missing file and awk on an unreadable one, both
 * yielding "no value"; an empty string produces exactly that from `confGet`.) */
export function readConfContents(
  guildDir: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const file = resolveConfFile(guildDir, env);
  if (!file) return "";
  try { return readFileSync(file, "utf8"); } catch { return ""; }
}

/**
 * The config files that contribute, MOST-SPECIFIC FIRST (issue #19). `$GUILD_CONF` is a
 * single-FILE override — exactly one file, no layering under it (same reasoning as
 * `$GUILD_ROOT`: an explicit file is the whole answer). Otherwise: each root's
 * `modelguild.conf.local` that exists, in the roots' order.
 */
export function resolveConfFiles(
  guildDirs: string[],
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const override = env.GUILD_CONF;
  if (override && override.length > 0) return [override];
  const out: string[] = [];
  for (const dir of guildDirs) {
    const local = path.join(dir, "modelguild.conf.local");
    if (existsSync(local) && !out.includes(local)) out.push(local);
  }
  return out;
}

/**
 * LAYERED preference contents: the global baseline read first, each more-specific layer
 * overlaid on top — so a project key WINS and an unset key falls THROUGH to global.
 *
 * The overlay is done by CONCATENATION, least-specific first, deliberately: `confGet`'s
 * documented semantics are LAST-ASSIGNMENT-WINS (C10), so appending the project's file
 * after the global one yields exactly "project key overrides, unset key inherited" with no
 * second merge implementation to drift from the parser. Every consumer already threads a
 * single `confContents` string, so nothing downstream changes shape.
 *
 * A `\n` separator is inserted between files so a final line lacking a trailing newline in
 * one layer can never fuse with the first line of the next.
 */
export function readLayeredConfContents(
  guildDirs: string[],
  env: NodeJS.ProcessEnv = process.env,
): string {
  const files = resolveConfFiles(guildDirs, env);
  const parts: string[] = [];
  // Least-specific first: reverse the most-specific-first file list.
  for (const file of [...files].reverse()) {
    try { parts.push(readFileSync(file, "utf8")); } catch { /* unreadable ⇒ contributes nothing */ }
  }
  return parts.join("\n");
}

/* ---------------------------------------------------------------------------
 * Per-model-turn HTTP timeout (`GUILD_MESSAGE_TIMEOUT_MS`).
 *
 * The message POST is the long call — a heavy task on a slow reasoning model can
 * legitimately exceed the 15-min default (`client.ts` `MESSAGE_HTTP_MS`) and abort with
 * "operation was aborted due to timeout". This knob raises (or lowers) that ceiling
 * with the standard chain: env override > conf `GUILD_MESSAGE_TIMEOUT_MS` > default.
 * ONLY the model-turn POST uses it; the fast control-plane calls (session
 * create/delete, history fetch, health) keep their own `SHORT_HTTP_MS`.
 *
 * The literal `max` (case-insensitive, trimmed) resolves to `TIMER_MAX_MS` — the longest
 * delay Node can honour (~24.8 days), i.e. "effectively never abort a working model". The
 * trade-off is explicit: a genuinely HUNG turn then blocks until that ceiling, so `max` is
 * for someone who would rather wait than lose a long, expensive turn to the clock.
 *
 * VALIDATION — fail SAFE to the default: a numeric value must be a positive number of ms.
 * 0, negative, and non-numeric (other than `max`) all fall back to the default. 0 is
 * deliberately NOT a "disable timeout" — `AbortSignal.timeout(0)` fires immediately
 * (aborting every turn), and there is no no-timeout path (a hung model turn must eventually
 * abort). Number() (not parseInt) so a trailing-garbage value like "900000abc" is rejected,
 * matching the `envInt` idiom in `lifecycle.ts`.
 *
 * A valid numeric value is CLAMPED to `TIMER_MAX_MS` (2^31 - 1). Node's timer subsystem —
 * `setTimeout`, hence `AbortSignal.timeout` — holds the delay in a signed 32-bit int:
 * a larger delay triggers a TimeoutOverflowWarning and is silently clamped to ~1ms, so
 * a user who adds a digit to RAISE the timeout would instead get every turn aborted
 * immediately. Capping gives them the longest delay Node can honour rather than that trap
 * (and rather than a silent revert to the default, which is not what "very long" asked for).
 * --------------------------------------------------------------------------- */
export const TIMER_MAX_MS = 2 ** 31 - 1;

/**
 * Shared core: parse a raw timeout token to a capped positive ms value, or `null` if
 * invalid. The env/conf knob (invalid → default) and the per-call tool param (invalid →
 * tool error) both go through this so `max`/cap/positivity are IDENTICAL on both paths.
 * `max` (trimmed, case-insensitive) → `TIMER_MAX_MS`; a positive finite number →
 * `min(n, TIMER_MAX_MS)`; 0, negative, and non-numeric → `null`. `Number` (not parseInt)
 * so trailing garbage ("900000abc") is rejected.
 *
 * EXPORTED so `src/approve.ts` resolves `GUILD_APPROVE_TIMEOUT_MS` through this same core:
 * a second coercion would be free to drift on the cap, on `max`, and on the positivity rule
 * — and the approval timeout is the fail-closed deadline, the last knob that should have its
 * own parsing quirks.
 */
export function coerceTimeoutMs(raw: string): number | null {
  if (raw.trim().toLowerCase() === "max") return TIMER_MAX_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.min(n, TIMER_MAX_MS) : null;
}

export function resolveMessageTimeoutMs(opts: {
  env?: NodeJS.ProcessEnv;
  confContents?: string;
  fallback?: number;
}): number {
  const env = opts.env ?? process.env;
  const fallback = opts.fallback ?? MESSAGE_HTTP_MS;
  const fromEnv = env.GUILD_MESSAGE_TIMEOUT_MS;
  const raw =
    fromEnv && fromEnv.length > 0
      ? fromEnv
      : confGet(opts.confContents ?? "", "GUILD_MESSAGE_TIMEOUT_MS");
  if (raw.length === 0) return fallback;
  // Knob path is LENIENT: an unusable env/conf value falls SAFE to the default.
  return coerceTimeoutMs(raw) ?? fallback;
}

/**
 * Validate a PER-CALL `timeoutMs` tool input (number or the string `"max"`). Unlike the
 * env/conf knob, this path is STRICT: a per-call value is an explicit ask by the calling
 * agent, so an invalid one is a tool INPUT ERROR (surfaced to the caller), NOT a silent
 * fall-through to the default. Returns the resolved (capped) ms on success. A number is
 * validated through the same `coerceTimeoutMs` core as strings so `"max"`, the 2^31-1 cap,
 * and the positivity rule are identical to the knob.
 */
export function parsePerCallTimeoutMs(
  value: unknown,
): { ok: true; value: number } | { ok: false; error: string } {
  if (typeof value !== "number" && typeof value !== "string") {
    // Name the value too (short) so every invalid path reports field + value + accepted inputs.
    const shown =
      value === null || value === undefined ? String(value) : JSON.stringify(value);
    return {
      ok: false,
      error: `timeoutMs '${shown}' is invalid (got ${typeof value}) — pass a positive number of milliseconds or the string "max".`,
    };
  }
  const coerced = coerceTimeoutMs(typeof value === "number" ? String(value) : value);
  if (coerced === null) {
    return {
      ok: false,
      error: `timeoutMs '${String(value)}' is invalid — pass a positive number of milliseconds (capped at ${TIMER_MAX_MS}) or the string "max".`,
    };
  }
  return { ok: true, value: coerced };
}

/* ---------------------------------------------------------------------------
 * Live-activity knobs (issue #20) — `GUILD_ACTIVITY`, `GUILD_ACTIVITY_DETAIL`.
 *
 * Same chain as every other knob: env override > `modelguild.conf.local` > default.
 *
 * `GUILD_ACTIVITY` defaults to **on**. Visibility into what an external model is doing is
 * the point of the feature and it is capability-NEUTRAL: it removes nothing from the
 * external path and adds no gate. `off` disables the layer entirely — no `/event`
 * subscription is opened, no `activity.jsonl` is written, no `structuredContent.activity`
 * is attached. The `off` test mirrors `GUILD_LOG`'s exactly (only the literal `off`
 * disables, so a typo fails toward recording rather than toward silence).
 *
 * `GUILD_ACTIVITY_DETAIL` defaults to **summary**: the tool name plus a TRUNCATED
 * rendering of its input. `full` additionally records each event's raw properties, which
 * can carry tool OUTPUT — i.e. file contents the model read. That is the same sensitivity
 * class as `GUILD_LOG_PROMPTS=full`, and the conf template says so. Anything other than
 * the literal `full` resolves to `summary` (the same lenient shape as `#promptMode`).
 * --------------------------------------------------------------------------- */
export type ActivityDetail = "summary" | "full";

export interface ActivitySettings {
  enabled: boolean;
  detail: ActivityDetail;
}

export function resolveActivitySettings(opts: {
  env?: NodeJS.ProcessEnv;
  confContents?: string;
} = {}): ActivitySettings {
  const env = opts.env ?? process.env;
  const conf = opts.confContents ?? "";
  const pick = (key: string, def: string): string => {
    const fromEnv = env[key];
    if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
    const fromConf = confGet(conf, key);
    return fromConf !== "" ? fromConf : def;
  };
  const enabled = pick("GUILD_ACTIVITY", "on").trim().toLowerCase() !== "off";
  const detail = pick("GUILD_ACTIVITY_DETAIL", "summary").trim().toLowerCase() === "full"
    ? "full"
    : "summary";
  return { enabled, detail };
}

/* ---------------------------------------------------------------------------
 * Default-model precedence (C8): `-m` flag > `$GUILD_MODEL` env > conf `GUILD_MODEL`
 * > opencode's own default (empty). `flag` is the value of an explicit `-m`; `undefined`
 * means none was given (an EMPTY `-m` value is a usage error handled by the caller's
 * arg parser, not here).
 * --------------------------------------------------------------------------- */
export function resolveModel(opts: {
  flag?: string;
  env?: NodeJS.ProcessEnv;
  confContents?: string;
}): string {
  if (opts.flag !== undefined && opts.flag !== "") return opts.flag;
  const env = opts.env ?? process.env;
  const fromEnv = env.GUILD_MODEL;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return confGet(opts.confContents ?? "", "GUILD_MODEL");
}

/**
 * Leading-`-` model-id guard (C12). A model id from env/config bypasses the `-m`
 * `need_arg` check and, if it began with `-`, would be emitted as an unintended
 * opencode flag. bash refuses with exit 2. `source` distinguishes this from the CLI
 * `-m` path (a missing/`-`-leading `-m` VALUE is a usage error, exit 1 — the caller's
 * concern). A resolved model that is safe returns `{ ok: true }`.
 */
export interface ModelIdCheck {
  ok: boolean;
  /** The exit code the bash wrapper would use: 2 for the env/config leading-dash. */
  exitCode?: number;
  reason?: string;
}

export function checkResolvedModelId(model: string): ModelIdCheck {
  if (model.startsWith("-")) {
    return {
      ok: false,
      exitCode: 2,
      reason: `model id '${model}' starts with '-' (from env or config) — refusing to avoid injecting an opencode flag.`,
    };
  }
  return { ok: true };
}

/* ---------------------------------------------------------------------------
 * Panel set resolution (C13/C14) — port of `panel-models.sh`.
 *
 * Precedence: explicit args > `$GUILD_MODELS` env > conf `GUILD_MODELS`. Commas OR
 * spaces separate; order is preserved. De-dup keeps first-seen order (each dropped dup
 * warned); warns on <2 distinct models, on an all-one-provider set ("diversity
 * theater"), and on a token that is not `provider/model`. `error` (with exit 2) when no
 * models at all. It does NOT consult the model policy — that is per-call in ask.sh.
 * --------------------------------------------------------------------------- */
export interface PanelResult {
  models: string[];
  warnings: string[];
  /** Present iff no models resolved; the bash exits 2. */
  error?: string;
  exitCode?: number;
}

export function resolvePanelModels(opts: {
  args?: string[];
  env?: NodeJS.ProcessEnv;
  confContents?: string;
}): PanelResult {
  const env = opts.env ?? process.env;
  // Source list in precedence order; `raw="$*"` joins args on a space.
  let raw: string;
  if (opts.args && opts.args.length > 0) raw = opts.args.join(" ");
  else {
    const fromEnv = env.GUILD_MODELS;
    raw = fromEnv && fromEnv.length > 0 ? fromEnv : confGet(opts.confContents ?? "", "GUILD_MODELS");
  }
  // Commas → spaces, then split on whitespace, dropping empties (mirrors bash `for m in
  // $raw` under default IFS after `raw="${raw//,/ }"`).
  const tokens = raw.replace(/,/g, " ").split(/\s+/).filter((t) => t.length > 0);

  const warnings: string[] = [];
  const models: string[] = [];
  const seen = new Set<string>();
  for (const m of tokens) {
    if (seen.has(m)) {
      warnings.push(`duplicate model '${m}' dropped (a panel of the same model isn't diverse).`);
      continue;
    }
    // `?*/?*` — provider/model shape. A bad token is WARNED but still kept (bash does
    // not `continue` here).
    if (!bashGlobMatch("?*/?*", m)) {
      warnings.push(`'${m}' doesn't look like a provider/model id — ask.sh/opencode will likely reject it.`);
    }
    seen.add(m);
    models.push(m);
  }

  if (models.length === 0) {
    return {
      models,
      warnings,
      error: "no models. Pass provider/model ids, set GUILD_MODELS, or add a GUILD_MODELS= line to modelguild/modelguild.conf.local.",
      exitCode: 2,
    };
  }
  if (models.length < 2) {
    warnings.push(`only ${models.length} model resolved — a panel wants 2-3 from different families for genuine diversity.`);
  }
  // provider = `${m%%/*}` (everything before the first `/`).
  const providers = models.map((m) => m.split("/")[0]);
  const distinct = new Set(providers);
  if (models.length >= 2 && distinct.size === 1) {
    warnings.push(`all ${models.length} models are from provider '${providers[0]}' — that's single-family, not cross-provider diversity (risks 'diversity theater').`);
  }
  return { models, warnings };
}
