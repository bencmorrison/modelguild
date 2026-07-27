/**
 * Model-policy tests (CONTRACT.md area A, C1–C7) — OFFLINE.
 *
 * The TypeScript `policyTier` is the reference implementation (the bash oracle it was
 * ported against retired at M12). No model is ever called. A corpus of policy files ×
 * model ids asserts the `policyTier` verdict against the expected tier, case by case.
 *
 * The glob semantics are still pinned against real bash: `bashGlobMatch` is cross-checked
 * against a live bash `case … in <pat>)` (a shell builtin, not a ModelGuild script) over
 * a pattern×string grid, proving `*`/`?` cross `/`, `[...]` ranges/negation, and POSIX-ish
 * edges match bash's own matcher, not minimatch.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  bashGlobMatch,
  hasRules,
  tierFromContents,
  resolvePolicyFile,
  resolvePolicyLayers,
  policyTier,
  policyTierAcross,
  type PolicyTier,
} from "../src/policy.js";
import { Checker } from "./harness.js";

const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

const tmpDirs: string[] = [];
function tmp(prefix = "m4pol-"): string {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
function cleanup(): void {
  for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* noop */ } }
}

/** A trusted-input bash `case` glob oracle: pattern is embedded unquoted (glob active),
 * the subject is passed as $1 (data). Returns whether bash considers it a match. */
function bashCaseGlob(pattern: string, subject: string): boolean {
  const script = `case "$1" in ${pattern}) exit 0;; *) exit 1;; esac`;
  const r = spawnSync("bash", ["-c", script, "_", subject], { encoding: "utf8" });
  return r.status === 0;
}

/** Build a `<dir>/modelguild/` with the given policy files, return the guild dir. */
function makeGuildDir(files: { policy?: string; local?: string }): string {
  const base = tmp();
  const guildDir = path.join(base, "modelguild");
  spawnSync("mkdir", ["-p", guildDir]);
  if (files.policy !== undefined) writeFileSync(path.join(guildDir, "models.policy"), files.policy);
  if (files.local !== undefined) writeFileSync(path.join(guildDir, "models.policy.local"), files.local);
  return guildDir;
}

interface Scenario {
  name: string;
  files: { policy?: string; local?: string };
  /** env applied to TS resolution (only GUILD_POLICY matters). */
  env?: Record<string, string>;
  /** map absolute path of a policy file to chmod 000 (unreadable-fails-closed). */
  chmodZero?: "policy" | "local";
  cases: Array<{ model: string; expect: PolicyTier }>;
  rootSkip?: boolean;
}

export async function run(): Promise<number> {
  const t = new Checker();

  try {
    // ---- glob-semantics oracle grid --------------------------------------------
    const patterns = [
      "*", "openai/*", "*-sol*", "*fable*", "openai/gpt-?", "openai/[a-g]*",
      "openai/[!a-m]*", "*/[0-9]*", "anthropic/claude-*", "a?c", "x\\*y",
      "openai/gpt-5.6-sol", "*/*", "[[:alpha:]]*", "opencode/*-free",
      // Reverse/invalid bracket ranges: a valid bash glob that never matches. These
      // make JS `new RegExp` throw RangeError; the converter must instead yield a
      // never-matching pattern. Cross-checked against bash `case` below.
      "openai/[c-a]", "openai/[9-0]", "openai/[z-a]", "openai/[c-a]*",
    ];
    const subjects = [
      "openai/gpt-5", "openai/gpt-5.6-sol", "openai/gpt-5.6-mini", "google/gemini-2.5-pro",
      "anthropic/claude-fable-5", "opencode/deepseek-v4-flash-free", "openai/aardvark",
      "openai/zoo", "a/c", "abc", "x*y", "xqy", "1/2", "provider/9model",
    ];
    let globChecks = 0;
    let globMismatch = 0;
    for (const p of patterns) {
      for (const s of subjects) {
        globChecks += 1;
        const ts = bashGlobMatch(p, s);
        const bash = bashCaseGlob(p, s);
        if (ts !== bash) {
          globMismatch += 1;
          t.check(false, `glob mismatch: pat='${p}' subj='${s}' ts=${ts} bash=${bash}`);
        }
      }
    }
    t.check(globMismatch === 0, `glob semantics match bash over ${globChecks} pattern×subject cases (0 mismatches)`);
    // A few explicit, human-readable assertions of the load-bearing properties.
    t.check(bashGlobMatch("openai/*", "openai/gpt-5.6-sol"), "`*` crosses `/` (openai/* ~ openai/gpt-5.6-sol)");
    t.check(bashGlobMatch("*-sol*", "openai/gpt-5.6-sol"), "*-sol* matches a mid-id token");
    t.check(!bashGlobMatch("*-sol*", "openai/gpt-5"), "*-sol* does not match a non-sol id");
    t.check(bashGlobMatch("*fable*", "anthropic/claude-fable-5"), "*fable* matches");
    t.check(bashGlobMatch("openai/gpt-?", "openai/gpt-5"), "? matches exactly one char");
    t.check(!bashGlobMatch("openai/gpt-?", "openai/gpt-55"), "? does not match two chars");
    t.check(bashGlobMatch("a?c", "a/c"), "? matches `/` too (a?c ~ a/c)");
    // BLOCKER regression: an invalid bracket range must never throw and must match
    // nothing (bash falls through such a rule).
    for (const rr of ["openai/[c-a]", "openai/[9-0]", "openai/[z-a]"]) {
      let threw = false;
      let matched = true;
      try { matched = bashGlobMatch(rr, "openai/anything"); } catch { threw = true; }
      t.check(!threw && matched === false, `invalid range '${rr}' never throws and matches nothing`);
    }
    // And the rule falls through in-file: `deny <invalid> \n allow *` → allow.
    t.check(tierFromContents("deny openai/[c-a]\nallow *\n", "openai/gpt-5").tier === "allow",
      "tier: invalid-range deny rule falls through to allow * (bash parity)");

    // ---- _has_rules --------------------------------------------------------------
    t.check(hasRules("allow *\n") === true, "hasRules: a real rule → true");
    t.check(hasRules("   allow *\n") === true, "hasRules: leading whitespace before rule → true");
    t.check(hasRules("allow\topenai/*\n") === true, "hasRules: tab-separated rule → true");
    t.check(hasRules("# just a comment\n\n") === false, "hasRules: comment/blank only → false");
    t.check(hasRules("deny\n") === false, "hasRules: bare `deny` (no pattern) is not a rule → false");
    t.check(hasRules("deny # x\n") === false, "hasRules: `deny #comment` (pattern is a comment) → false");
    t.check(hasRules("") === false, "hasRules: empty file → false");

    // ---- tierFromContents (pure) -------------------------------------------------
    t.check(tierFromContents("deny openai/gpt-5.5\nallow *\n", "openai/gpt-5.5").tier === "deny",
      "tier: first-match deny wins over a later allow *");
    t.check(tierFromContents("deny openai/gpt-5.5\nallow *\n", "openai/gpt-5").tier === "allow",
      "tier: allow * catches a non-denied id");
    t.check(tierFromContents("ask *fable*\nallow *\n", "anthropic/claude-fable-5").tier === "ask",
      "tier: ask tier resolves");
    t.check(tierFromContents("allow *\n", "").tier === "allow", "tier: empty model id → allow (C4)");
    t.check(tierFromContents("", "openai/x").tier === "allow", "tier: empty file → allow (C4)");
    // Malformed anywhere fails closed, even after a match, even with an empty model id.
    t.check(tierFromContents("allow *\nbogus foo\n", "openai/x").tier === "deny",
      "tier: unknown tier anywhere → deny (whole file parsed, C6)");
    t.check(tierFromContents("deny\n", "openai/x").tier === "deny", "tier: bare deny (no pattern) → deny");
    t.check(tierFromContents("deny foo bar\n", "openai/x").tier === "deny",
      "tier: trailing non-comment token → deny");
    t.check(tierFromContents("deny foo # ok comment\n", "foo").tier === "deny",
      "tier: trailing `# comment` is allowed (rule still valid; foo denied)");
    t.check(tierFromContents("allow *\ngarbage\n", "").tier === "deny",
      "tier: malformed active line with -m omitted still fails closed (C6)");
    // No trailing newline: the final rule must still parse (C6 scar).
    t.check(tierFromContents("ask google/x\ndeny openai/gpt-5.5", "openai/gpt-5.5").tier === "deny",
      "tier: final line without trailing newline still parses");
    t.check(tierFromContents("# c\n\n  \nallow *\n", "openai/x").tier === "allow",
      "tier: blanks/comments/whitespace lines skipped");

    // ---- resolvePolicyFile source reporting -------------------------------------
    {
      const c = makeGuildDir({ policy: "allow *\n", local: "deny openai/gpt-5.5\n" });
      const r1 = resolvePolicyFile(c, {});
      t.check(r1.source === "local" && r1.file.endsWith("models.policy.local"),
        "resolve: ruleful .local is preferred (source=local)");
      const r2 = resolvePolicyFile(c, { GUILD_POLICY: "/some/override" } as NodeJS.ProcessEnv);
      t.check(r2.source === "env" && r2.file === "/some/override", "resolve: $GUILD_POLICY wins (source=env)");
      const c2 = makeGuildDir({ policy: "allow *\n", local: "# empty\n" });
      const r3 = resolvePolicyFile(c2, {});
      t.check(r3.source === "committed" && r3.file.endsWith("models.policy"),
        "resolve: empty .local falls through to committed (source=committed)");
    }

    // ---- policyTier fail-closed + missing ---------------------------------------
    {
      const cMissing = makeGuildDir({}); // no policy files at all
      t.check(policyTier("openai/x", { guildDir: cMissing, env: {} }).tier === "allow",
        "policyTier: no policy file → allow (C4)");
      const dec = policyTier("openai/x", {
        guildDir: makeGuildDir({}),
        env: { GUILD_POLICY: makeMalformedFile() } as NodeJS.ProcessEnv,
      });
      t.check(dec.tier === "deny" && !!dec.reason && /malformed/.test(dec.reason),
        "policyTier: selected malformed file → deny with loud reason (C6)");
    }

    // ---- LAYERED policy: project over global baseline (issue #19) ---------------
    {
      const projectRoot = makeGuildDir({ policy: "" });
      const globalRoot = makeGuildDir({ policy: "deny openai/gpt-5.5\nask *fable*\nallow *\n" });
      const roots = [projectRoot, globalRoot]; // most-specific first
      const tierOf = (m: string) => policyTierAcross(m, { guildDirs: roots, env: {} }).tier;

      // Baseline binds through an EMPTY project layer — the pre-#19 bug this issue fixes:
      // a project `modelguild/` used to shadow the global policy entirely.
      t.check(tierOf("openai/gpt-5.5") === "deny",
        "layered: a global deny still binds when the project layer says nothing (baseline, NOT shadowed)");
      t.check(tierOf("anthropic/claude-fable-5") === "ask",
        "layered: a global ask still binds through an empty project layer");

      // The project can add a STRICTER deny on top of the global allow.
      writeFileSync(path.join(projectRoot, "models.policy"), "deny google/*\n");
      t.check(tierOf("google/gemini-2.5-pro") === "deny",
        "layered: the project adds a stricter deny on top of the global 'allow *'");
      t.check(tierOf("openai/gpt-5.5") === "deny",
        "layered: the project's extra rule does not disturb the global deny");

      // The project can add a LOOSER allow that beats the global deny (first-match-wins).
      writeFileSync(path.join(projectRoot, "models.policy"), "allow openai/gpt-5.5\n");
      t.check(tierOf("openai/gpt-5.5") === "allow",
        "layered: a project allow overrides the global deny (project rules evaluated FIRST)");
      t.check(tierOf("anthropic/claude-fable-5") === "ask",
        "layered: the global ask still binds for ids the project doesn't name");

      // Nothing anywhere → default-allow (C4 survives layering).
      t.check(policyTierAcross("openai/x", { guildDirs: [makeGuildDir({}), makeGuildDir({})], env: {} }).tier === "allow",
        "layered: no policy file in any layer → allow (C4)");

      // Fail-closed is CHAIN-WIDE: a malformed GLOBAL layer denies even though the project
      // layer is fine and already matched (the deliberate widening — see policyTierAcross).
      const badGlobal = makeGuildDir({ policy: "allow *\nnotatier x\n" });
      const okProject = makeGuildDir({ policy: "allow openai/gpt-5\n" });
      const chainBad = policyTierAcross("openai/gpt-5", { guildDirs: [okProject, badGlobal], env: {} });
      t.check(chainBad.tier === "deny" && !!chainBad.reason && /malformed/.test(chainBad.reason),
        "layered: a malformed line in ANY layer fails the whole chain closed (C6, chain-wide)");

      // $GUILD_POLICY replaces the ENTIRE chain (single-file override).
      const envPol = writeTmpPolicy("allow *\n");
      t.check(policyTierAcross("openai/gpt-5.5", { guildDirs: roots, env: { GUILD_POLICY: envPol } as NodeJS.ProcessEnv }).tier === "allow",
        "layered: $GUILD_POLICY is a single-file override — no layers beneath it");
    }

    // ---- LAYERED policy: within-root .local above committed (issue #19) ---------
    {
      // `.local` no longer REPLACES the committed file — it sits above it, so a personal
      // rule wins for the ids it names while committed rules keep binding for the rest.
      const root = makeGuildDir({
        policy: "deny anthropic/*\nallow *\n",
        local: "allow openai/gpt-5.5\n",
      });
      const tierOf = (m: string) => policyTier(m, { guildDir: root, env: {} }).tier;
      t.check(tierOf("openai/gpt-5.5") === "allow", "within-root: the .local rule wins for the id it names");
      t.check(tierOf("anthropic/claude-fable-5") === "deny",
        "within-root: a committed rule the .local doesn't name STILL binds (.local layers, no longer replaces)");

      // C1/C2's `_has_rules` gate is KEPT: a ruleless .local is excluded from the chain
      // entirely, so it can neither shadow committed nor fail the chain closed.
      const bare = makeGuildDir({ policy: "deny openai/gpt-5.5\nallow *\n", local: "deny\n" });
      const bareLayers = resolvePolicyLayers([bare], {});
      t.check(bareLayers.length === 1 && bareLayers[0].source === "committed",
        "within-root: a ruleless (bare-deny) .local is NOT a layer at all (C1/C2 gate kept)");
      t.check(policyTier("openai/gpt-5", { guildDir: bare, env: {} }).tier === "allow",
        "within-root: a ruleless .local does not fail the chain closed");

      // resolvePolicyLayers reports the full chain with presence, most-specific first.
      const projectRoot = makeGuildDir({ policy: "allow *\n", local: "deny google/*\n" });
      const globalRoot = makeGuildDir({}); // no files at all
      const layers = resolvePolicyLayers([projectRoot, globalRoot], {});
      t.check(
        layers.length === 3 &&
          layers[0].source === "local" && layers[0].exists &&
          layers[1].source === "committed" && layers[1].exists &&
          layers[2].source === "committed" && !layers[2].exists,
        "resolvePolicyLayers: project .local → project committed → global committed, with presence flags",
      );
      t.check(layers[0].root === projectRoot && layers[2].root === globalRoot,
        "resolvePolicyLayers: each layer names the root that contributed it");
    }

    // ---- policy scenario corpus (TS is the reference; bash oracle retired M12) ---
    const scenarios: Scenario[] = [
      {
        name: "deny-first over allow-*",
        files: { policy: "deny openai/gpt-5.5\nallow *\n" },
        cases: [
          { model: "openai/gpt-5.5", expect: "deny" },
          { model: "openai/gpt-5", expect: "allow" },
          { model: "google/gemini-2.5-pro", expect: "allow" },
        ],
      },
      {
        name: "ask tier",
        files: { policy: "ask *fable*\nallow *\n" },
        cases: [
          { model: "anthropic/claude-fable-5", expect: "ask" },
          { model: "openai/gpt-5", expect: "allow" },
        ],
      },
      {
        name: "glob families, first-match-wins",
        files: { policy: "deny *-sol*\nask openai/gpt-5.6-*\nallow opencode/*\ndeny *\n" },
        cases: [
          { model: "openai/gpt-5.6-sol", expect: "deny" },
          { model: "openai/gpt-5.6-mini", expect: "ask" },
          { model: "opencode/deepseek-v4-flash-free", expect: "allow" },
          { model: "google/foo", expect: "deny" },
        ],
      },
      {
        name: "char classes and ?",
        files: { policy: "deny openai/gpt-?\nask openai/[a-g]*\ndeny openai/[!a-m]*\nallow *\n" },
        cases: [
          { model: "openai/gpt-5", expect: "deny" },      // gpt-? (one char)
          { model: "openai/aardvark", expect: "ask" },    // [a-g]*
          { model: "openai/zoo", expect: "deny" },        // z not in a-m → [!a-m]* denies
          { model: "openai/note", expect: "deny" },       // n is after m, so NOT in a-m → [!a-m]* denies
          { model: "openai/mini", expect: "allow" },      // m in a-m (not [!a-m]) and not in a-g → falls to allow *
        ],
      },
      {
        name: "invalid bracket ranges never match, rule falls through",
        files: { policy: "deny openai/[c-a]\ndeny openai/[9-0]\ndeny openai/[z-a]\nallow *\n" },
        cases: [
          { model: "openai/gpt-5", expect: "allow" },
          { model: "openai/b", expect: "allow" },
          { model: "openai/5", expect: "allow" },
        ],
      },
      {
        name: "ruleful .local preferred over committed",
        files: { policy: "allow *\n", local: "deny openai/gpt-5.5\n" },
        cases: [
          { model: "openai/gpt-5.5", expect: "deny" },
          { model: "openai/gpt-5", expect: "allow" }, // no catch-all in .local → default allow
        ],
      },
      {
        name: "empty/comment-only .local does NOT void committed deny (fail-closed)",
        files: { policy: "deny openai/gpt-5.5\nallow *\n", local: "# personal, no rules yet\n" },
        cases: [
          { model: "openai/gpt-5.5", expect: "deny" },
          { model: "openai/gpt-5", expect: "allow" },
        ],
      },
      {
        name: "bare-deny .local cannot shadow committed",
        files: { policy: "deny openai/gpt-5.5\nallow *\n", local: "deny\n" },
        cases: [{ model: "openai/gpt-5.5", expect: "deny" }],
      },
      {
        name: "$GUILD_POLICY overrides both files",
        files: { policy: "deny openai/gpt-5.5\n", local: "deny openai/gpt-5.5\n" },
        env: {}, // filled per-scenario below via envPolicy
        cases: [{ model: "openai/gpt-5.5", expect: "allow" }],
      },
      {
        name: "no trailing newline on final rule",
        files: {},
        env: {}, // envPolicy set below
        cases: [
          { model: "openai/gpt-5.5", expect: "deny" },
          { model: "google/x", expect: "ask" },
        ],
      },
      {
        name: "malformed selected file fails closed",
        files: {},
        env: {},
        cases: [
          { model: "openai/anything", expect: "deny" },
          { model: "", expect: "deny" }, // whole file parsed even with empty model id
        ],
      },
      {
        name: "shipped default allow *",
        files: { policy: "allow *\n" },
        cases: [{ model: "openai/whatever", expect: "allow" }],
      },
      {
        name: "no policy files at all → allow",
        files: {},
        cases: [{ model: "openai/anything", expect: "allow" }],
      },
      {
        name: "unreadable policy fails closed (deny)",
        files: { policy: "deny openai/evil\nallow *\n" },
        chmodZero: "policy",
        rootSkip: true,
        cases: [{ model: "openai/anything", expect: "deny" }],
      },
    ];

    let crossChecks = 0;
    let crossAgree = 0;
    let crossMismatch = 0;

    for (const sc of scenarios) {
      if (sc.rootSkip && isRoot) {
        t.check(true, `[skipped as root] ${sc.name}`);
        continue;
      }
      const guildDir = makeGuildDir(sc.files);
      let env: Record<string, string> = { ...(sc.env ?? {}) };

      // Scenarios that need a $GUILD_POLICY file created on the fly.
      if (sc.name.startsWith("$GUILD_POLICY overrides")) {
        env.GUILD_POLICY = writeTmpPolicy("allow *\n");
      } else if (sc.name === "no trailing newline on final rule") {
        env.GUILD_POLICY = writeTmpPolicy("ask google/x\ndeny openai/gpt-5.5"); // no final \n
      } else if (sc.name === "malformed selected file fails closed") {
        env.GUILD_POLICY = writeTmpPolicy("allow *\ngarbagetier foo\n");
      }

      if (sc.chmodZero) {
        const f = path.join(guildDir, sc.chmodZero === "policy" ? "models.policy" : "models.policy.local");
        chmodSync(f, 0o000);
      }

      for (const cs of sc.cases) {
        crossChecks += 1;
        const tsTier = policyTier(cs.model, { guildDir, env: env as NodeJS.ProcessEnv }).tier;
        if (tsTier === cs.expect) {
          crossAgree += 1;
        } else {
          crossMismatch += 1;
          t.check(false,
            `[${sc.name}] model='${cs.model}': ts=${tsTier} expected=${cs.expect}`);
        }
      }

      if (sc.chmodZero) {
        // restore so rmSync can clean up
        try { chmodSync(path.join(guildDir, "models.policy"), 0o644); } catch { /* noop */ }
      }
    }
    t.check(crossMismatch === 0,
      `policy corpus: ${crossAgree}/${crossChecks} cases match the expected tier, 0 mismatches`);
    console.log(`    [policy corpus] ${scenarios.length} scenarios, ${crossChecks} model×policy checks`);
    console.log(`    [glob corpus] ${globChecks} pattern×subject cross-checks against bash \`case\``);
  } finally {
    cleanup();
  }

  console.log(`policy.test: ${t.passes} passed, ${t.failures} failed`);
  return t.failures;
}

/** A tmp policy file with a malformed active line, for the fail-closed unit check. */
function makeMalformedFile(): string {
  return writeTmpPolicy("allow *\nnotatier x\n");
}
function writeTmpPolicy(contents: string): string {
  const d = tmp("m4polf-");
  const f = path.join(d, "policy");
  writeFileSync(f, contents);
  return f;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().then((f) => process.exit(f > 0 ? 1 : 0));
}
