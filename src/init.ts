/**
 * `modelguild init` — the installer for the MCP era.
 *
 * Where the bash `install.sh` copies the whole bash payload (ask.sh/log.sh/… + all four
 * agent defs + witness.md) into a project, `init` places ONLY the MCP-era surface:
 *   (a) the 8 command docs (7 migrated + configure) → `.claude/commands/guild/`;
 *   (b) the 3 hardened agent defs the MCP tools resolve (`guild-read`/`guild-build`/
 *       `guild-research`) → `.opencode/agent/` (opencode serve resolves `--agent` from
 *       the project's `.opencode/`, and research/delegate REFUSE if their def is absent —
 *       so these are load-bearing, not optional);
 *   (c) the policy/config templates → `modelguild/` (where `resolveGuildRoot` reads them).
 * It does NOT install the bash wrappers or witness.md — those are retiring (M12).
 *
 * MCP REGISTRATION is user-driven by default: `init` does NOT touch `.mcp.json`. The user
 * registers the server themselves (`claude mcp add modelguild -s <scope> -- …`), choosing
 * per-project or global scope. The opt-in `--write-mcp` flag restores the old behavior —
 * writing/merging the project-scoped `.mcp.json` entry under the KEY `modelguild` (the
 * exact key the command grants `mcp__modelguild__<tool>` require).
 *
 * OWNERSHIP is ported from `install.sh`'s SHA-256 model, not reinvented: every file we
 * write records the sha256 of its written bytes in `modelguild/.modelguild-install.json`.
 * A re-install UPGRADES a file only while its current bytes still match the hash we
 * recorded (or already equal the incoming payload); a file the user edited is SKIPPED
 * and left untouched (never clobbered), with a warning. `uninstall` removes only
 * hash-verified files. The record file is deliberately named distinctly from bash's
 * `.install-manifest`/`.install-hashes`, so the two installers never read each other's
 * records. Idempotent.
 *
 * UPGRADE DRIFT (issue #22) is the cost of that never-clobber guarantee: the skip is silent
 * about *why* it matters, so a user who edited a command doc keeps running a copy of a
 * release that has since moved on — with no signal. `isDrifted` names that state exactly
 * (three distinct hashes: recorded ≠ current ≠ shipped, and shipped ≠ recorded) and both
 * `init` and `doctor` REPORT it. Reporting only: the file is still never touched, and drift
 * is a warning, not a failure — an edit is a supported, deliberate act, so a customized
 * install must not turn `doctor` red.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Payload inventory — explicit, like install.sh's PAYLOAD_FILES (no dir walk: a
// source tree can hold ignored/personal files a walk would sweep in).
// ---------------------------------------------------------------------------
const COMMAND_DOCS = [
  "consult",
  "panel",
  "research",
  "review",
  "delegate",
  "workshop",
  "collaborate",
  "configure",
] as const;
/** The hardened agents the MCP tools resolve. guild-watch is witness-only (retired). */
const AGENT_DEFS = ["guild-read", "guild-build", "guild-research"] as const;
const TEMPLATES = ["models.policy", "modelguild.conf.example"] as const;

export interface PayloadEntry {
  /** Path relative to the package root (source). */
  src: string;
  /** Path relative to the target project (destination). Equal to src here. */
  dest: string;
}

export function payloadFiles(): PayloadEntry[] {
  const out: PayloadEntry[] = [];
  for (const c of COMMAND_DOCS) {
    const rel = `.claude/commands/guild/${c}.md`;
    out.push({ src: rel, dest: rel });
  }
  for (const a of AGENT_DEFS) {
    const rel = `.opencode/agent/${a}.md`;
    out.push({ src: rel, dest: rel });
  }
  for (const t of TEMPLATES) {
    const rel = `modelguild/${t}`;
    out.push({ src: rel, dest: rel });
  }
  return out;
}

/** The command docs, for the shadow warning (a same-named non-ours command is silent). */
const COMMAND_DEST_RELS = new Set(
  COMMAND_DOCS.map((c) => `.claude/commands/guild/${c}.md`),
);

/** Deepest-first, pruned on uninstall only when empty (a user file keeps its dir). */
const PRUNE_DIRS = [
  ".claude/commands/guild",
  ".claude/commands",
  ".claude",
  ".opencode/agent",
  ".opencode",
  "modelguild",
];

const RECORD_REL = "modelguild/.modelguild-install.json";
const MCP_KEY = "modelguild";

// ---------------------------------------------------------------------------
// Destination resolution — project (default) vs global.
//
// A payload entry's project-relative `dest` (e.g. `.claude/commands/guild/consult.md`) is
// the stable RECORD KEY in BOTH modes; only the on-disk base changes. `payloadDest` maps a
// dest-rel to `{ base, rel }` so callers pick `safeJoin(base, rel)` (symlink-safe writes,
// init) or `path.join(base, rel)` (plain existence check, doctor) as they need.
// ---------------------------------------------------------------------------
export interface GlobalDirs {
  /** Resolved home dir (defaults to os.homedir()). */
  homeDir: string;
  /** Resolved XDG config home ($XDG_CONFIG_HOME else <homeDir>/.config). */
  xdgConfigHome: string;
}

/** Resolve the global-mode home + XDG dirs, applying injectable overrides ONCE (never read
 * unmockably in a loop). */
export function resolveGlobalDirs(opts: {
  homeDir?: string;
  xdgConfigHome?: string;
  env?: NodeJS.ProcessEnv;
}): GlobalDirs {
  const env = opts.env ?? process.env;
  const homeDir = opts.homeDir && opts.homeDir.length > 0 ? opts.homeDir : os.homedir();
  const xdgConfigHome =
    opts.xdgConfigHome && opts.xdgConfigHome.length > 0
      ? opts.xdgConfigHome
      : env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.length > 0
        ? env.XDG_CONFIG_HOME
        : path.join(homeDir, ".config");
  return { homeDir, xdgConfigHome };
}

/**
 * Map a project-relative payload `dest` to its on-disk `{ base, rel }` for the given mode.
 * Project mode: base is the target project (`dest` unchanged). Global mode: commands/policy
 * land under `<home>/.claude/…`, agent defs under `<xdg>/opencode/agent/`.
 */
export function payloadDest(
  destRel: string,
  opts: { global?: boolean; targetDir: string; global_dirs?: GlobalDirs },
): { base: string; rel: string } {
  if (!opts.global) return { base: opts.targetDir, rel: destRel };
  const g = opts.global_dirs;
  if (!g) throw new Error("payloadDest: global mode requires resolved global dirs");
  if (destRel.startsWith(".claude/commands/guild/")) {
    return { base: g.homeDir, rel: destRel }; // <home>/.claude/commands/guild/<name>.md
  }
  if (destRel.startsWith(".opencode/agent/")) {
    // <xdg>/opencode/agent/guild-<x>.md — SINGULAR `agent`, the dir opencode resolves.
    return { base: g.xdgConfigHome, rel: path.join("opencode", destRel.slice(".opencode/".length)) };
  }
  if (destRel.startsWith("modelguild/")) {
    return {
      base: g.homeDir,
      rel: path.join(".claude", "modelguild", destRel.slice("modelguild/".length)),
    };
  }
  throw new Error(`payloadDest: unmapped payload dest '${destRel}'`);
}

/** The full install/uninstall plan for a run: how to resolve each dest, where the ownership
 * record lives, which dirs to prune, and whether a project `.gitignore` block applies. */
interface InstallPlan {
  destFor(destRel: string): string; // absolute, symlink-safe
  recordPath: string;
  pruneDirs: string[]; // absolute, deepest-first
  gitignoreDir?: string; // project mode only
}

/**
 * Absolute path of the ownership record for a mode. It goes through `payloadDest` with the
 * record's own project-relative path, so the project/global mapping can never drift from the
 * payload's (`modelguild/…` → project `modelguild/` or global `<home>/.claude/modelguild/`).
 * Exported for `doctor`, which must read the record of the mode a file was found in.
 */
export function recordPathFor(opts: {
  global?: boolean;
  targetDir: string;
  global_dirs?: GlobalDirs;
}): string {
  const { base, rel } = payloadDest(RECORD_REL, opts);
  return path.join(base, rel);
}

function planFor(opts: InitOptions): InstallPlan {
  if (opts.global) {
    const g = resolveGlobalDirs(opts);
    const destOpts = { global: true as const, targetDir: opts.targetDir, global_dirs: g };
    return {
      destFor: (rel) => {
        const { base, rel: r } = payloadDest(rel, destOpts);
        return safeJoin(base, r);
      },
      recordPath: (() => {
        const { base, rel } = payloadDest(RECORD_REL, destOpts);
        return safeJoin(base, rel);
      })(),
      pruneDirs: [
        path.join(g.homeDir, ".claude", "commands", "guild"),
        path.join(g.homeDir, ".claude", "commands"),
        path.join(g.xdgConfigHome, "opencode", "agent"),
        path.join(g.homeDir, ".claude", "modelguild"),
      ],
    };
  }
  return {
    destFor: (rel) => safeJoin(opts.targetDir, rel),
    recordPath: safeJoin(opts.targetDir, RECORD_REL),
    pruneDirs: PRUNE_DIRS.map((d) => path.join(opts.targetDir, d)),
    gitignoreDir: opts.targetDir,
  };
}

const GITIGNORE_BEGIN = "# >>> ModelGuild >>>";
const GITIGNORE_END = "# <<< ModelGuild <<<";
const GITIGNORE_BODY = [
  GITIGNORE_BEGIN,
  "# Per-user config written by /guild:configure — never commit personal prefs.",
  "modelguild/models.policy.local",
  "modelguild/modelguild.conf.local",
  "# The evidence layer: raw prompts/responses of every model call (modelguild/logs).",
  "modelguild/logs/",
  GITIGNORE_END,
  "",
].join("\n");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface ServerLaunch {
  command: string;
  args: string[];
  /** Extra env keys to write into the `.mcp.json` server entry (GUILD_PROJECT_DIR is
   * always added by init from the target dir). */
  env?: Record<string, string>;
}

export interface InitOptions {
  /** Absolute path to the target project the payload lands in. Ignored when `global`. */
  targetDir: string;
  /** Absolute path to the package root the payload is read from. */
  packageRoot: string;
  /** How `.mcp.json` should launch the MCP server (command/args/env). */
  serverLaunch: ServerLaunch;
  /** true → uninstall (hash-verified removal) instead of install. */
  uninstall?: boolean;
  /** OPT-IN: write/merge the project `.mcp.json` server entry (the old auto-write). Default
   * false — the user registers the server themselves (`claude mcp add`, their choice of
   * scope), so `mcpAction` is `"skipped"` unless this is set. Ignored (forced skipped) in
   * `global` mode — there is no project `.mcp.json`. */
  writeMcp?: boolean;
  /**
   * GLOBAL payload install: place the payload into the user's global config so `/guild:*`,
   * the hardened agent defs, and the policy are available in EVERY project without a
   * per-project `init`. Destinations change (SOURCE files are identical, only DEST differs):
   *   command docs → `<homeDir>/.claude/commands/guild/<name>.md`
   *   agent defs   → `<xdgConfigHome>/opencode/agent/guild-<x>.md`
   *   policy/conf  → `<homeDir>/.claude/modelguild/<file>`
   *   record       → `<homeDir>/.claude/modelguild/.modelguild-install.json` (SEPARATE from
   *                  the per-project record so the two installs never read each other's).
   * No `.gitignore` block is written (there is no project). Same SHA-256 ownership semantics.
   */
  global?: boolean;
  /** Home dir for global-mode destinations. INJECTABLE for tests; defaults to `os.homedir()`.
   * Resolved once (not read unmockably inside the payload loop). */
  homeDir?: string;
  /** XDG config home for the global opencode agent dir. INJECTABLE for tests; defaults to
   * `$XDG_CONFIG_HOME` else `<homeDir>/.config`. */
  xdgConfigHome?: string;
}

export interface InitResult {
  installed: string[];
  skipped: string[];
  removed: string[];
  /** Command docs a user already had at our path that are NOT ours (shadowing). */
  shadowed: string[];
  /** UPGRADE DRIFT (issue #22): files init wrote, the user then edited, whose shipped bytes have
   * CHANGED since the version that edit was based on — so this upgrade skipped them and the
   * user's copy is now behind the release. Reported, never touched. */
  drifted: DriftEntry[];
  warnings: string[];
  /** `.mcp.json` outcome. `kept` (uninstall only): a `modelguild` key was present but left in
   * place because the ownership record does not prove init wrote it, or the current entry no
   * longer matches what init wrote — mirrors the skip-if-edited file guarantee. */
  mcpAction: "created" | "merged" | "updated" | "removed" | "unchanged" | "skipped" | "kept";
}

type Records = Record<string, string>; // destRel -> sha256(hex)

/** Proof that init wrote the project `.mcp.json` `modelguild` key: the key name plus the
 * sha256 of the exact entry init serialized. Persisted in the ownership record only on a
 * `--write-mcp` install; absent for a default install (init did not touch `.mcp.json`). */
interface McpRecord {
  key: string;
  entryHash: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** Reject `..`, absolute, and empty components — the valid_rel guard from install.sh. */
function validRel(rel: string): boolean {
  if (!rel || path.isAbsolute(rel)) return false;
  const parts = rel.split("/");
  return parts.every((p) => p.length > 0 && p !== "..");
}

/**
 * Resolve `<base>/<rel>` refusing a symlink at ANY existing component — the
 * safe_dest_rel guard: a planted symlink (payload file or intermediate dir) must not
 * redirect a write outside `base`.
 */
function safeJoin(base: string, rel: string): string {
  if (!validRel(rel)) throw new Error(`refusing unsafe path: ${rel}`);
  let cur = base;
  for (const part of rel.split("/")) {
    cur = path.join(cur, part);
    if (existsSync(cur) && lstatSync(cur).isSymbolicLink()) {
      throw new Error(`refusing destination symlink: ${rel}`);
    }
  }
  return cur;
}

function readRecords(recordPath: string): Records {
  const p = recordPath;
  if (!existsSync(p)) return {};
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as { files?: unknown };
    const files = parsed.files;
    if (files && typeof files === "object") {
      const out: Records = {};
      for (const [k, v] of Object.entries(files as Record<string, unknown>)) {
        if (typeof v === "string" && /^[0-9a-f]{64}$/.test(v)) out[k] = v;
      }
      return out;
    }
  } catch {
    /* unreadable/corrupt → treat as no records (conservative: nothing is "owned") */
  }
  return {};
}

/** Read the MCP ownership proof from the record, if present and well-formed. A missing/legacy
 * record (no `mcp` field) or an unreadable one returns `undefined` — treated as NOT owned, so
 * uninstall never deletes a `.mcp.json` key it cannot prove init wrote. */
function readMcpRecord(recordPath: string): McpRecord | undefined {
  if (!existsSync(recordPath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(recordPath, "utf8")) as { mcp?: unknown };
    const m = parsed.mcp;
    if (m && typeof m === "object" && !Array.isArray(m)) {
      const key = (m as Record<string, unknown>).key;
      const entryHash = (m as Record<string, unknown>).entryHash;
      if (typeof key === "string" && key.length > 0 && typeof entryHash === "string" && /^[0-9a-f]{64}$/.test(entryHash)) {
        return { key, entryHash };
      }
    }
  } catch {
    /* unreadable/corrupt → undefined (conservative: nothing is "owned") */
  }
  return undefined;
}

function writeRecords(recordPath: string, records: Records, mcp?: McpRecord): void {
  mkdirSync(path.dirname(recordPath), { recursive: true });
  const payload: { version: number; files: Records; mcp?: McpRecord } = { version: 1, files: records };
  if (mcp) payload.mcp = mcp;
  const body = JSON.stringify(payload, null, 2) + "\n";
  writeFileSync(recordPath, body);
}

/** Canonical sha256 of a `.mcp.json` server entry, used to prove init wrote it and to detect
 * a later user edit. Relies on JSON key order round-tripping write→parse (init writes the file,
 * so order is preserved); a hand-reordered entry hashes differently and is conservatively kept. */
function mcpEntryHash(entry: unknown): string {
  return sha256(Buffer.from(JSON.stringify(entry), "utf8"));
}

function ensureDir(p: string): void {
  mkdirSync(p, { recursive: true });
}

// ---------------------------------------------------------------------------
// Upgrade drift (issue #22)
//
// The never-clobber rule means an upgrade SKIPS a file the user edited. That is correct and
// stays — but silently leaves the user on a stale copy when the release has moved on. Drift is
// the state where THREE hashes are all distinct:
//   recorded — what init last wrote (proof the file is ours, and which version the edit was
//              based on);
//   current  — what is on disk now (≠ recorded ⇒ the user edited it);
//   shipped  — what this package ships now (≠ recorded ⇒ the release moved on since that edit).
// Only then is the user's copy BEHIND the release. Two adjacent states are deliberately NOT
// drift: an edit against the still-current release (recorded === shipped — nothing to catch up
// to), and a file with no record at all (never ours — a user's own file at our path, the
// `shadowed` case; calling that "stale" would be a guess).
// ---------------------------------------------------------------------------

/** One file whose installed copy is behind (or unjudgeable against) the shipped payload. */
export interface DriftEntry {
  /** Project-relative payload dest — the stable record key in BOTH modes. */
  dest: string;
  /** Absolute path of the user's copy on disk. */
  installedPath: string;
  /** Absolute path of the bytes this package ships (for the `diff` hint). */
  shippedPath: string;
}

/** True when the installed copy is ours, edited, AND behind the shipped payload. See the
 * section comment for why each of the three exclusions is deliberate. */
export function isDrifted(
  recorded: string | undefined,
  current: string,
  shipped: string,
): boolean {
  if (!recorded) return false; // never ours ⇒ not stale, just someone else's file
  if (current === recorded) return false; // unedited ⇒ the upgrade path handles it
  if (current === shipped) return false; // already equals the release ⇒ nothing behind
  return shipped !== recorded; // the release moved on since the edit was based on it
}

/** One file to test, as resolved by the caller: `doctor` picks the location the file was
 * actually found in (project or global) and the record for THAT mode. */
export interface DriftScanEntry {
  dest: string;
  installedPath: string;
  recordPath: string;
}

export interface DriftScanResult {
  /** Ours-but-stale (see `isDrifted`). */
  drifted: DriftEntry[];
  /** Differs from the shipped bytes but NO ownership record covers it — an intentional edit
   * and a stale leftover are indistinguishable here. Reported as unjudgeable, never guessed. */
  unknown: DriftEntry[];
  /** Record files that were consulted and do not exist (absolute, de-duplicated) — the honest
   * reason `unknown` entries could not be judged. */
  missingRecords: string[];
}

/**
 * Standalone drift scan for `doctor` (which has no install run in hand). Files identical to the
 * shipped bytes are skipped before any record is read, so a pristine install consults nothing.
 */
export function scanDrift(packageRoot: string, entries: DriftScanEntry[]): DriftScanResult {
  const srcFor = new Map(payloadFiles().map((p) => [p.dest, p.src]));
  const recordCache = new Map<string, Records>();
  const missingRecords = new Set<string>();
  const drifted: DriftEntry[] = [];
  const unknown: DriftEntry[] = [];
  for (const e of entries) {
    const src = srcFor.get(e.dest);
    if (!src) continue; // not a payload file — nothing shipped to compare against
    const shippedPath = path.join(packageRoot, src);
    let current: string;
    let shipped: string;
    try {
      if (!existsSync(shippedPath) || !existsSync(e.installedPath)) continue;
      if (!lstatSync(e.installedPath).isFile()) continue;
      current = sha256(readFileSync(e.installedPath));
      shipped = sha256(readFileSync(shippedPath));
    } catch {
      continue; // unreadable → say nothing rather than guess
    }
    if (current === shipped) continue; // up to date
    if (!recordCache.has(e.recordPath)) {
      if (!existsSync(e.recordPath)) missingRecords.add(e.recordPath);
      recordCache.set(e.recordPath, readRecords(e.recordPath));
    }
    const recorded = recordCache.get(e.recordPath)?.[e.dest];
    const entry: DriftEntry = { dest: e.dest, installedPath: e.installedPath, shippedPath };
    if (!recorded) unknown.push(entry);
    else if (isDrifted(recorded, current, shipped)) drifted.push(entry);
    // recorded && !drifted ⇒ ours, edited, but the release has not moved: a plain local edit.
  }
  return { drifted, unknown, missingRecords: [...missingRecords] };
}

// ---------------------------------------------------------------------------
// .mcp.json merge / removal
// ---------------------------------------------------------------------------
export function mcpServerEntry(opts: InitOptions): Record<string, unknown> {
  const env: Record<string, string> = {
    GUILD_PROJECT_DIR: opts.targetDir,
    ...(opts.serverLaunch.env ?? {}),
  };
  return {
    command: opts.serverLaunch.command,
    args: opts.serverLaunch.args,
    env,
  };
}

function writeMcpJson(opts: InitOptions): { action: InitResult["mcpAction"]; entryHash: string } {
  const p = safeJoin(opts.targetDir, ".mcp.json");
  const entry = mcpServerEntry(opts);
  const entryHash = mcpEntryHash(entry);
  let root: Record<string, unknown> = {};
  let existed = false;
  let hadKey = false;
  if (existsSync(p)) {
    existed = true;
    const raw = readFileSync(p, "utf8");
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        root = parsed as Record<string, unknown>;
      } else {
        throw new Error(".mcp.json is not a JSON object — refusing to overwrite it");
      }
    } catch (err) {
      throw new Error(
        `.mcp.json exists but is not valid JSON (${(err as Error).message}); ` +
          `fix or remove it, then re-run init.`,
      );
    }
  }
  const servers =
    root.mcpServers && typeof root.mcpServers === "object" && !Array.isArray(root.mcpServers)
      ? (root.mcpServers as Record<string, unknown>)
      : {};
  hadKey = Object.prototype.hasOwnProperty.call(servers, MCP_KEY);
  servers[MCP_KEY] = entry;
  root.mcpServers = servers;
  ensureDir(path.dirname(p));
  writeFileSync(p, JSON.stringify(root, null, 2) + "\n");
  const action: InitResult["mcpAction"] = !existed ? "created" : hadKey ? "updated" : "merged";
  return { action, entryHash };
}

/**
 * Remove the `modelguild` key from a project `.mcp.json` — but ONLY when the ownership record
 * proves init wrote it (`owned`) AND the current entry still matches what init wrote. This
 * mirrors the SHA-256 file ownership: init removes only what it can prove it wrote, unedited.
 * A user-created key (default install: init never touched `.mcp.json`), a legacy record with
 * no `mcp` field, or a user-edited entry are all KEPT with a warning, never deleted.
 * A read/parse failure or a missing key is `unchanged`.
 */
function removeMcpKey(
  targetDir: string,
  owned: McpRecord | undefined,
): { action: InitResult["mcpAction"]; warning?: string } {
  const p = safeJoin(targetDir, ".mcp.json");
  if (!existsSync(p)) return { action: "unchanged" };
  let root: Record<string, unknown>;
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { action: "unchanged" };
    root = parsed as Record<string, unknown>;
  } catch {
    return { action: "unchanged" };
  }
  const servers = root.mcpServers as Record<string, unknown> | undefined;
  if (!servers || typeof servers !== "object") return { action: "unchanged" };
  if (!Object.prototype.hasOwnProperty.call(servers, MCP_KEY)) return { action: "unchanged" };
  // The key exists — but delete it only with proof init wrote it (fail-safe: never remove a
  // registration the user made themselves).
  if (!owned || owned.key !== MCP_KEY) {
    return {
      action: "kept",
      warning:
        `keeping the '${MCP_KEY}' .mcp.json key — no ownership record proves init wrote it ` +
        `(a registration you made yourself is yours to remove: \`claude mcp remove ${MCP_KEY}\`).`,
    };
  }
  if (mcpEntryHash(servers[MCP_KEY]) !== owned.entryHash) {
    return {
      action: "kept",
      warning: `keeping the changed '${MCP_KEY}' .mcp.json key — it no longer matches what init wrote.`,
    };
  }
  delete servers[MCP_KEY];
  writeFileSync(p, JSON.stringify(root, null, 2) + "\n");
  return { action: "removed" };
}

// ---------------------------------------------------------------------------
// gitignore block (idempotent, fenced) — mirrors install.sh's markers so a project
// that also had a bash install shares one block rather than doubling it.
// ---------------------------------------------------------------------------
function stripGitignoreBlock(text: string): string {
  const lines = text.split("\n");
  const begin = lines.indexOf(GITIGNORE_BEGIN);
  const end = lines.indexOf(GITIGNORE_END);
  // Only strip when BOTH markers are present and ordered (a lone begin must not
  // swallow the rest of the file — the install.sh guard).
  if (begin === -1 || end === -1 || begin >= end) return text;
  const before = lines.slice(0, begin);
  // Drop one separator blank line we inserted before the block.
  if (before.length > 0 && before[before.length - 1] === "") before.pop();
  const after = lines.slice(end + 1);
  return [...before, ...after].join("\n");
}

function addGitignoreBlock(targetDir: string): void {
  const p = safeJoin(targetDir, ".gitignore");
  let text = existsSync(p) ? readFileSync(p, "utf8") : "";
  text = stripGitignoreBlock(text); // idempotent — never double-add
  if (text.length > 0 && !text.endsWith("\n")) text += "\n";
  if (text.length > 0) text += "\n";
  text += GITIGNORE_BODY;
  writeFileSync(p, text);
}

function stripGitignoreOnly(targetDir: string): void {
  const p = path.join(targetDir, ".gitignore");
  if (!existsSync(p)) return;
  const stripped = stripGitignoreBlock(readFileSync(p, "utf8"));
  writeFileSync(p, stripped);
}

// ---------------------------------------------------------------------------
// Install / uninstall
// ---------------------------------------------------------------------------
function pruneEmptyDirs(dirs: string[]): void {
  for (const abs of dirs) {
    if (!existsSync(abs)) continue;
    try {
      if (readdirSync(abs).length === 0) rmdirSync(abs);
    } catch {
      /* not empty or not a dir — leave it */
    }
  }
}

export function init(opts: InitOptions): InitResult {
  const result: InitResult = {
    installed: [],
    skipped: [],
    removed: [],
    shadowed: [],
    drifted: [],
    warnings: [],
    mcpAction: "unchanged",
  };
  const plan = planFor(opts);
  const records = readRecords(plan.recordPath);
  const ownedMcp = readMcpRecord(plan.recordPath);

  if (opts.uninstall) {
    for (const { dest } of payloadFiles()) {
      const abs = plan.destFor(dest);
      if (!existsSync(abs)) continue;
      const recorded = records[dest];
      if (!recorded) {
        result.warnings.push(`keeping ${dest} — no ownership record to prove it's ours.`);
        continue;
      }
      const current = sha256(readFileSync(abs));
      if (current === recorded) {
        unlinkSync(abs);
        result.removed.push(dest);
      } else {
        result.warnings.push(`keeping changed file ${dest} — it no longer matches what init wrote.`);
      }
    }
    // No project .mcp.json in global mode; the global payload never wrote one.
    if (opts.global) {
      result.mcpAction = "unchanged";
    } else {
      const { action, warning } = removeMcpKey(opts.targetDir, ownedMcp);
      result.mcpAction = action;
      if (warning) result.warnings.push(warning);
    }
    // Remove the record file, then (project only) the gitignore block, then empty dirs.
    if (existsSync(plan.recordPath)) unlinkSync(plan.recordPath);
    if (plan.gitignoreDir) stripGitignoreOnly(plan.gitignoreDir);
    pruneEmptyDirs(plan.pruneDirs);
    return result;
  }

  // Install / upgrade.
  const newRecords: Records = {};
  for (const { src, dest } of payloadFiles()) {
    const srcAbs = path.join(opts.packageRoot, src);
    if (!existsSync(srcAbs)) {
      result.warnings.push(`payload source missing in package: ${src} (skipped).`);
      continue;
    }
    const payloadBytes = readFileSync(srcAbs);
    const payloadHash = sha256(payloadBytes);
    const destAbs = plan.destFor(dest);

    if (existsSync(destAbs)) {
      if (!lstatSync(destAbs).isFile()) {
        result.warnings.push(`skipping ${dest} — a non-file exists there; left untouched.`);
        result.skipped.push(dest);
        if (records[dest]) newRecords[dest] = records[dest];
        continue;
      }
      const current = sha256(readFileSync(destAbs));
      const owned = records[dest] === current || current === payloadHash;
      if (!owned) {
        // A file the user already had (or edited). Never clobber it — but SAY when the skip
        // leaves them behind the release (issue #22), which the old bare warning did not.
        result.skipped.push(dest);
        const recorded = records[dest];
        if (isDrifted(recorded, current, payloadHash)) {
          result.drifted.push({ dest, installedPath: destAbs, shippedPath: srcAbs });
          result.warnings.push(
            `skipping ${dest} — you edited it since init wrote it, and this release ships a ` +
              `NEWER version: your copy is stale (see the drift note).`,
          );
        } else {
          result.warnings.push(
            recorded
              ? `skipping ${dest} — you edited it since init wrote it; left untouched ` +
                `(your edit is against the version this release still ships — not stale).`
              : `skipping ${dest} — a file you already have is there; left untouched.`,
          );
        }
        if (COMMAND_DEST_RELS.has(dest)) result.shadowed.push(dest);
        if (records[dest]) newRecords[dest] = records[dest];
        continue;
      }
      if (current === payloadHash) {
        // Already up to date — record and move on (idempotent no-write).
        newRecords[dest] = payloadHash;
        continue;
      }
    }
    ensureDir(path.dirname(destAbs));
    writeFileSync(destAbs, payloadBytes);
    newRecords[dest] = payloadHash;
    result.installed.push(dest);
  }

  // MCP registration is user-driven by default (`claude mcp add`, their choice of scope);
  // only the opt-in `--write-mcp` path writes the project `.mcp.json` for them. Global mode
  // has no project `.mcp.json`, so writeMcp is ignored there (forced skipped).
  let mcpRecord: McpRecord | undefined;
  if (!opts.global && opts.writeMcp) {
    const { action, entryHash } = writeMcpJson(opts);
    result.mcpAction = action;
    mcpRecord = { key: MCP_KEY, entryHash }; // proof for a future uninstall
  } else {
    result.mcpAction = "skipped";
    // Carry forward a prior --write-mcp ownership proof so a DEFAULT re-run does not forget
    // that init wrote the key (mirrors carrying an unchanged file's record forward).
    mcpRecord = ownedMcp;
  }
  writeRecords(plan.recordPath, newRecords, mcpRecord);
  // A project `.gitignore` block only makes sense for a project install.
  if (plan.gitignoreDir) addGitignoreBlock(plan.gitignoreDir);
  return result;
}
