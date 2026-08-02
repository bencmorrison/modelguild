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
 * WHERE THE SUPPRESSION STATE LIVES — and the two things it must NOT be.
 *
 * It must not be the OWNERSHIP RECORD (`modelguild/.modelguild-install.json`). That file is the
 * proof of what init wrote and the sole basis for never-clobber and hash-verified uninstall; a
 * bad write there costs the user their upgrade path. The two also have different lifetimes: the
 * record travels with the install, this is per-user and per-machine.
 *
 * And it must not be IN THE USER'S REPO AT ALL (review finding M3, reproduced). The first draft
 * put it in the primary guild root, which for a project install is `<repo>/modelguild/`, and
 * added an ignore line to the block `init` writes — but **only `init` writes that block, and the
 * population this notice exists for is by definition the population that has not re-run `init`.**
 * So the first thing the server did on the upgrade path was drop an untracked, commitable file
 * with per-machine content into someone's repository, with the ignore line arriving only after
 * they acted on the notice. The state now lives in `$GUILD_ROOT` when one is pinned (that knob
 * means "guild state lives here, and nowhere else" — writing anywhere else would be the
 * surprise) and otherwise in `<home>/.claude/modelguild/.modelguild-notice.json`, the global
 * guild root. Consequences, stated: it can CREATE `~/.claude/modelguild/` on a machine that had
 * no global install, and a `$GUILD_ROOT` pointed at a repo puts the file back in that repo —
 * which is then the user's explicit instruction, not ours.
 *
 * WHAT IT IS KEYED ON. One file holds a MAP, keyed by the ownership record(s) the skewed files
 * were judged against (`PayloadFileState.recordPath`). That key comes out of the scan itself, so
 * the half of the feature that decides *what* to announce and the half that decides *whether it
 * has been announced* cannot disagree (review finding L2). It also gets install scope right,
 * which a root-derived key did not: a GLOBAL-only payload is one record, so it is announced once
 * across every project sharing it; a project install is its own record, so dismissing it in one
 * project says nothing about another. The earlier root-based location got this wrong whenever a
 * project `modelguild/` existed alongside a global payload — which `/guild:configure` creates —
 * and re-announced the same global skew per project (review finding L1, reproduced).
 *
 * THREE RULES THIS MODULE MUST NOT BREAK, in order of how badly they would hurt:
 *
 *  1. IT MAY NEVER BREAK THE SERVER. It runs at start-up, before `connect`. Every filesystem
 *     read, every parse, and the write itself is guarded; the entry point cannot throw. A
 *     broken check degrades the notice, never the lifecycle (`src/activity.ts` /
 *     `src/approve.ts` posture). **A `try/catch` is not sufficient for that and did not used to
 *     be true here:** a FIFO at the state path made `readFileSync` BLOCK, which no `catch` can
 *     reach, and the server never came up (review finding M4, reproduced). The read is now
 *     gated on `lstat` saying a regular file — the same guard `scanPayload` already applies one
 *     file away in `src/init.ts`.
 *  2. IT MAY NEVER WRITE TO STDOUT. Stdout is the MCP transport; a stray line there corrupts
 *     the protocol stream. The sink is injectable and defaults to stderr.
 *  3. IT MUST NOT NAG. Suppressed per SERVER VERSION, not per session (maintainer decision,
 *     2026-07-29): a user who has deliberately not run `init` should be told once per release,
 *     not once per Claude Code session. Acting on it removes the skew entirely; consciously
 *     ignoring it costs one line, then silence until the next version.
 *
 * THE KEY IS VERSION + PAYLOAD FINGERPRINT (issue #145, maintainer decision 2026-08-02). This
 * used to be the version string alone (review finding L4), and that was a stated limit: a
 * republish under the same version, a `next`/`latest` dist-tag that moves, or development from a
 * source checkout could move the shipped payload while the notice stayed silent. The fix folds a
 * digest over the SHIPPED-payload hashes `scanInstalledPayload` already computed for the current
 * scan's skewed files (`payloadFingerprint`, below) into the suppression key beside the version —
 * no rescan, no second read of the payload. Suppression now requires BOTH to match; either one
 * failing to compute (an unreadable version, or a fingerprint `payloadFingerprint` could not form)
 * means the notice fires — same direction as the old unreadable-version case, never a guess.
 * **Cost, accepted with the decision:** someone iterating on the payload from a source checkout
 * sees the notice re-fire on every payload change, not just every version bump — the population
 * most likely to hit this, and `GUILD_PAYLOAD_NOTICE=off` remains the escape. **Stored as two
 * separate fields, not a concatenation** (`NoticeStateEntry`), so the state file stays
 * inspectable — you can read which version and which payload a suppression is keyed on without
 * decoding anything. **Backward compatibility:** a state file written before this change recorded
 * the bare version string as the value. Read as `{ version, fingerprint: undefined }` — an absent
 * fingerprint never equals a freshly computed one, so a legacy entry does NOT suppress the new
 * key: the notice fires once more (the safe direction, consistent with "tell again, never guess a
 * match") and the entry is rewritten with both fields on that same run.
 */

import { lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import {
  PACKAGE_ROOT,
  packageVersion,
  resolveGlobalDirs,
  resolveProjectDir,
  scanInstalledPayload,
  type PayloadFileState,
} from "./init.js";
import { readLayeredConfContents, layeredRoots, resolvePayloadNoticeSettings } from "./config.js";

/** Per-user, per-machine runtime state. One file, a map keyed by ownership record. */
export const NOTICE_STATE_FILE = ".modelguild-notice.json";

/**
 * Where the state file lives: the pinned `$GUILD_ROOT` if there is one, else the GLOBAL guild
 * root. Never the auto-detected project root — see the header (review finding M3).
 */
export function noticeStatePath(opts: {
  env?: NodeJS.ProcessEnv;
  home?: string;
} = {}): string {
  const env = opts.env ?? process.env;
  const pinned = env.GUILD_ROOT;
  if (pinned && pinned.length > 0) return path.join(pinned, NOTICE_STATE_FILE);
  const home = opts.home ?? os.homedir();
  return path.join(home, ".claude", "modelguild", NOTICE_STATE_FILE);
}

/** The suppression key for a set of skewed files: the ownership record(s) that judged them,
 * de-duplicated and sorted so the key is stable regardless of scan order. Identifies the
 * INSTALL, which is what the announcement is actually about. */
export function noticeKeyFor(skewed: PayloadFileState[]): string {
  return [...new Set(skewed.map((s) => s.recordPath))].sort().join("\n");
}

/**
 * A digest over the SHIPPED-payload hashes `scanInstalledPayload` already computed for the
 * skewed files in THIS scan — not a rescan, not a second read of the payload. Sorted by `dest`
 * (paired with its hash) before hashing, so the fingerprint does not depend on scan order —
 * mirrors `noticeKeyFor`.
 *
 * Scoped to the currently-skewed set rather than the whole payload: those are exactly the
 * shipped hashes this call already has in hand, and a file that already matches the shipped
 * bytes contributes nothing to "is the user out of sync" anyway.
 *
 * Returns `null` — "could not be computed" — for an empty set (the caller only ever calls this
 * when there IS skew, so this is defensive, not a real path) or a malformed entry (missing/empty
 * `dest`/`shippedHash`, which the type rules out but a corrupted scan should still not be
 * trusted). The caller (`emitPayloadSkewNotice`) must treat `null` exactly like an unreadable
 * version: it may never be used to suppress anything (issue #145).
 */
export function payloadFingerprint(skewed: PayloadFileState[]): string | null {
  try {
    if (!Array.isArray(skewed) || skewed.length === 0) return null;
    const parts: string[] = [];
    for (const s of skewed) {
      if (!s || typeof s.dest !== "string" || s.dest.length === 0) return null;
      if (typeof s.shippedHash !== "string" || s.shippedHash.length === 0) return null;
      parts.push(`${s.dest}:${s.shippedHash}`);
    }
    parts.sort();
    return createHash("sha256").update(parts.join("\n")).digest("hex");
  } catch {
    return null;
  }
}

/** What a suppression is keyed on for one install record: the server version AND a fingerprint
 * of the shipped payload that skew was judged against (issue #145). Two separate fields, not a
 * concatenation, so the state file stays inspectable. `fingerprint` is absent for an entry
 * written before this change (or when it could not be computed) — see the header. */
export interface NoticeStateEntry {
  version: string;
  fingerprint?: string;
}

export interface NoticeState {
  /** record-key → the version (+ payload fingerprint) whose skew notice has already been shown
   * for it. */
  seen: Record<string, NoticeStateEntry>;
}

/** Cap on the map, so a long-lived home config cannot grow a state file without bound. Entries
 * beyond it are dropped OLDEST-FIRST by insertion order, whose only cost is re-announcing a
 * project you have not opened in a very long time. */
const MAX_SEEN_ENTRIES = 200;

/**
 * Read the state, treating anything unreadable, corrupt, or not a regular file as "never
 * shown" — the conservative direction is to tell the user again, never to go quiet. Never
 * throws AND NEVER BLOCKS: the `lstat` gate is what keeps a FIFO at this path from hanging the
 * server before `connect` (review finding M4).
 */
export function readNoticeState(file: string): NoticeState {
  try {
    if (!lstatSync(file).isFile()) return { seen: {} };
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { seen?: unknown };
    const seen = parsed.seen;
    if (!seen || typeof seen !== "object" || Array.isArray(seen)) return { seen: {} };
    const out: Record<string, NoticeStateEntry> = {};
    for (const [k, v] of Object.entries(seen as Record<string, unknown>)) {
      // LEGACY shape (pre-#145): the value was the bare version string. Normalized to an entry
      // with NO fingerprint — which never equals a freshly computed one, so this alone is what
      // makes a legacy entry fail to suppress the new key (issue #145's backward-compat call).
      if (typeof v === "string" && v.length > 0) {
        out[k] = { version: v };
        continue;
      }
      // Current shape: { version, fingerprint? }.
      if (v && typeof v === "object" && !Array.isArray(v)) {
        const obj = v as Record<string, unknown>;
        if (typeof obj.version === "string" && obj.version.length > 0) {
          const entry: NoticeStateEntry = { version: obj.version };
          if (typeof obj.fingerprint === "string" && obj.fingerprint.length > 0) {
            entry.fingerprint = obj.fingerprint;
          }
          out[k] = entry;
        }
      }
    }
    return { seen: out };
  } catch {
    return { seen: {} }; // absent, unreadable, or corrupt — all mean "announce it"
  }
}

/**
 * Persist the state via a temp file and `rename`.
 *
 * The rename is doing two jobs. It makes the replacement atomic, so a torn file is never left
 * for the next start to parse; and it is what stops the write FOLLOWING A SYMLINK at the state
 * path, which the plain `writeFileSync` did — verified to create a file outside the guild root
 * (review finding M5). `rename(2)` replaces the link itself.
 *
 * DELIBERATELY NOT `safeJoin` (init's guard, which refuses a symlink at ANY component): a
 * dotfiles-managed `~/.claude` is a symlink in exactly the setup this repo's own dev container
 * documents, so refusing a symlinked intermediate directory would break supported installs to
 * guard a path with no caller-supplied components. The residual is named rather than closed: a
 * symlinked intermediate DIRECTORY is followed, by design.
 *
 * Returns false (never throws) when it could not be written. **The cost of a persistent failure
 * is that the notice fires on EVERY start, not once** (review finding L5): with a read-only
 * root, or a directory sitting at the state path, there is nothing to record and nothing to
 * suppress on, so rule 3 above is the rule that gives way. It is the safe direction — the user
 * is over-told rather than under-told — and `GUILD_PAYLOAD_NOTICE=off` is the escape.
 */
export function writeNoticeState(file: string, state: NoticeState): boolean {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    // Trim oldest-first (insertion order) before writing, so the cap is enforced on disk.
    const entries = Object.entries(state.seen);
    const kept = entries.length > MAX_SEEN_ENTRIES ? entries.slice(-MAX_SEEN_ENTRIES) : entries;
    // File-format version bumped 1 → 2 for issue #145 (seen values became {version,
    // fingerprint?} objects instead of bare strings). `readNoticeState` does not gate on this
    // number — it distinguishes the two shapes structurally — so it is informational only, for
    // a human reading the file, not a compatibility switch.
    writeFileSync(tmp, JSON.stringify({ version: 2, seen: Object.fromEntries(kept) }, null, 2) + "\n");
    renameSync(tmp, file);
    return true;
  } catch {
    try {
      unlinkSync(tmp);
    } catch {
      /* best-effort cleanup; a stray tmp file is harmless and the next write uses a new name */
    }
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
  // THE COMMAND IS VERSION-PINNED, and that is load-bearing rather than tidy (review finding
  // M2). `npx modelguild init` resolves the LATEST dist-tag, not the version running here — so
  // in the pinned-older-server case, the exact case the direction-neutral wording above exists
  // for, the plain command installs a NEWER payload and the skew never clears. Pinning the
  // running version is what makes "fix either way" true instead of merely reassuring.
  out.push(
    opts.version.length > 0
      ? `${indent}  Fix either way: \`npx modelguild@${opts.version} init\` — pinned to the ` +
          `version running here, so it converges whichever side is ahead (plain \`npx ` +
          `modelguild init\` installs the LATEST payload, which does not converge on a pinned ` +
          `older server). These files are unedited, so init rewrites them in place; it still ` +
          `never overwrites anything you changed.`
      : `${indent}  Fix: \`npx modelguild init\` — these files are unedited, so init rewrites ` +
          `them in place (it still never overwrites anything you changed). This server's ` +
          `version could not be read, so the command cannot be pinned to it: that installs the ` +
          `LATEST payload, which converges only if this server is the latest release.`,
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
  /** The record-derived key this announcement is filed under (`""` when there is no skew). */
  key: string;
  /** The payload fingerprint this call computed (issue #145), or `null` when there was no skew
   * to fingerprint or it could not be computed — see `payloadFingerprint`. */
  fingerprint: string | null;
  /** True when the state write was attempted and failed. The notice then repeats on EVERY
   * start, not once — see `writeNoticeState` (review finding L5). */
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
    /** Test injection point for `payloadFingerprint` (issue #145) — lets the suite simulate an
     * uncomputable fingerprint without corrupting real scan data. Defaults to the real
     * function; production never overrides it. */
    computeFingerprint?: (skewed: PayloadFileState[]) => string | null;
  } = {},
): SkewNoticeResult {
  const empty = (outcome: SkewNoticeOutcome, statePath = ""): SkewNoticeResult => ({
    outcome,
    skewed: [],
    lines: [],
    version: "",
    statePath,
    key: "",
    fingerprint: null,
  });
  try {
    const env = opts.env ?? process.env;
    const cwd = opts.cwd ?? process.cwd();
    const home = opts.home ?? os.homedir();
    const packageRoot = opts.packageRoot ?? PACKAGE_ROOT;
    const statePath = noticeStatePath({ env, home });
    // The conf is read across the layered roots like every other knob (issue #19), so a global
    // `off` binds in a project that never restates it. This is the ONE place `layeredRoots` is
    // still used here: it answers "what did the user configure", not "where does state go".
    const conf = readLayeredConfContents(
      layeredRoots(env, cwd, home).map((r) => r.root),
      env,
    );
    // The knob is checked FIRST: a user who turned this off should not pay for a scan they
    // asked not to have, and "off" is a complete answer on its own.
    if (!resolvePayloadNoticeSettings({ env, confContents: conf }).enabled) {
      return empty("knob-off", statePath);
    }

    const gdirs = resolveGlobalDirs({
      homeDir: home,
      ...(opts.xdgConfigHome !== undefined ? { xdgConfigHome: opts.xdgConfigHome } : {}),
      env,
    });
    const scan = scanInstalledPayload({
      packageRoot,
      targetDir: resolveProjectDir(env, cwd),
      global_dirs: gdirs,
    });
    const version = packageVersion(packageRoot);
    // DRIFT is deliberately NOT announced here. It is already reported by `init` (from the run
    // that skipped the file) and by `doctor`, it needs a human decision rather than a command,
    // and an edited file is a supported state — a start-up line about it would be nagging
    // someone about a choice they made. Skew is the one nobody was ever told about.
    if (scan.skewed.length === 0) return { ...empty("no-skew", statePath), version };

    // The key comes out of the SCAN (the records that judged these files), so what is announced
    // and what counts as already-announced cannot disagree — see the header (L1/L2).
    const key = noticeKeyFor(scan.skewed);
    const state = readNoticeState(statePath);
    // The fingerprint is computed from THIS scan's own skewed entries — no rescan (issue #145).
    const fingerprint = (opts.computeFingerprint ?? payloadFingerprint)(scan.skewed);
    const seenEntry = state.seen[key];
    // Suppression requires BOTH the version and the payload fingerprint to be nameable AND to
    // match the recorded entry. Either half missing — an unreadable version, an uncomputable
    // fingerprint, or a legacy entry recorded before #145 with no fingerprint field at all —
    // means we cannot prove the user was told about exactly this payload, so the safe direction
    // is to tell them again rather than guess a match.
    const canSuppress = version.length > 0 && fingerprint !== null;
    if (canSuppress && seenEntry?.version === version && seenEntry?.fingerprint === fingerprint) {
      return { outcome: "already-shown", skewed: scan.skewed, lines: [], version, statePath, key, fingerprint };
    }

    const lines = formatSkewNote({ skewed: scan.skewed, version, maxFiles: 8, unsolicited: true });
    const write = opts.write ?? ((t: string) => void process.stderr.write(t));
    // ONE write for the whole block: stderr is shared with the serve child's own output, and a
    // per-line loop can be interleaved mid-notice by it.
    write(
      lines.map((l, i) => (i === 0 ? `modelguild: ${l.replace(/^! /, "")}` : l)).join("\n") + "\n",
    );
    // Nothing nameable to key suppression on ⇒ no write is ATTEMPTED (and the notice will repeat
    // next start-up — the honest outcome when either half cannot be identified).
    const attempted = canSuppress;
    // Read-modify-write of a shared map. Two servers starting at once can lose one entry, whose
    // only cost is one extra notice — the safe direction, and cheaper than a lock for a nag.
    const wrote =
      attempted &&
      writeNoticeState(statePath, { seen: { ...state.seen, [key]: { version, fingerprint: fingerprint as string } } });
    return {
      outcome: null,
      skewed: scan.skewed,
      lines,
      version,
      statePath,
      key,
      fingerprint,
      ...(attempted && !wrote ? { stateWriteFailed: true } : {}),
    };
  } catch {
    // Rule 1: a broken check degrades the notice, never the lifecycle.
    return empty("error");
  }
}
