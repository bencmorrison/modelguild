/**
 * `modelguild` CLI dispatcher.
 *
 * The published npm package's `bin`. Subcommands:
 *   serve   (default) — start the MCP stdio server (what `.mcp.json` launches).
 *   init              — place the MCP-era payload into a project (see init.ts).
 *   doctor            — a token-free health check (opencode present, MCP registration,
 *                       command docs + agent defs present, config/policy roots).
 *   logs clean        — apply log retention by hand (issue #23): delete run dirs older
 *                       than the configured (or `--days`) window, `--dry-run` to look.
 *
 * NOTE: this file carries NO shebang in source, on purpose — the repo's shebang lint
 * (`check-shebangs.sh`) requires `#!/usr/bin/env bash` on every tracked script, and this
 * is a node entry. The build step (`scripts/postbuild.mjs`) prepends `#!/usr/bin/env node`
 * to the git-ignored `dist/cli.js`, which is what npm links as the bin — so the tracked
 * source stays lint-clean while the shipped artifact is directly executable.
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  init,
  mcpServerEntry,
  payloadFiles,
  payloadDest,
  recordPathFor,
  resolveGlobalDirs,
  scanDrift,
  type DriftEntry,
  type DriftScanEntry,
  type ServerLaunch,
} from "./init.js";
import { layeredRoots } from "./config.js";
import { resolvePolicyLayers } from "./policy.js";
import { EvidenceLog, DEFAULT_RETENTION_DAYS } from "./log.js";

const SELF = fileURLToPath(import.meta.url); // <pkg>/dist/cli.js  or  <pkg>/src/cli.ts
const PACKAGE_ROOT = path.resolve(path.dirname(SELF), "..");

/** How the running CLI would re-launch itself for the `serve` entry. Honest by
 * construction: it names the exact interpreter+entry that is executing right now, so the
 * `.mcp.json` line init writes is provably runnable (it just ran init). `.ts` ⇒ tsx
 * (dogfood/dev); `.js` ⇒ node (the built/installed artifact). */
/** The SHIPPED DEFAULT: the portable, non-interactive published form
 * `npx -y modelguild serve`. `-y` is load-bearing — an MCP server is launched on a
 * non-TTY, where a bare `npx modelguild` would BLOCK on npm's "install this package?"
 * prompt with no way to answer. Requires the package to be resolvable (published, or a
 * project dependency). Also chosen explicitly with `--npx`. */
function npxServeLaunch(): ServerLaunch {
  return { command: "npx", args: ["-y", "modelguild", "serve"] };
}

/** The pinned/offline form (`--abs`): an absolute path to the exact interpreter+entry
 * running right now, so it needs no registry resolution — guaranteed runnable but
 * machine-specific. `.ts` ⇒ tsx (dogfood/dev); `.js` ⇒ node (the built artifact). */
function absServeLaunch(): ServerLaunch {
  if (SELF.endsWith(".ts")) return { command: "npx", args: ["tsx", SELF, "serve"] };
  return { command: "node", args: [SELF, "serve"] };
}

async function runServe(): Promise<void> {
  // server.ts self-runs on import: it constructs the Server, wires stdin/transport
  // teardown, and connects the stdio transport at module top level.
  await import("./server.js");
}

function parseInitArgs(argv: string[]): {
  targetDir: string;
  uninstall: boolean;
  launch: ServerLaunch;
  writeMcp: boolean;
  global: boolean;
} {
  let targetDir = process.cwd();
  let dirExplicit = false;
  let uninstall = false;
  let useAbs = false;
  let writeMcp = false;
  let global = false;
  let customCommand: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--uninstall") uninstall = true;
    // --npx is the default already; accepted as an explicit no-op for clarity.
    else if (a === "--npx") useAbs = false;
    else if (a === "--abs") useAbs = true;
    // OPT-IN: restore the old auto-write of the project `.mcp.json` entry.
    else if (a === "--write-mcp") writeMcp = true;
    // GLOBAL payload install (all projects) — see init.ts InitOptions.global.
    else if (a === "--global") global = true;
    else if (a === "--dir") { targetDir = argv[++i] ?? targetDir; dirExplicit = true; }
    else if (a.startsWith("--dir=")) { targetDir = a.slice("--dir=".length); dirExplicit = true; }
    else if (a === "--server-command") customCommand = argv[++i];
    else if (a.startsWith("--server-command=")) customCommand = a.slice("--server-command=".length);
    else throw new Error(`init: unknown argument '${a}'`);
  }
  // --global has no project target: reject an explicit --dir (rather than silently ignoring
  // it) and reject --write-mcp (no project .mcp.json to write).
  if (global && dirExplicit) {
    throw new Error("init: --global has no project target — drop --dir (the payload lands in your global config).");
  }
  if (global && writeMcp) {
    throw new Error("init: --write-mcp cannot be combined with --global (there is no project .mcp.json).");
  }
  targetDir = path.resolve(targetDir);
  let launch: ServerLaunch;
  if (customCommand !== undefined) {
    const parts = customCommand.split(/\s+/).filter((p) => p.length > 0);
    if (parts.length === 0) throw new Error("init: --server-command is empty");
    launch = { command: parts[0], args: parts.slice(1) };
  } else if (useAbs) {
    launch = absServeLaunch();
  } else {
    launch = npxServeLaunch(); // SHIPPED DEFAULT
  }
  return { targetDir, uninstall, launch, writeMcp, global };
}

function runInit(argv: string[]): number {
  const { targetDir, uninstall, launch, writeMcp, global } = parseInitArgs(argv);
  const res = init({ targetDir, packageRoot: PACKAGE_ROOT, serverLaunch: launch, uninstall, writeMcp, global });
  const g = resolveGlobalDirs({});

  if (uninstall) {
    if (global) {
      console.log("Uninstalled ModelGuild (MCP) GLOBAL payload");
      console.log(`  removed ${res.removed.length} file(s) from your global config`);
    } else {
      console.log(`Uninstalled ModelGuild (MCP) from ${targetDir}`);
      console.log(`  removed ${res.removed.length} file(s); .mcp.json ${res.mcpAction}`);
    }
  } else if (global) {
    console.log("Installed ModelGuild (MCP) GLOBAL payload — available in EVERY project");
    console.log(`  ${res.installed.length} file(s) written, ${res.skipped.length} skipped`);
    console.log(`  commands: ${path.join(g.homeDir, ".claude", "commands", "guild")}/`);
    console.log(`  agents:   ${path.join(g.xdgConfigHome, "opencode", "agent")}/`);
    console.log(`  policy:   ${path.join(g.homeDir, ".claude", "modelguild")}/`);
    console.log(`  .mcp.json: NOT written — register the server globally yourself (see below).`);
  } else {
    console.log(`Installed ModelGuild (MCP) into ${targetDir}`);
    console.log(`  ${res.installed.length} file(s) written, ${res.skipped.length} skipped`);
    if (writeMcp) {
      console.log(`  .mcp.json: ${res.mcpAction} — server key 'modelguild'`);
    } else {
      console.log(`  .mcp.json: NOT written — register the server yourself (see below).`);
    }
    console.log(`  launch: ${launch.command} ${launch.args.join(" ")}`);
  }
  for (const w of res.warnings) console.warn(`  ! ${w}`);
  if (res.shadowed.length > 0) {
    // `shadowed` is "the bytes at our command path are not ours" — which covers BOTH a command
    // the user already had there AND our file after the user edited it. The old wording claimed
    // only the first, and now reads as a contradiction next to the drift note ("you edited it
    // since init wrote it"). Same set, accurate for both cases.
    console.warn(
      `  ! ${res.shadowed.length} /guild:* command(s) at our path hold content ModelGuild did ` +
        `not write — your own command, or your edit of ours (shadowing): ` +
        `${res.shadowed.join(", ")}. Those are the commands Claude Code will run; delete or ` +
        `rename one and re-run to get ModelGuild's version back.`,
    );
  }
  if (res.drifted.length > 0) printDriftNote(res.drifted, "  ");
  if (!uninstall && !writeMcp) printRegisterInstructions(targetDir, launch, global);
  if (!uninstall) {
    console.log("Next steps:");
    console.log("  1. Authenticate opencode:  opencode auth login");
    if (writeMcp) {
      console.log("  2. (Done — --write-mcp wrote the project .mcp.json for you.)");
    } else if (global) {
      console.log("  2. Register the MCP server globally, once (see above): `claude mcp add modelguild -s user -- …`.");
    } else {
      console.log("  2. Register the MCP server (see 'Register the MCP server' above).");
    }
    console.log("  3. Restart Claude Code so it picks up the MCP server.");
    console.log(`  4. Check the setup:        npx modelguild doctor${global ? " --global" : ""}`);
  }
  return 0;
}

/**
 * UPGRADE DRIFT (issue #22) — the one user-facing report of a file that is ours, edited, and now
 * behind the shipped payload. Printed by BOTH `init` (from the run it just did) and `doctor`
 * (from a standalone scan), in one place so the two can't word it differently.
 *
 * It is a WARNING, never a failure: the edit is a supported act and the file is never touched,
 * so a customized install must not read as broken. The hints are deliberately light — a `diff`
 * line the user can paste, and delete-and-re-init to re-adopt the release. No `--force` flag is
 * offered: overwriting an edit on the user's behalf is exactly what the ownership model exists
 * to prevent, and a flag that does it invites the mistake the skip was protecting against.
 */
function printDriftNote(drifted: DriftEntry[], indent: string): void {
  console.warn(
    `${indent}! ${drifted.length} file(s) you edited are STALE — this release ships a newer ` +
      `version of them, and init never overwrites your edits, so your copy stayed behind:`,
  );
  for (const d of drifted) {
    console.warn(`${indent}    ${d.dest}`);
    console.warn(`${indent}      diff "${d.shippedPath}" "${d.installedPath}"`);
  }
  console.warn(
    `${indent}  Keeping your version? Nothing to do. Want the current one? Save your copy, ` +
      `delete the file, and re-run \`npx modelguild init\` (init rewrites a file only while ` +
      `it can prove the file is unedited).`,
  );
}

/** Print the two ways to register the MCP server, in the DEFAULT (no `--write-mcp`) path:
 * the recommended `claude mcp add` CLI form (any scope), and the raw `.mcp.json` snippet for
 * hand-placement. The snippet reuses `mcpServerEntry` so its shape can't drift from what
 * `--write-mcp` would write. */
function printRegisterInstructions(targetDir: string, launch: ServerLaunch, global = false): void {
  const launchStr = [launch.command, ...launch.args].join(" ");
  console.log("");
  if (global) {
    // Global payload ⇒ the natural registration is the global (user) scope. One registration
    // works in every project (the server resolves the active project from its cwd).
    console.log("Register the MCP server globally, once (the global payload works in every project):");
    console.log("");
    console.log(`    claude mcp add modelguild -s user -- ${launchStr}`);
    console.log(
      "    -s user writes ~/.claude.json (all your projects). The MCP server key must be " +
        "exactly 'modelguild' — the /guild:* commands grant mcp__modelguild__* .",
    );
    console.log("");
    return;
  }
  console.log("Register the MCP server (init did NOT write .mcp.json — you choose the scope):");
  console.log("");
  console.log("  Recommended — register with the Claude CLI:");
  console.log(`    claude mcp add modelguild -s user -- ${launchStr}`);
  console.log(
    "    Swap -s user (global, all your projects) for -s project (committed to this " +
      "repo's .mcp.json) or -s local (this project only, private).",
  );
  console.log("");
  console.log("  Or hand-place this in the project's .mcp.json (project-scoped):");
  const snippet = { mcpServers: { modelguild: mcpServerEntry({ targetDir, packageRoot: PACKAGE_ROOT, serverLaunch: launch }) } };
  for (const l of JSON.stringify(snippet, null, 2).split("\n")) console.log(`    ${l}`);
  console.log("");
}

/** A light, token-free doctor: no model call. Confirms the MCP-era payload is present
 * and coherent. This is the deep check — the bash `collab/doctor.sh` was retired at M12. */
export async function runDoctor(
  argv: string[],
  inject?: { homeDir?: string; xdgConfigHome?: string },
): Promise<number> {
  let targetDir = process.cwd();
  let global = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dir") targetDir = argv[++i] ?? targetDir;
    else if (a.startsWith("--dir=")) targetDir = a.slice("--dir=".length);
    else if (a === "--global") global = true;
  }
  targetDir = path.resolve(targetDir);
  const gdirs = resolveGlobalDirs({ homeDir: inject?.homeDir, xdgConfigHome: inject?.xdgConfigHome });
  let ok = true;
  const line = (good: boolean, msg: string) => {
    console.log(`${good ? "✓" : "✗"} ${msg}`);
    if (!good) ok = false;
  };

  const { spawnSync } = await import("node:child_process");

  // MCP registration under the exact key the command grants require. Since the flip to
  // user-driven registration (init no longer writes .mcp.json by default), the user often
  // registers GLOBALLY (`claude mcp add -s user`, which writes ~/.claude.json, NOT the
  // project .mcp.json) — so a project-file check alone would falsely fail a working global
  // setup. Prefer an any-scope check via the Claude CLI; fall back to the project file.
  const mcpPath = path.join(targetDir, ".mcp.json");
  let projectHasKey = false;
  if (existsSync(mcpPath)) {
    try {
      const root = JSON.parse(readFileSync(mcpPath, "utf8")) as {
        mcpServers?: Record<string, unknown>;
      };
      projectHasKey = !!root.mcpServers && Object.prototype.hasOwnProperty.call(root.mcpServers, "modelguild");
    } catch {
      /* invalid json → treated as no key */
    }
  }
  const claudeGet = spawnSync("claude", ["mcp", "get", "modelguild"], { encoding: "utf8" });
  const claudeOnPath = !claudeGet.error; // ENOENT sets .error
  if (claudeOnPath && claudeGet.status === 0) {
    console.log("✓ MCP server 'modelguild' registered (found via `claude mcp get`, any scope)");
  } else if (projectHasKey) {
    console.log("✓ MCP server registered in project .mcp.json under key 'modelguild'");
  } else if (claudeOnPath) {
    // claude answered, no registration in any scope — a real miss.
    line(false, "MCP server 'modelguild' not registered in any scope — run `claude mcp add modelguild -s user -- npx -y modelguild serve`");
  } else {
    // Can't check global scope (claude not on PATH) and no project key. Do NOT hard-fail: a
    // global/user-scope registration lives in ~/.claude.json, invisible here.
    console.warn(
      "! MCP server 'modelguild' not found in project .mcp.json, and the `claude` CLI isn't " +
        "on PATH to check global/user scope. If you registered with `-s user`, that's expected — " +
        "verify with `claude mcp get modelguild`.",
    );
  }

  // Command docs + agent defs + policy present. Each of these resolves at RUNTIME from the
  // PROJECT location OR the GLOBAL location:
  //   - command docs: Claude Code reads BOTH project `.claude/commands/guild/` and global
  //     `~/.claude/commands/guild/`.
  //   - agent defs: opencode resolves BOTH project `.opencode/agent/` and global
  //     `<xdg>/opencode/agent/` (this is exactly what `resolveAgentDefDirs` models).
  //   - policy: `resolveCollabRoot` falls back project `modelguild/` → home `~/.claude/modelguild/`.
  // So DEFAULT doctor must count a piece present if it is found in EITHER location — otherwise a
  // perfectly-working GLOBAL install (`init --global`) falsely fails 0/8, 0/3, no policy. `--global`
  // stays an explicit "verify ONLY my global install" and checks the global location alone.
  // Fail-closed either way: found in NEITHER ⇒ still a ✗ / exit 1.
  const projectOpts: Parameters<typeof payloadDest>[1] = { global: false, targetDir, global_dirs: gdirs };
  const globalOpts: Parameters<typeof payloadDest>[1] = { global: true, targetDir, global_dirs: gdirs };
  const existsAt = (dest: string, opts: Parameters<typeof payloadDest>[1]): boolean => {
    const { base, rel } = payloadDest(dest, opts);
    return existsSync(path.join(base, rel));
  };
  type Found = "project" | "global" | "none";
  // In --global mode only the global location counts; in default mode project OR global does.
  const locate = (dest: string): Found => {
    if (global) return existsAt(dest, globalOpts) ? "global" : "none";
    if (existsAt(dest, projectOpts)) return "project";
    if (existsAt(dest, globalOpts)) return "global";
    return "none";
  };

  // Expected counts are derived from `payloadFiles()` (the same list `init` installs), so
  // adding a command or agent def can never silently desync doctor's threshold — nothing is
  // hardcoded here. A missing piece is a HARD fail, named by basename (not a bare count).
  let docsPresent = 0;
  let docsTotal = 0;
  let agentsPresent = 0;
  const docsWhere = new Set<Found>();
  const agentsWhere = new Set<Found>();
  const missingDocs: string[] = [];
  for (const { dest } of payloadFiles()) {
    const isDoc = dest.startsWith(".claude/commands/");
    if (isDoc) docsTotal++;
    const where = locate(dest);
    if (where === "none") {
      if (isDoc) missingDocs.push(path.basename(dest, ".md"));
      continue;
    }
    if (isDoc) { docsPresent++; docsWhere.add(where); }
    else if (dest.startsWith(".opencode/agent/")) { agentsPresent++; agentsWhere.add(where); }
  }

  const globalDocsDir = `${path.join(gdirs.homeDir, ".claude", "commands", "guild")}/`;
  const globalAgentsDir = `${path.join(gdirs.xdgConfigHome, "opencode", "agent")}/`;
  // In default mode, name that the check covered project OR the global dir, and (cheaply) say
  // where they were actually found — all-project, all-global, or mixed.
  const whereSuffix = (where: Set<Found>): string => {
    if (global || where.size === 0) return "";
    if (where.size > 1) return " [found: mixed project + global]";
    return [...where][0] === "global" ? " [found: global]" : " [found: project]";
  };
  const docsLoc = global ? globalDocsDir : `.claude/commands/guild/ or ${globalDocsDir}`;
  const agentsLoc = global ? globalAgentsDir : `.opencode/agent/ or ${globalAgentsDir}`;
  const docsMsg =
    missingDocs.length === 0
      ? `${docsPresent}/${docsTotal} command docs present in ${docsLoc}${whereSuffix(docsWhere)}`
      : `${docsPresent}/${docsTotal} command docs present in ${docsLoc} — missing: ${missingDocs.join(", ")}`;
  line(missingDocs.length === 0, docsMsg);
  line(agentsPresent === 3, `${agentsPresent}/3 hardened agent defs present in ${agentsLoc}${whereSuffix(agentsWhere)}`);

  // Policy / config template present — project `modelguild/models.policy` OR global.
  const globalPolicy = payloadDest("modelguild/models.policy", globalOpts);
  const globalPolicyPath = path.join(globalPolicy.base, globalPolicy.rel);
  const policyWhere = locate("modelguild/models.policy");
  const policyLoc = global
    ? globalPolicyPath
    : `modelguild/models.policy or ${globalPolicyPath}`;
  line(
    policyWhere !== "none",
    `model policy present (${policyLoc})${whereSuffix(new Set([policyWhere]))}`,
  );

  // LAYERED config/policy resolution (issue #19) — report BOTH layers, not just the winner.
  // Since #19 a project `modelguild/` no longer shadows the global one: it sits ON TOP of it
  // (preferences overlay key-by-key, policy rules evaluate project-first then global). The
  // operator needs to see the whole chain to know what actually binds, so print every layer
  // and mark which files exist. `--global` is not special-cased here: the layers are whatever
  // resolves for `targetDir`, and an injected homeDir keeps this test-drivable without ever
  // touching the real `~`.
  {
    // Real `process.env` on purpose: `$GUILD_ROOT`/`$GUILD_POLICY` genuinely change what
    // binds at runtime, so a doctor that ignored them would print a chain the server does
    // not use. `targetDir`/`gdirs.homeDir` stay injectable so tests never read the real `~`.
    const roots = layeredRoots(process.env, targetDir, gdirs.homeDir);
    const label = (s: string) => (s === "project" ? "project" : s === "home" ? "global" : s);
    console.log(
      `✓ config/policy layers (most-specific first): ${roots
        .map((r) => `${label(r.source)} ${r.root}`)
        .join("  →  ")}  →  default-allow`,
    );
    for (const layer of resolvePolicyLayers(roots.map((r) => r.root), process.env)) {
      const mark = layer.exists ? "•" : "-";
      console.log(`  ${mark} ${layer.source.padEnd(9)} ${layer.file}${layer.exists ? "" : " (absent)"}`);
    }
  }

  // UPGRADE DRIFT (issue #22) — a file init wrote, the user then edited, whose shipped bytes have
  // since changed: the upgrade skipped it (never clobber) and the user's copy is behind the
  // release, silently. Doctor is where a user looks when something behaves oddly, so it must say
  // so. Each file is judged against the record of the location it was FOUND in (project or
  // global) — the same `locate` decision the presence checks used, so a mixed install reads each
  // half against its own record.
  //
  // Honest about the limit: with no ownership record, an intentional edit and a stale leftover are
  // byte-identical evidence. Doctor reports those as UNJUDGEABLE and names the missing record
  // rather than guessing "stale". Neither case changes the exit code — an edit is supported.
  const driftEntries: DriftScanEntry[] = [];
  for (const { dest } of payloadFiles()) {
    const where = locate(dest);
    if (where === "none") continue;
    const opts = where === "global" ? globalOpts : projectOpts;
    const { base, rel } = payloadDest(dest, opts);
    driftEntries.push({
      dest,
      installedPath: path.join(base, rel),
      recordPath: recordPathFor(opts),
    });
  }
  const drift = scanDrift(PACKAGE_ROOT, driftEntries);
  if (drift.drifted.length > 0) {
    printDriftNote(drift.drifted, "");
  } else if (driftEntries.length > 0 && drift.unknown.length === 0) {
    console.log("✓ no upgrade drift: every installed file matches the version it was written from");
  }
  if (drift.unknown.length > 0) {
    console.warn(
      `! ${drift.unknown.length} installed file(s) differ from the shipped version but no ` +
        `ownership record covers them, so doctor CANNOT tell an intentional edit from a stale ` +
        `leftover — it will not guess:`,
    );
    for (const d of drift.unknown) {
      console.warn(`    ${d.dest}`);
      console.warn(`      diff "${d.shippedPath}" "${d.installedPath}"`);
    }
    for (const p of drift.missingRecords) {
      console.warn(`  no install record at ${p} — installed by hand, or the record was removed?`);
    }
    console.warn(
      "  Compare them yourself. To adopt the shipped version, delete the file and re-run " +
        "`npx modelguild init` — init never adopts a file it cannot prove it wrote.",
    );
  }

  // opencode binary (best-effort; a missing binary is a warning, not a hard fail here).
  const oc = spawnSync("opencode", ["--version"], { encoding: "utf8" });
  if (oc.status === 0) {
    console.log(`✓ opencode present (${(oc.stdout || "").trim()})`);
  } else {
    console.warn("! opencode not found on PATH — run its install and `opencode auth login`");
  }

  console.log(ok ? "\ndoctor: OK" : "\ndoctor: problems found (see ✗ above)");
  return ok ? 0 : 1;
}

// ---------------------------------------------------------------------------
// `modelguild logs …` — evidence-log maintenance (issue #23).
// ---------------------------------------------------------------------------

function logsUsage(): void {
  console.log("Usage: modelguild logs clean [--days N] [--dry-run] [--dir D]");
  console.log("  Delete evidence-log run directories older than the retention window.");
  console.log("  --days N     Use an explicit window of N days instead of the configured one.");
  console.log("  --dry-run    Report what WOULD be removed; delete nothing.");
  console.log("  --dir D      Resolve the modelguild/ root from D instead of the cwd.");
  console.log("");
  console.log(`  Without --days the window comes from GUILD_LOG_RETENTION_DAYS (env >`);
  console.log(`  modelguild/modelguild.conf.local > default ${DEFAULT_RETENTION_DAYS}). If that is 0 or`);
  console.log("  unreadable, this refuses and asks for --days rather than guessing —");
  console.log("  it will never treat 'no window' as 'delete everything'.");
}

function parseLogsCleanArgs(argv: string[]): {
  days?: number;
  dryRun: boolean;
  targetDir: string;
} {
  let days: number | undefined;
  let dryRun = false;
  let targetDir = process.cwd();
  const takeDays = (raw: string | undefined): number => {
    if (raw === undefined) throw new Error("logs clean: --days needs a value (a whole number of days)");
    if (!/^\d+$/.test(raw.trim())) {
      throw new Error(`logs clean: --days must be a whole number of days (got '${raw}')`);
    }
    return parseInt(raw.trim(), 10);
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run" || a === "-n") dryRun = true;
    else if (a === "--days") days = takeDays(argv[++i]);
    else if (a.startsWith("--days=")) days = takeDays(a.slice("--days=".length));
    else if (a === "--dir") targetDir = argv[++i] ?? targetDir;
    else if (a.startsWith("--dir=")) targetDir = a.slice("--dir=".length);
    else throw new Error(`logs clean: unknown argument '${a}'`);
  }
  return { days, dryRun, targetDir: path.resolve(targetDir) };
}

/** Human-readable byte size — enough precision to judge "is this worth clearing?". */
function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[u]}`;
}

/**
 * `modelguild logs clean`. Exported (like `runDoctor`) so the test suite drives it
 * directly instead of shelling out.
 *
 * REFUSAL, not a default: with no `--days` and no usable configured window, this exits 2
 * with the reason. "No retention configured" must never be read as "retention of zero
 * days", because that reading deletes the entire log — the one outcome a cleanup command
 * must not reach by accident.
 */
export async function runLogsClean(
  argv: string[],
  inject?: { env?: NodeJS.ProcessEnv; homeDir?: string },
): Promise<number> {
  let parsedArgs: ReturnType<typeof parseLogsCleanArgs>;
  try {
    parsedArgs = parseLogsCleanArgs(argv);
  } catch (err) {
    console.error(`modelguild: ${(err as Error).message}`);
    return 2;
  }
  const { days, dryRun, targetDir } = parsedArgs;
  const env = inject?.env ?? process.env;
  const home = inject?.homeDir;
  // LAYERED resolution (issue #19), split exactly the way the tools split it: the window
  // is READ across every layer (`collabDirs`), so a global `GUILD_LOG_RETENTION_DAYS`
  // binds in a project that never restates it — but the logs being cleaned live under the
  // PRIMARY root alone (`collabDir` = layers[0]), because that is the only root writes
  // ever land in. Cleaning a layer nobody writes to would be cleaning someone else's
  // logs from this project's command.
  const roots = home ? layeredRoots(env, targetDir, home) : layeredRoots(env, targetDir);
  const { root, source } = roots[0];
  const log = new EvidenceLog({
    env,
    cwd: targetDir,
    collabDir: root,
    collabDirs: roots.map((r) => r.root),
  });

  // Resolve the window BEFORE touching the filesystem, so a refusal costs nothing.
  let window: number;
  if (days !== undefined) {
    if (days === 0) {
      console.error(
        "modelguild: logs clean --days 0 would delete every run in the log. " +
          "0 is the value that DISABLES retention, not a window — pass a positive --days.",
      );
      return 2;
    }
    window = days;
  } else {
    const setting = log.retention();
    if (!setting.valid) {
      console.error(
        `modelguild: GUILD_LOG_RETENTION_DAYS is '${setting.raw}' (from ${setting.source}), ` +
          "which is not a whole number of days — refusing to guess a window. " +
          "Fix the setting or pass --days N.",
      );
      return 2;
    }
    if (setting.days <= 0) {
      console.error(
        `modelguild: retention is disabled (GUILD_LOG_RETENTION_DAYS=${setting.raw}, from ` +
          `${setting.source}) — there is no configured window to apply. Pass --days N to ` +
          "clean explicitly, or set a positive GUILD_LOG_RETENTION_DAYS.",
      );
      return 2;
    }
    window = setting.days;
  }

  const setting = log.retention();
  const windowSource = days !== undefined ? "--days" : setting.source;
  const res = log.prune(window, { dryRun });

  const row = (label: string, value: string) => console.log(`  ${(label + ":").padEnd(14)}${value}`);
  console.log(`modelguild logs clean${dryRun ? " (dry run — nothing deleted)" : ""}`);
  row("logs dir", res.dir);
  row("root", `${root} (${source})`);
  row("retention", `${res.days} day(s) (${windowSource})`);
  if (res.reason === "no-log-dir") {
    console.log("  nothing to do: the logs dir does not exist yet.");
    return 0;
  }
  if (res.reason === "error") {
    console.error(`  ! could not scan the logs dir: ${res.error}`);
    return 1;
  }
  row("scanned", `${res.scanned} run(s)`);
  const verb = dryRun ? "would remove" : "removed";
  if (res.removed.length === 0) {
    row(verb, `none — all ${res.kept} run(s) are inside the window`);
  } else {
    row(verb, `${res.removed.length} run(s), ${humanBytes(res.freedBytes)}`);
    for (const r of res.removed) {
      console.log(`    ${r.runId}  (${r.ageDays}d old, ${humanBytes(r.bytes)})`);
    }
    row("kept", `${res.kept} run(s) inside the window`);
  }
  if (res.skipped > 0) console.warn(`  ! ${res.skipped} run(s) skipped (unreadable)`);
  return 0;
}

async function runLogs(argv: string[]): Promise<number> {
  const sub = argv[0];
  if (sub === "-h" || sub === "--help" || sub === "help") { logsUsage(); return 0; }
  if (sub === undefined) { logsUsage(); return 2; }
  if (sub === "clean") return runLogsClean(argv.slice(1));
  console.error(`modelguild: unknown logs subcommand '${sub}' (see 'modelguild logs --help')`);
  return 2;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  // Default (no subcommand) and `serve` both start the MCP server.
  if (cmd === undefined || cmd === "serve") {
    await runServe();
    return 0; // serve blocks on the transport; this returns only on teardown.
  }
  if (cmd === "init") return runInit(argv.slice(1));
  if (cmd === "doctor") return runDoctor(argv.slice(1));
  if (cmd === "logs") return runLogs(argv.slice(1));
  if (cmd === "-h" || cmd === "--help" || cmd === "help") {
    console.log("Usage: modelguild <serve|init|doctor|logs> [options]");
    console.log("  serve            Start the MCP stdio server (default; what .mcp.json launches).");
    console.log("  init [--dir D]   Place the MCP-era payload into a project (--uninstall to remove).");
    console.log("                   Does NOT write .mcp.json by default — it prints how to register");
    console.log("                   the server yourself (`claude mcp add`, your choice of scope).");
    console.log("       [--global]  Install the payload into your GLOBAL config (all projects):");
    console.log("                   commands→~/.claude/commands/guild, agents→the opencode global");
    console.log("                   agent dir, policy→~/.claude/modelguild. No --dir/--write-mcp.");
    console.log("       [--write-mcp]  Opt in to the old behavior: write/merge the project .mcp.json.");
    console.log("       [--npx]     Default launch line: `npx -y modelguild serve`.");
    console.log("       [--abs]     Pin an absolute path to this interpreter+entry (offline/no-registry).");
    console.log("       [--server-command \"cmd args\"]  Override the launch command verbatim.");
    console.log("  doctor [--dir D] Token-free health check ([--global] checks the global locations).");
    console.log("  logs clean       Apply evidence-log retention by hand:");
    console.log("       [--days N]   window in days (default: GUILD_LOG_RETENTION_DAYS,");
    console.log(`                    env > modelguild.conf.local > ${DEFAULT_RETENTION_DAYS}; refuses if unset/0).`);
    console.log("       [--dry-run]  report what would be removed, delete nothing.");
    return 0;
  }
  console.error(`modelguild: unknown command '${cmd}' (see --help)`);
  return 2;
}

// Only run as a program when invoked as the entry point — NOT when imported (the doctor
// test imports `runDoctor`). Compare realpaths so a symlinked bin (npm's `.bin/modelguild`,
// which npx runs) still matches: `import.meta.url` is already realpath-resolved by Node's
// ESM loader, and `realpathSync(argv[1])` resolves the invoking symlink to the same file.
function isEntryPoint(): boolean {
  const invoked = process.argv[1];
  if (!invoked) return false;
  try {
    return SELF === realpathSync(invoked);
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main().then(
    (code) => {
      // `serve` never resolves until teardown; init/doctor set the exit code.
      if (code !== 0) process.exitCode = code;
    },
    (err) => {
      console.error(`modelguild: ${(err as Error).message}`);
      process.exitCode = 1;
    },
  );
}
