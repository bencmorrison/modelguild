/**
 * Config & model-resolution port tests (CONTRACT.md area B, C8–C14) — OFFLINE.
 *
 * `conf_get` byte-identity (C11) is held by REUSE — `config.ts` re-exports `log.ts`'s
 * `confGet`, so there is one parser. Panel resolution (C13/C14) is unit-tested directly
 * against `resolvePanelModels` (the reference implementation; the bash `panel-models.sh`
 * oracle it was ported against retired at M12). No model is called.
 */

import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  confGet,
  resolveModel,
  resolveMessageTimeoutMs,
  parsePerCallTimeoutMs,
  TIMER_MAX_MS,
  checkResolvedModelId,
  resolveCollabRoot,
  candidateRoots,
  layeredRoots,
  resolveConfFile,
  resolveConfFiles,
  readConfContents,
  readLayeredConfContents,
  resolvePanelModels,
  resolveAgentDefDirs,
  hardenedDefPresentIn,
} from "../src/config.js";
import { MESSAGE_HTTP_MS } from "../src/client.js";
import { Checker } from "./harness.js";

const tmpDirs: string[] = [];
function tmp(prefix = "m4cfg-"): string {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
function cleanup(): void {
  for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* noop */ } }
}

export async function run(): Promise<number> {
  const t = new Checker();

  try {
    // ---- conf_get (C10/C11), re-pinning run-tests.sh 21b et al. -----------------
    t.check(confGet("GUILD_MODEL=openai/gpt-5\n", "GUILD_MODEL") === "openai/gpt-5",
      "confGet: plain KEY=value");
    t.check(confGet("GUILD_MODEL=openai/commented   # my default\n", "GUILD_MODEL") === "openai/commented",
      "confGet: inline '# comment' stripped (run-tests 21b)");
    t.check(confGet('GUILD_MODEL="openai/quoted"\n', "GUILD_MODEL") === "openai/quoted",
      "confGet: one layer of double quotes stripped");
    t.check(confGet("GUILD_MODEL=openai/a\nGUILD_MODEL=openai/b\n", "GUILD_MODEL") === "openai/b",
      "confGet: last assignment wins");
    t.check(confGet("   GUILD_MODEL = openai/x\n", "GUILD_MODEL") === "openai/x",
      "confGet: leading whitespace + spaces around key/value tolerated");
    t.check(confGet("# GUILD_MODEL=nope\n", "GUILD_MODEL") === "",
      "confGet: commented line ignored");
    t.check(confGet("", "GUILD_MODEL") === "", "confGet: absent key → empty");

    // ---- resolveModel precedence (C8): flag > env > conf > "" -------------------
    const conf = "GUILD_MODEL=openai/from-conf\n";
    t.check(resolveModel({ flag: "openai/from-flag", env: { GUILD_MODEL: "openai/from-env" } as NodeJS.ProcessEnv, confContents: conf }) === "openai/from-flag",
      "resolveModel: -m flag wins");
    t.check(resolveModel({ env: { GUILD_MODEL: "openai/from-env" } as NodeJS.ProcessEnv, confContents: conf }) === "openai/from-env",
      "resolveModel: $GUILD_MODEL over conf (run-tests 21)");
    t.check(resolveModel({ env: {} as NodeJS.ProcessEnv, confContents: conf }) === "openai/from-conf",
      "resolveModel: conf file supplies default (run-tests 21)");
    t.check(resolveModel({ env: {} as NodeJS.ProcessEnv, confContents: "" }) === "",
      "resolveModel: nothing set → empty (opencode default)");

    // ---- resolveMessageTimeoutMs: env > conf > default, fail-safe on garbage -----
    const tConf = "GUILD_MESSAGE_TIMEOUT_MS=300000\n";
    const noEnv = {} as NodeJS.ProcessEnv;
    // The ACTUAL default (no explicit fallback) is MESSAGE_HTTP_MS — guards the 15-min value.
    t.check(resolveMessageTimeoutMs({ env: {} as NodeJS.ProcessEnv, confContents: "" }) === MESSAGE_HTTP_MS,
      "resolveMessageTimeoutMs: nothing set → MESSAGE_HTTP_MS default");
    t.check(MESSAGE_HTTP_MS === 900000,
      "MESSAGE_HTTP_MS default is 900000 (15 min)");
    t.check(resolveMessageTimeoutMs({ env: {} as NodeJS.ProcessEnv, confContents: "", fallback: 900000 }) === 900000,
      "resolveMessageTimeoutMs: nothing set → explicit fallback");
    t.check(resolveMessageTimeoutMs({ env: { GUILD_MESSAGE_TIMEOUT_MS: "600000" } as NodeJS.ProcessEnv, confContents: tConf, fallback: 900000 }) === 600000,
      "resolveMessageTimeoutMs: env wins over conf");
    t.check(resolveMessageTimeoutMs({ env: noEnv, confContents: tConf, fallback: 900000 }) === 300000,
      "resolveMessageTimeoutMs: conf supplies value over default");
    t.check(resolveMessageTimeoutMs({ env: { GUILD_MESSAGE_TIMEOUT_MS: "" } as NodeJS.ProcessEnv, confContents: tConf, fallback: 900000 }) === 300000,
      "resolveMessageTimeoutMs: empty env string ignored, falls through to conf");
    t.check(resolveMessageTimeoutMs({ env: { GUILD_MESSAGE_TIMEOUT_MS: "nonsense" } as NodeJS.ProcessEnv, confContents: "", fallback: 900000 }) === 900000,
      "resolveMessageTimeoutMs: non-numeric → default (fail-safe)");
    t.check(resolveMessageTimeoutMs({ env: { GUILD_MESSAGE_TIMEOUT_MS: "900000abc" } as NodeJS.ProcessEnv, confContents: "", fallback: 900000 }) === 900000,
      "resolveMessageTimeoutMs: trailing-garbage rejected (Number, not parseInt)");
    t.check(resolveMessageTimeoutMs({ env: { GUILD_MESSAGE_TIMEOUT_MS: "0" } as NodeJS.ProcessEnv, confContents: "", fallback: 900000 }) === 900000,
      "resolveMessageTimeoutMs: 0 → default (not disable; AbortSignal.timeout(0) would fire immediately)");
    t.check(resolveMessageTimeoutMs({ env: { GUILD_MESSAGE_TIMEOUT_MS: "-5" } as NodeJS.ProcessEnv, confContents: "", fallback: 900000 }) === 900000,
      "resolveMessageTimeoutMs: negative → default (fail-safe)");
    t.check(resolveMessageTimeoutMs({ env: { GUILD_MESSAGE_TIMEOUT_MS: "9999999999999" } as NodeJS.ProcessEnv, confContents: "", fallback: 900000 }) === 2147483647,
      "resolveMessageTimeoutMs: overflow (> 2^31-1) → capped at 2147483647, NOT default (Node timer ceiling)");
    t.check(resolveMessageTimeoutMs({ env: { GUILD_MESSAGE_TIMEOUT_MS: "max" } as NodeJS.ProcessEnv, confContents: "", fallback: 900000 }) === 2147483647,
      "resolveMessageTimeoutMs: literal 'max' → the 2^31-1 timer ceiling");
    t.check(resolveMessageTimeoutMs({ env: { GUILD_MESSAGE_TIMEOUT_MS: "  MAX  " } as NodeJS.ProcessEnv, confContents: "", fallback: 900000 }) === 2147483647,
      "resolveMessageTimeoutMs: 'max' is trimmed + case-insensitive");

    // ---- parsePerCallTimeoutMs: STRICT per-call param (invalid → error, not default) ----
    t.check(TIMER_MAX_MS === 2147483647, "TIMER_MAX_MS is 2^31-1");
    const okNum = parsePerCallTimeoutMs(600000);
    t.check(okNum.ok === true && okNum.ok && okNum.value === 600000,
      "parsePerCallTimeoutMs: a positive number → that value");
    const okStr = parsePerCallTimeoutMs("600000");
    t.check(okStr.ok === true && okStr.ok && okStr.value === 600000,
      "parsePerCallTimeoutMs: a positive numeric STRING → that value");
    const okMax = parsePerCallTimeoutMs("max");
    t.check(okMax.ok === true && okMax.ok && okMax.value === TIMER_MAX_MS,
      "parsePerCallTimeoutMs: 'max' → the 2^31-1 ceiling");
    const okMaxCase = parsePerCallTimeoutMs("  MAX ");
    t.check(okMaxCase.ok === true && okMaxCase.ok && okMaxCase.value === TIMER_MAX_MS,
      "parsePerCallTimeoutMs: 'max' trimmed + case-insensitive");
    const okCap = parsePerCallTimeoutMs(9999999999999);
    t.check(okCap.ok === true && okCap.ok && okCap.value === TIMER_MAX_MS,
      "parsePerCallTimeoutMs: over-cap number → capped at TIMER_MAX_MS (not error)");
    // Invalid values are ERRORS here (unlike the lenient knob) — an explicit per-call ask.
    for (const bad of [0, -5, Number.NaN, Infinity, "0", "-5", "nonsense", "600000abc", "", true, null, {}]) {
      const r = parsePerCallTimeoutMs(bad as unknown);
      t.check(r.ok === false && !r.ok && typeof r.error === "string" && r.error.length > 0,
        `parsePerCallTimeoutMs: invalid ${JSON.stringify(bad)} → error (NOT a silent default)`);
    }
    // undefined is handled by the caller (absent param), not by this parser — but assert it errors
    // rather than silently passing, so a stray undefined can't become a bogus timeout.
    t.check(parsePerCallTimeoutMs(undefined).ok === false,
      "parsePerCallTimeoutMs: undefined is not a valid value (caller must gate on presence)");

    // ---- leading-dash guard (C12) ----------------------------------------------
    const bad = checkResolvedModelId("--print-logs");
    t.check(bad.ok === false && bad.exitCode === 2,
      "checkResolvedModelId: leading-dash id refused with exit 2 (run-tests 21c)");
    t.check(checkResolvedModelId("openai/gpt-5").ok === true,
      "checkResolvedModelId: normal id ok");

    // ---- collab-root resolution (M4 order: env > project > home) ----------------
    {
      const projBase = tmp();
      mkdirSync(path.join(projBase, "modelguild"), { recursive: true });
      const home = tmp();
      const r1 = resolveCollabRoot({ GUILD_ROOT: "/explicit/root" } as NodeJS.ProcessEnv, projBase, home);
      t.check(r1.source === "env" && r1.root === "/explicit/root", "collab-root: $GUILD_ROOT wins");
      const r2 = resolveCollabRoot({} as NodeJS.ProcessEnv, projBase, home);
      t.check(r2.source === "project" && r2.root === path.join(projBase, "modelguild"),
        "collab-root: project ./modelguild/ when it exists");
      const noProj = tmp();
      const r3 = resolveCollabRoot({} as NodeJS.ProcessEnv, noProj, home);
      t.check(r3.source === "home" && r3.root === path.join(home, ".claude", "modelguild"),
        "collab-root: ~/.claude/modelguild fallback");
      // conflict detection for doctor
      const cands = candidateRoots({ GUILD_ROOT: "/x" } as NodeJS.ProcessEnv, projBase, home);
      t.check(cands.length >= 2 && cands[0].source === "env" && cands.some((c) => c.source === "project"),
        "candidateRoots: reports overlapping roots for doctor conflict warning");
    }

    // ---- LAYERED root resolution (issue #19) ------------------------------------
    {
      const projBase = tmp();
      mkdirSync(path.join(projBase, "modelguild"), { recursive: true });
      const home = tmp();
      mkdirSync(path.join(home, ".claude", "modelguild"), { recursive: true });
      const projectRoot = path.join(projBase, "modelguild");
      const globalRoot = path.join(home, ".claude", "modelguild");

      const both = layeredRoots({} as NodeJS.ProcessEnv, projBase, home);
      t.check(both.length === 2 && both[0].root === projectRoot && both[1].root === globalRoot,
        "layeredRoots: project layer sits ABOVE the global baseline (both bind, most-specific first)");
      t.check(both[0].source === "project" && both[1].source === "home",
        "layeredRoots: sources are project then home");

      // The primary root (writes/logs) is still the most-specific layer — unchanged behaviour.
      t.check(resolveCollabRoot({} as NodeJS.ProcessEnv, projBase, home).root === projectRoot,
        "layeredRoots: resolveCollabRoot is layers[0] (the primary/write root)");

      // Global-only: the single layer is the global baseline.
      const noProj = tmp();
      const globalOnly = layeredRoots({} as NodeJS.ProcessEnv, noProj, home);
      t.check(globalOnly.length === 1 && globalOnly[0].root === globalRoot,
        "layeredRoots: no project dir → the global baseline is the only layer");

      // Project-only: the global root doesn't exist, so only the project layer.
      const bareHome = tmp();
      const projOnly = layeredRoots({} as NodeJS.ProcessEnv, projBase, bareHome);
      t.check(projOnly.length === 1 && projOnly[0].root === projectRoot,
        "layeredRoots: no global root on disk → project layer alone");

      // Neither on disk → still non-empty (the home root is the primary an install targets).
      const nothing = layeredRoots({} as NodeJS.ProcessEnv, tmp(), bareHome);
      t.check(nothing.length === 1 && nothing[0].source === "home",
        "layeredRoots: neither root on disk → home root alone (never empty)");

      // $GUILD_ROOT is a SINGLE-ROOT override — NOT a top layer (documented decision).
      const overridden = layeredRoots({ GUILD_ROOT: "/explicit/root" } as NodeJS.ProcessEnv, projBase, home);
      t.check(overridden.length === 1 && overridden[0].root === "/explicit/root" && overridden[0].source === "env",
        "layeredRoots: $GUILD_ROOT is a single-root override — no global baseline layered under it");
    }

    // ---- config-file resolution (C9) -------------------------------------------
    {
      const root = tmp();
      mkdirSync(root, { recursive: true });
      writeFileSync(path.join(root, "modelguild.conf.local"), "GUILD_MODEL=openai/local\n");
      t.check(resolveConfFile(root, {})?.endsWith("modelguild.conf.local") === true,
        "resolveConfFile: <root>/modelguild.conf.local when present");
      t.check(resolveConfFile(root, { GUILD_CONF: "/custom/conf" } as NodeJS.ProcessEnv) === "/custom/conf",
        "resolveConfFile: $GUILD_CONF overrides");
      t.check(readConfContents(root, {}).includes("openai/local"),
        "readConfContents: reads the resolved file");
      t.check(readConfContents(tmp(), {}) === "", "readConfContents: missing file → empty string");
    }

    // ---- LAYERED preference overlay (issue #19) ---------------------------------
    // Global is the baseline; the project overlays it. A project key WINS; a key the
    // project leaves unset falls THROUGH to global.
    {
      const globalRoot = tmp();
      const projectRoot = tmp();
      writeFileSync(
        path.join(globalRoot, "modelguild.conf.local"),
        // No trailing newline on purpose: the layer join must not fuse this into the next file.
        "GUILD_MODEL=openai/global\nGUILD_MODELS=openai/g1 google/g2\nGUILD_LOG_PROMPTS=hash",
      );
      writeFileSync(
        path.join(projectRoot, "modelguild.conf.local"),
        "GUILD_MODEL=openai/project\n",
      );
      const roots = [projectRoot, globalRoot]; // most-specific first

      const files = resolveConfFiles(roots, {} as NodeJS.ProcessEnv);
      t.check(
        files.length === 2 &&
          files[0] === path.join(projectRoot, "modelguild.conf.local") &&
          files[1] === path.join(globalRoot, "modelguild.conf.local"),
        "resolveConfFiles: both layers' conf files, most-specific first",
      );

      const merged = readLayeredConfContents(roots, {} as NodeJS.ProcessEnv);
      t.check(confGet(merged, "GUILD_MODEL") === "openai/project",
        "layered conf: a project key OVERRIDES the global one");
      t.check(confGet(merged, "GUILD_MODELS") === "openai/g1 google/g2",
        "layered conf: a key the project leaves unset falls THROUGH to global");
      t.check(confGet(merged, "GUILD_LOG_PROMPTS") === "hash",
        "layered conf: global evidence knobs still bind in a project that doesn't restate them");

      // Order matters: global alone must NOT see the project's value.
      t.check(confGet(readLayeredConfContents([globalRoot], {} as NodeJS.ProcessEnv), "GUILD_MODEL") === "openai/global",
        "layered conf: the global layer alone resolves to the global value");

      // A missing project layer contributes nothing (no crash, global wins).
      t.check(confGet(readLayeredConfContents([tmp(), globalRoot], {} as NodeJS.ProcessEnv), "GUILD_MODEL") === "openai/global",
        "layered conf: an absent project conf file contributes nothing");

      // $GUILD_CONF is a single-FILE override — no layering beneath it.
      const loneDir = tmp();
      const lone = path.join(loneDir, "explicit.conf");
      writeFileSync(lone, "GUILD_MODEL=openai/explicit\n");
      const env = { GUILD_CONF: lone } as NodeJS.ProcessEnv;
      t.check(resolveConfFiles(roots, env).join(",") === lone,
        "resolveConfFiles: $GUILD_CONF is a single-file override (no layers under it)");
      const overridden = readLayeredConfContents(roots, env);
      t.check(confGet(overridden, "GUILD_MODEL") === "openai/explicit" && confGet(overridden, "GUILD_MODELS") === "",
        "layered conf: $GUILD_CONF replaces the whole chain (global keys do NOT leak through)");
    }

    // ---- panel unit assertions (C13/C14) ---------------------------------------
    {
      const twoProv = resolvePanelModels({ args: ["openai/gpt-5", "google/gemini-2.5-pro"] });
      t.check(twoProv.models.length === 2 && twoProv.warnings.length === 0,
        "panel: two cross-provider models, no warnings");
      const dup = resolvePanelModels({ args: ["openai/gpt-5", "openai/gpt-5"] });
      t.check(dup.models.length === 1 && dup.warnings.some((w) => /duplicate/.test(w)),
        "panel: duplicate dropped + warned, first-seen order kept");
      const single = resolvePanelModels({ args: ["openai/gpt-5", "openai/gpt-5-mini"] });
      t.check(single.warnings.some((w) => /single-family|diversity theater/.test(w)),
        "panel: single-provider set warns (diversity theater)");
      const one = resolvePanelModels({ args: ["openai/gpt-5"] });
      t.check(one.models.length === 1 && one.warnings.some((w) => /only 1 model/.test(w)),
        "panel: <2 distinct models warns");
      const badTok = resolvePanelModels({ args: ["justname", "openai/gpt-5"] });
      t.check(badTok.models.length === 2 && badTok.warnings.some((w) => /doesn't look like/.test(w)),
        "panel: bad token warned but still kept");
      const none = resolvePanelModels({ args: [], env: {} as NodeJS.ProcessEnv, confContents: "" });
      t.check(none.models.length === 0 && none.exitCode === 2,
        "panel: no models → exit-2 intent");
      const commas = resolvePanelModels({ args: ["openai/a,google/b, opencode/c"] });
      t.check(commas.models.join(",") === "openai/a,google/b,opencode/c",
        "panel: comma/space separated, order preserved");
    }

    // ---- panel precedence: args > $GUILD_MODELS env > conf GUILD_MODELS -------
    {
      const confModels = "GUILD_MODELS=openai/from-conf google/from-conf\n";
      const fromConf = resolvePanelModels({ args: [], env: {} as NodeJS.ProcessEnv, confContents: confModels });
      t.check(fromConf.models.join(",") === "openai/from-conf,google/from-conf",
        "panel: conf GUILD_MODELS used when args/env absent");
      const fromEnv = resolvePanelModels({ args: [], env: { GUILD_MODELS: "openai/env google/env" } as NodeJS.ProcessEnv, confContents: confModels });
      t.check(fromEnv.models.join(",") === "openai/env,google/env", "panel: env overrides conf");
    }

    // ---- agent-def presence: global fallback (no false refusal) ----------------
    // The pre-check must resolve a def present ONLY in the opencode GLOBAL agent dir, so a
    // global-only install doesn't cause the delegate/research tools to falsely refuse.
    {
      const home = tmp();
      const xdg = tmp();
      const projectDir = tmp(); // its .opencode/agent/ is EMPTY (a global-only setup)
      const globalAgentDir = path.join(xdg, "opencode", "agent");
      mkdirSync(globalAgentDir, { recursive: true });

      const dirs = resolveAgentDefDirs({
        env: {} as NodeJS.ProcessEnv,
        cwd: projectDir,
        home,
        xdgConfigHome: xdg,
      });
      t.check(
        dirs.includes(path.join(projectDir, ".opencode", "agent")) && dirs.includes(globalAgentDir),
        "resolveAgentDefDirs: ordered [project sibling, global opencode agent dir]",
      );

      // Absent in BOTH → refuse (fail-closed).
      t.check(
        hardenedDefPresentIn("guild-research", dirs).present === false,
        "hardenedDefPresentIn: absent in both dirs → not present (fail-closed refusal)",
      );

      // Present ONLY in the global opencode dir → satisfied (no false refusal).
      writeFileSync(path.join(globalAgentDir, "guild-research.md"), "---\nmode: all\n---\n");
      const found = hardenedDefPresentIn("guild-research", dirs);
      t.check(
        found.present === true && found.dir === globalAgentDir,
        "hardenedDefPresentIn: a global-only def satisfies the pre-check (resolved from the global dir)",
      );

      // A def in the PROJECT sibling still resolves (project precedence unchanged).
      const projAgent = path.join(projectDir, ".opencode", "agent");
      mkdirSync(projAgent, { recursive: true });
      writeFileSync(path.join(projAgent, "guild-build.md"), "---\nmode: all\n---\n");
      const foundProj = hardenedDefPresentIn("guild-build", dirs);
      t.check(
        foundProj.present === true && foundProj.dir === projAgent,
        "hardenedDefPresentIn: project sibling takes precedence over the global dir",
      );

      // $XDG_CONFIG_HOME from env is honored when no explicit xdgConfigHome is injected.
      const dirsEnv = resolveAgentDefDirs({
        env: { XDG_CONFIG_HOME: xdg } as NodeJS.ProcessEnv,
        cwd: projectDir,
        home,
      });
      t.check(
        dirsEnv.includes(globalAgentDir),
        "resolveAgentDefDirs: honors $XDG_CONFIG_HOME for the global dir",
      );
    }

  } finally {
    cleanup();
  }

  console.log(`config.test: ${t.passes} passed, ${t.failures} failed`);
  return t.failures;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().then((f) => process.exit(f > 0 ? 1 : 0));
}
