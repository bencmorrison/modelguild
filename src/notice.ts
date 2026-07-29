/**
 * The payload-skew NOTICE (issue #94) — the unsolicited half.
 *
 * THE PROBLEM. The MCP server updates itself: `.mcp.json` launches `npx -y modelguild serve`,
 * which resolves the current release on every launch. The payload that server installs — the
 * `/guild:*` command docs, the hardened agent defs, the policy/config templates — lives in the
 * USER'S repo (or their global config) and does not move with it. So a user upgrades the server
 * and keeps running last release's commands and agent defs, silently and indefinitely.
 *
 * `src/init.ts` does the DETECTION (`scanInstalledPayload`, one comparison for every surface).
 * This module is one of its three consumers, and the only one nobody asked for: the line the
 * server writes at start-up. `doctor` and `guild_status` are the other two, and they are asked
 * for — which is why `GUILD_PAYLOAD_NOTICE=off` silences THIS and not those (the same split
 * issue #23 made when `logs clean` kept running under `GUILD_LOG=off`).
 *
 * THREE RULES THIS MODULE MUST NOT BREAK, in order of how badly they would hurt:
 *
 *  1. IT MAY NEVER BREAK THE SERVER. It runs at start-up, around `connect`. Every filesystem
 *     read, every parse, and the write itself is guarded; the entry point cannot throw. A
 *     broken check degrades the notice, never the lifecycle (`src/activity.ts` /
 *     `src/approve.ts` posture).
 *  2. IT MAY NEVER WRITE TO STDOUT. Stdout is the MCP transport; a stray line there corrupts
 *     the protocol stream. The sink is injectable and defaults to stderr.
 *  3. IT MUST NOT NAG. Suppressed per SERVER VERSION, not per session (maintainer decision,
 *     2026-07-29): a user who has deliberately not run `init` should be told once per release,
 *     not once per Claude Code session. Acting on it removes the skew entirely; consciously
 *     ignoring it costs one line, then silence until the next version.
 *
 * WHERE THE SUPPRESSION STATE LIVES, and why not in the ownership record. It goes in
 * `<primary guild root>/.modelguild-notice.json` — beside `modelguild.conf.local`, in the same
 * root the evidence log writes to (`layeredRoots()[0]`). Deliberately NOT in
 * `modelguild/.modelguild-install.json`: that file is the ownership record, the proof of what
 * init wrote and the sole basis for the never-clobber and hash-verified-uninstall guarantees.
 * Runtime "have I mentioned this yet" state has no business sharing a file with it — a bad
 * write there costs the user their upgrade path, and the two have different lifetimes (the
 * record travels with the install; this is per-user, per-machine). It is added to the
 * `.gitignore` block init writes, for the same reason `modelguild.conf.local` is.
 *
 * That location also gets the SCOPE right in both install modes, for free: a per-project
 * install has a project `modelguild/` as the primary root, so dismissing the notice in one
 * project does not silence another; a global-only install resolves to `~/.claude/modelguild/`,
 * where one payload is genuinely shared by every project and one dismissal should cover them
 * all.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  PACKAGE_ROOT,
  packageVersion,
  resolveGlobalDirs,
  scanInstalledPayload,
  type PayloadFileState,
} from "./init.js";
import { layeredRoots, readLayeredConfContents, resolvePayloadNoticeSettings } from "./config.js";

/** Per-user runtime state, beside the config it belongs to. Dot-prefixed and git-ignored. */
export const NOTICE_STATE_FILE = ".modelguild-notice.json";

export function noticeStatePath(guildRoot: string): string {
  return path.join(guildRoot, NOTICE_STATE_FILE);
}

export interface NoticeState {
  /** The package version whose skew notice has already been shown. Absent ⇒ never shown. */
  skewNoticeShownFor?: string;
}

/** Read the state, treating anything unreadable/corrupt as "never shown" — the conservative
 * direction here is to tell the user again, not to go quiet. Never throws. */
export function readNoticeState(file: string): NoticeState {
  try {
    if (!existsSync(file)) return {};
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { skewNoticeShownFor?: unknown };
    const v = parsed.skewNoticeShownFor;
    return typeof v === "string" && v.length > 0 ? { skewNoticeShownFor: v } : {};
  } catch {
    return {};
  }
}

/** Persist the state. Returns false (never throws) when it could not be written — the cost of
 * that is one repeated notice next start-up, which is the harmless direction. */
export function writeNoticeState(file: string, state: NoticeState): boolean {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ version: 1, ...state }, null, 2) + "\n");
    return true;
  } catch {
    return false;
  }
}

/**
 * The ONE rendering of payload skew, shared by the start-up notice and `doctor` so the two
 * cannot word the same fact differently (the same reason `printDriftNote` is shared).
 *
 * `unsolicited` adds the two lines that only make sense on the nag: how to silence it, and the
 * fact that it appears once per server version while `doctor` will always report it.
 */
export function formatSkewNote(opts: {
  skewed: PayloadFileState[];
  version: string;
  indent?: string;
  /** Cap the file list (the notice is bounded; `doctor` passes Infinity and lists them all). */
  maxFiles?: number;
  unsolicited?: boolean;
}): string[] {
  const indent = opts.indent ?? "";
  const max = opts.maxFiles ?? Infinity;
  const n = opts.skewed.length;
  const versionBit = opts.version.length > 0 ? ` (${opts.version})` : "";
  const out: string[] = [];
  out.push(
    `${indent}! ${n} installed ModelGuild file(s) are OUT OF SYNC with what this server ` +
      `ships${versionBit} — ours, unedited, and different bytes.`,
  );
  const shown = opts.skewed.slice(0, max === Infinity ? n : max);
  for (const s of shown) {
    out.push(`${indent}    ${s.dest}`);
    out.push(`${indent}      diff "${s.shippedPath}" "${s.installedPath}"`);
  }
  if (shown.length < n) out.push(`${indent}    … and ${n - shown.length} more`);
  // DIRECTION IS NOT CLAIMED, because two hashes cannot carry it. The ownership record holds
  // no version, so "your copy is older" is an inference from how the pieces update — right in
  // the normal case and wrong for someone who pinned an older server on purpose. The fix is
  // the same either way, so the notice states the usual cause and names the exception rather
  // than asserting a direction it cannot see.
  out.push(
    `${indent}  Normally they are BEHIND: the MCP server updates itself (npx resolves the ` +
      `current release on every launch) while the payload in your repo does not. A ` +
      `deliberately pinned older server makes them ahead instead — the hashes cannot tell ` +
      `those apart.`,
  );
  out.push(
    `${indent}  Fix either way: \`npx modelguild init\` — these files are unedited, so init ` +
      `rewrites them in place (it still never overwrites anything you changed).`,
  );
  if (opts.unsolicited) {
    out.push(
      `${indent}  This appears once per server version. \`npx modelguild doctor\` always ` +
        `reports it; GUILD_PAYLOAD_NOTICE=off in modelguild.conf.local silences THIS line only.`,
    );
  }
  return out;
}

/** Why nothing was printed, or `null` when the notice was emitted. `error` means the check
 * itself failed — reported as data so a caller (or a test) can see it, never thrown. */
export type SkewNoticeOutcome = "knob-off" | "no-skew" | "already-shown" | "error" | null;

export interface SkewNoticeResult {
  outcome: SkewNoticeOutcome;
  skewed: PayloadFileState[];
  lines: string[];
  version: string;
  /** Where the suppression state lives (or would). `""` when resolution itself failed. */
  statePath: string;
  /** True when the state write was attempted and failed — the notice will repeat. */
  stateWriteFailed?: boolean;
}

/**
 * Check for payload skew and, if there is any the user has not been told about for this server
 * version, write the notice to stderr and record that it was shown.
 *
 * Injectable throughout so the suite drives it without touching the real `~`, and so the
 * sink is never `process.stdout` by accident. NEVER THROWS.
 */
export function emitPayloadSkewNotice(
  opts: {
    env?: NodeJS.ProcessEnv;
    cwd?: string;
    home?: string;
    xdgConfigHome?: string;
    packageRoot?: string;
    /** Sink for the notice. Defaults to stderr — NEVER stdout (the MCP transport). */
    write?: (text: string) => void;
  } = {},
): SkewNoticeResult {
  const empty = (outcome: SkewNoticeOutcome, statePath = ""): SkewNoticeResult => ({
    outcome,
    skewed: [],
    lines: [],
    version: "",
    statePath,
  });
  try {
    const env = opts.env ?? process.env;
    const cwd = opts.cwd ?? process.cwd();
    const home = opts.home ?? os.homedir();
    const packageRoot = opts.packageRoot ?? PACKAGE_ROOT;
    const roots = layeredRoots(env, cwd, home);
    const conf = readLayeredConfContents(
      roots.map((r) => r.root),
      env,
    );
    // The knob is checked FIRST: a user who turned this off should not pay for a scan they
    // asked not to have, and "off" is a complete answer on its own.
    if (!resolvePayloadNoticeSettings({ env, confContents: conf }).enabled) {
      return empty("knob-off", noticeStatePath(roots[0].root));
    }

    // The payload the SERVE resolves is the project it was launched in — the same value
    // `resolveAgentDefDir` uses for the agent-def sibling, so the skew check and the refusal
    // check are looking at one directory.
    const targetDir =
      env.GUILD_PROJECT_DIR && env.GUILD_PROJECT_DIR.length > 0 ? env.GUILD_PROJECT_DIR : cwd;
    const gdirs = resolveGlobalDirs({
      homeDir: home,
      ...(opts.xdgConfigHome !== undefined ? { xdgConfigHome: opts.xdgConfigHome } : {}),
      env,
    });
    const scan = scanInstalledPayload({ packageRoot, targetDir, global_dirs: gdirs });
    const statePath = noticeStatePath(roots[0].root);
    const version = packageVersion(packageRoot);
    // DRIFT is deliberately NOT announced here. It is already reported by `init` (from the run
    // that skipped the file) and by `doctor`, it needs a human decision rather than a command,
    // and an edited file is a supported state — a start-up line about it would be nagging
    // someone about a choice they made. Skew is the one nobody was ever told about.
    if (scan.skewed.length === 0) return { ...empty("no-skew", statePath), version };

    const state = readNoticeState(statePath);
    // An unnameable version must not suppress: we cannot claim the user was told about a
    // release we cannot identify.
    if (version.length > 0 && state.skewNoticeShownFor === version) {
      return { outcome: "already-shown", skewed: scan.skewed, lines: [], version, statePath };
    }

    const lines = formatSkewNote({ skewed: scan.skewed, version, maxFiles: 8, unsolicited: true });
    const write = opts.write ?? ((t: string) => void process.stderr.write(t));
    // ONE write for the whole block: stderr is shared with the serve child's own output, and a
    // per-line loop can be interleaved mid-notice by it.
    write(
      lines.map((l, i) => (i === 0 ? `modelguild: ${l.replace(/^! /, "")}` : l)).join("\n") + "\n",
    );
    // No version ⇒ nothing to key suppression on, so no write is ATTEMPTED (and the notice will
    // repeat next start-up — the honest outcome when the release cannot be identified).
    const attempted = version.length > 0;
    const wrote = attempted && writeNoticeState(statePath, { skewNoticeShownFor: version });
    return {
      outcome: null,
      skewed: scan.skewed,
      lines,
      version,
      statePath,
      ...(attempted && !wrote ? { stateWriteFailed: true } : {}),
    };
  } catch {
    // Rule 1: a broken check degrades the notice, never the lifecycle.
    return empty("error");
  }
}
