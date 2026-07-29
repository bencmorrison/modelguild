/**
 * Worktree read-root tests (issue #96) — OFFLINE.
 *
 * Two layers, both driven by REAL git (like `test/delegate.test.ts`, which uses real
 * `git init` / `git worktree add` rather than a stub — the whole fence is a `git worktree
 * list` membership test, so faking git would be faking the thing under test):
 *
 *   1. `resolveWorktreeTarget` — the single choke point. Accepts a real sibling worktree,
 *      accepts the main checkout as "the default root", and REFUSES by name a path that is
 *      not in the list, a worktree of a DIFFERENT repository, and a path that does not exist.
 *   2. The read tools — that a validated target actually ROOTS THE CHILD THERE (asserted via
 *      a `ServeRouter` spy that records the root it was asked for), that a refusal is a
 *      structured `worktree-invalid` result which logs nothing, and — the one that would
 *      break this feature silently — that a worktree WITHOUT the hardened agent def refuses
 *      with `agent-def-missing` naming the worktree's own `.opencode/agent`, because opencode
 *      resolves agents from the SERVE's cwd and does not fall back to the main checkout.
 *
 * Plus the pool: `forRoot` returns the primary child for the project root (no second port
 * for a review of the tree you are already in), a distinct child per other root, and it dies
 * with the primary via `OpencodeLifecycle.onShutdown`.
 *
 * No model is called and no `opencode serve` is spawned: the turn is served by the
 * `node:http` fake, and the pool test only inspects lifecycle objects (a lifecycle that is
 * never asked for a serve never spawns anything).
 */

import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { realpathSync } from "node:fs";
import { resolveWorktreeTarget } from "../src/worktree.js";
import { consult, consultToToolResult } from "../src/consult.js";
import { panel } from "../src/panel.js";
import { research } from "../src/research.js";
import { ServePool } from "../src/servepool.js";
import { OpencodeLifecycle, type ServeHandle } from "../src/lifecycle.js";
import { startFakeOpencode, type FakeOpencode } from "./fake-opencode-server.js";
import type { ServeProvider, ServeRouter } from "../src/client.js";
import { Checker } from "./harness.js";

const tmpDirs: string[] = [];
function tmp(prefix = "m96-"): string {
  // realpath: macOS hands back /var/... symlinks for /private/var, and the whole fence is a
  // path-equality check — a test that compared unresolved paths would pass or fail for
  // reasons that have nothing to do with the code.
  const d = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  tmpDirs.push(d);
  return d;
}

function git(dir: string, args: string[]): void {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  if ((r.status ?? 1) !== 0) {
    throw new Error(`git ${args.join(" ")} in ${dir} failed: ${r.stderr || r.stdout}`);
  }
}

/** A committed git repo with the hardened read def in `.opencode/agent/`. */
function initRepo(prefix: string): string {
  const dir = tmp(prefix);
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "t@t"]);
  git(dir, ["config", "user.name", "t"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  mkdirSync(path.join(dir, ".opencode", "agent"), { recursive: true });
  writeFileSync(path.join(dir, ".opencode", "agent", "guild-read.md"), "---\nmode: all\n---\nx\n");
  writeFileSync(path.join(dir, ".opencode", "agent", "guild-research.md"), "---\nmode: all\n---\nx\n");
  writeFileSync(path.join(dir, "README.md"), "hello\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

/** Add a worktree of `repo` at a fresh temp path on a new branch. */
function addWorktree(repo: string, branch: string): string {
  const base = tmp(`m96-wt-${branch}-`);
  const dir = path.join(base, "wt");
  git(repo, ["worktree", "add", "-q", "-b", branch, dir]);
  return realpathSync(dir);
}

function fakeServe(fake: FakeOpencode): ServeProvider {
  const handle: ServeHandle = { baseUrl: fake.baseUrl, port: 0, pid: 0 };
  return { withServe: (fn) => fn(handle) };
}

/** A router that records every root it is asked to serve — the assertion that a validated
 * target actually re-roots the child, rather than merely being accepted. */
function spyRouter(
  projectDir: string,
  provider: ServeProvider,
  seedExtraRoots: string[] = [],
): ServeRouter & { asked: string[] } {
  const asked: string[] = [];
  const extra = new Set(seedExtraRoots);
  return {
    projectDir,
    asked,
    get extraRoots() {
      return [...extra];
    },
    forRoot(root: string) {
      asked.push(root);
      if (root !== projectDir) extra.add(root);
      return provider;
    },
  };
}

/** process.env minus every GUILD_* knob, plus overrides (hermeticity, issue #24). */
function envWith(overrides: Record<string, string>): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(base)) if (k.startsWith("GUILD_")) delete base[k];
  return { ...base, ...overrides };
}

/** A guild root with a permissive policy, so nothing but the worktree logic can refuse. */
function makeGuildRoot(): string {
  const root = tmp("m96-guild-");
  writeFileSync(path.join(root, "models.policy.local"), "# permissive\nallow *\n");
  return root;
}

export async function run(): Promise<number> {
  const c = new Checker();
  console.log("\n== worktree read root (issue #96) ==");

  // -------------------------------------------------------------------------
  // 1. resolveWorktreeTarget — the choke point.
  // -------------------------------------------------------------------------
  const repo = initRepo("m96-repo-");
  const wt = addWorktree(repo, "feature-a");
  const otherRepo = initRepo("m96-other-");
  const otherWt = addWorktree(otherRepo, "feature-b");

  {
    const r = resolveWorktreeTarget(wt, { projectDir: repo });
    c.check(r.ok && r.root === wt, "a sibling worktree of this repository is ACCEPTED");
    c.check(r.ok && r.isDefault === false, "a sibling worktree is not the default root");
  }
  {
    const r = resolveWorktreeTarget(repo, { projectDir: repo });
    c.check(r.ok && r.isDefault === true, "the main checkout is accepted AND flagged default");
  }
  {
    // Enumerating from INSIDE a worktree must see the same set — the coordinator may be
    // running in either tree.
    const r = resolveWorktreeTarget(repo, { projectDir: wt });
    c.check(r.ok && r.root === repo, "from inside a worktree, the main checkout is accepted");
  }
  {
    const stranger = tmp("m96-stranger-");
    const r = resolveWorktreeTarget(stranger, { projectDir: repo });
    c.check(!r.ok, "a directory that is not a worktree of this repository is REFUSED");
    c.check(!r.ok && r.message.includes(stranger), "the refusal NAMES the offending path");
    c.check(
      !r.ok && r.message.includes(repo),
      "the refusal names the repository whose worktrees were checked",
    );
  }
  {
    const r = resolveWorktreeTarget(otherWt, { projectDir: repo });
    c.check(!r.ok, "a worktree of a DIFFERENT repository is REFUSED");
    c.check(
      !r.ok && r.message.includes(otherWt),
      "the different-repo refusal names the path it rejected",
    );
  }
  {
    const missing = path.join(repo, "no-such-dir");
    const r = resolveWorktreeTarget(missing, { projectDir: repo });
    c.check(!r.ok && r.message.includes("does not exist"), "a nonexistent target is refused as such");
  }
  {
    const notGit = tmp("m96-notgit-");
    const r = resolveWorktreeTarget(notGit, { projectDir: notGit });
    c.check(!r.ok, "a project dir that is not a git repository refuses every target");
  }
  {
    const r = resolveWorktreeTarget("   ", { projectDir: repo });
    c.check(!r.ok && r.message.includes("empty"), "an all-whitespace target is refused, not ignored");
  }
  {
    // A relative target is anchored to the REPOSITORY, never to the process cwd.
    const rel = path.relative(repo, wt);
    const r = resolveWorktreeTarget(rel, { projectDir: repo });
    c.check(r.ok && r.root === wt, "a relative target resolves against the repository root");
  }
  {
    // git absent / failing: reported as "cannot enumerate", never silently accepted.
    const r = resolveWorktreeTarget(wt, {
      projectDir: repo,
      git: () => ({ status: 128, stdout: "", stderr: "fatal: not a git repository" }),
    });
    c.check(!r.ok && r.message.includes("could not enumerate"), "a failing git is a refusal, not a pass");
  }

  // -------------------------------------------------------------------------
  // 2. The read tools.
  // -------------------------------------------------------------------------
  const guildRoot = makeGuildRoot();

  {
    // (a) A valid sibling worktree is accepted AND the call is routed to a child rooted THERE.
    const logDir = tmp("m96-logs-");
    const env = envWith({ GUILD_ROOT: guildRoot, GUILD_LOG_DIR: logDir, GUILD_PROJECT_DIR: repo });
    const fake = await startFakeOpencode({ historyText: "reviewed" });
    try {
      const router = spyRouter(repo, fakeServe(fake));
      const r = await consult(
        { question: "review", model: "openai/m", worktree: wt },
        { serve: fakeServe(fake), router, env, cwd: repo },
      );
      c.check(r.ok, "consult: a valid sibling worktree target runs the call");
      c.check(router.asked.length === 1 && router.asked[0] === wt,
        "consult: the serve child is rooted at the WORKTREE (router asked for exactly that root)");
      c.check(r.ok && r.attribution.worktree === wt,
        "consult: the result reports the read root it actually used");
    } finally {
      await fake.close();
    }
  }

  {
    // (b) A path not in `git worktree list` is refused BY NAME, and nothing is logged
    //     (gap parity: a refusal before `expect` writes no run).
    const logDir = tmp("m96-logs-");
    const env = envWith({ GUILD_ROOT: guildRoot, GUILD_LOG_DIR: logDir, GUILD_PROJECT_DIR: repo });
    const fake = await startFakeOpencode({ historyText: "unused" });
    try {
      const stranger = tmp("m96-stranger2-");
      const router = spyRouter(repo, fakeServe(fake));
      const r = await consult(
        { question: "review", model: "openai/m", worktree: stranger },
        { serve: fakeServe(fake), router, env, cwd: repo },
      );
      c.check(!r.ok && r.error.kind === "worktree-invalid", "consult: an off-list path is refused");
      c.check(!r.ok && r.error.message.includes(stranger), "consult: the refusal names the path");
      c.check(router.asked.length === 0, "consult: a refused target NEVER routes a call anywhere");
      const runs = existsSync(logDir) ? readdirSync(logDir).filter((n) => n !== "latest") : [];
      c.check(runs.length === 0, "consult: a worktree refusal writes NO evidence run (gap parity)");
    } finally {
      await fake.close();
    }
  }

  {
    // (c) A worktree of a DIFFERENT repository is refused at the tool boundary too.
    const logDir = tmp("m96-logs-");
    const env = envWith({ GUILD_ROOT: guildRoot, GUILD_LOG_DIR: logDir, GUILD_PROJECT_DIR: repo });
    const fake = await startFakeOpencode({ historyText: "unused" });
    try {
      const router = spyRouter(repo, fakeServe(fake));
      const r = await consult(
        { question: "review", model: "openai/m", worktree: otherWt },
        { serve: fakeServe(fake), router, env, cwd: repo },
      );
      c.check(!r.ok && r.error.kind === "worktree-invalid",
        "consult: a worktree of a DIFFERENT repository is refused");
      c.check(router.asked.length === 0, "consult: the different-repo target routes nothing");
    } finally {
      await fake.close();
    }
  }

  {
    // (d) THE SILENT-BREAK GUARD. opencode resolves agents from the SERVE's cwd and does not
    //     fall back to the repository's main checkout (probed live on 1.18.7), so a worktree
    //     without `.opencode/agent/guild-read.md` must refuse UP FRONT — naming the
    //     worktree's own dir — rather than run and die on an unresolvable agent mid-turn.
    const bare = initRepo("m96-bare-");
    // Remove the def from the worktree only: `git worktree add` checks out the committed
    // payload, so delete it there to model a repo that never committed one.
    const bareWt = addWorktree(bare, "no-def");
    rmSync(path.join(bareWt, ".opencode"), { recursive: true, force: true });
    const logDir = tmp("m96-logs-");
    const env = envWith({
      GUILD_ROOT: guildRoot,
      GUILD_LOG_DIR: logDir,
      GUILD_PROJECT_DIR: bare,
      // No global opencode agent dir either — fail-closed needs BOTH absent.
      XDG_CONFIG_HOME: tmp("m96-xdg-"),
    });
    const fake = await startFakeOpencode({ historyText: "unused" });
    try {
      const router = spyRouter(bare, fakeServe(fake));
      const r = await consult(
        { question: "review", model: "openai/m", worktree: bareWt },
        { serve: fakeServe(fake), router, env, cwd: bare },
      );
      c.check(!r.ok && r.error.kind === "agent-def-missing",
        "consult: a worktree with no hardened def REFUSES (it would 500 on opencode otherwise)");
      c.check(
        !r.ok && r.error.message.includes(path.join(bareWt, ".opencode", "agent")),
        "consult: the def-missing message names the WORKTREE's agent dir, not the project's",
      );
      // And the control: the same call WITHOUT a worktree target still passes the def gate
      // from the project's own copy — the pre-check moved with the child, it did not break.
      const ok = await consult(
        { question: "review", model: "openai/m" },
        { serve: fakeServe(fake), router, env, cwd: bare },
      );
      c.check(ok.ok, "consult: control — no worktree target still resolves the def from the project");
    } finally {
      await fake.close();
    }
  }

  {
    // (e) panel: the target is panel-WIDE and refuses the whole panel before any member runs.
    const logDir = tmp("m96-logs-");
    const env = envWith({ GUILD_ROOT: guildRoot, GUILD_LOG_DIR: logDir, GUILD_PROJECT_DIR: repo });
    const fake = await startFakeOpencode({ historyText: "answer" });
    try {
      const router = spyRouter(repo, fakeServe(fake));
      const good = await panel(
        { question: "q", models: ["openai/a", "google/b"], worktree: wt },
        { serve: fakeServe(fake), router, env, cwd: repo },
      );
      c.check(good.ok, "panel: a valid worktree target runs the panel");
      c.check(good.ok && good.worktree === wt, "panel: the result reports the panel-wide read root");
      c.check(router.asked.length === 1 && router.asked[0] === wt,
        "panel: ONE child for the whole panel, rooted at the worktree");

      const stranger = tmp("m96-stranger3-");
      const bad = await panel(
        { question: "q", models: ["openai/a"], worktree: stranger },
        { serve: fakeServe(fake), router, env, cwd: repo },
      );
      c.check(!bad.ok && bad.error.kind === "worktree-invalid",
        "panel: an off-list target refuses the WHOLE panel");
    } finally {
      await fake.close();
    }
  }

  {
    // (f) research: same fence, same routing.
    const logDir = tmp("m96-logs-");
    const env = envWith({ GUILD_ROOT: guildRoot, GUILD_LOG_DIR: logDir, GUILD_PROJECT_DIR: repo });
    const fake = await startFakeOpencode({ historyText: "sourced" });
    try {
      const router = spyRouter(repo, fakeServe(fake));
      const good = await research(
        { question: "q", model: "openai/m", worktree: wt },
        { serve: fakeServe(fake), router, env, cwd: repo },
      );
      c.check(good.ok && good.attribution.worktree === wt,
        "research: a valid worktree target runs and is reported");
      c.check(router.asked.length === 1 && router.asked[0] === wt,
        "research: the child is rooted at the worktree");

      const bad = await research(
        { question: "q", model: "openai/m", worktree: otherWt },
        { serve: fakeServe(fake), router, env, cwd: repo },
      );
      c.check(!bad.ok && bad.error.kind === "worktree-invalid",
        "research: a worktree of a different repository is refused");
    } finally {
      await fake.close();
    }
  }

  {
    // (g) Targeting the PROJECT root itself costs no second child: the primary provider is
    //     used and the router is never consulted.
    const logDir = tmp("m96-logs-");
    const env = envWith({ GUILD_ROOT: guildRoot, GUILD_LOG_DIR: logDir, GUILD_PROJECT_DIR: repo });
    const fake = await startFakeOpencode({ historyText: "answer" });
    try {
      const router = spyRouter(repo, fakeServe(fake));
      const r = await consult(
        { question: "q", model: "openai/m", worktree: repo },
        { serve: fakeServe(fake), router, env, cwd: repo },
      );
      c.check(r.ok, "consult: targeting the project root itself is accepted");
      c.check(router.asked.length === 0, "consult: the project root spawns NO second serve child");
      c.check(r.ok && r.attribution.worktree === repo, "consult: it still reports the root used");
    } finally {
      await fake.close();
    }
  }

  // -------------------------------------------------------------------------
  // 3. The pool. Nothing here asks for a serve, so no `opencode serve` is spawned.
  // -------------------------------------------------------------------------
  {
    const primary = new OpencodeLifecycle({ projectDir: repo });
    const pool = new ServePool(primary);
    c.check(pool.projectDir === repo, "pool: reports the primary child's root as the default");
    c.check(pool.forRoot(repo) === primary, "pool: the project root maps to the PRIMARY child");
    const a = pool.forRoot(wt);
    const b = pool.forRoot(wt);
    c.check(a !== primary, "pool: another root gets its own supervised child");
    c.check(a === b, "pool: a root's child is reused, not respawned per call");
    c.check(pool.extraRoots.length === 1 && pool.extraRoots[0] === wt, "pool: extra roots are listed");
    // Teardown: the pool dies with the primary child, via onShutdown — the single trigger
    // wiring the orphan proof rests on, not a duplicated copy of it.
    primary.shutdown("test");
    c.check(pool.extraRoots.length === 0, "pool: the primary's shutdown tears down every extra child");
  }
  {
    // The companion hook itself: registered callbacks fire, unregister works, and a THROWING
    // companion never stops the shutdown it is attached to.
    const lc = new OpencodeLifecycle({ projectDir: repo });
    let fired = 0;
    const off = lc.onShutdown(() => {
      fired += 1;
    });
    lc.onShutdown(() => {
      throw new Error("boom");
    });
    lc.shutdown("t1");
    c.check(fired === 1, "lifecycle: an onShutdown companion runs on shutdown");
    off();
    lc.shutdown("t2");
    c.check(fired === 1, "lifecycle: an unregistered companion stops running");
    c.check(true, "lifecycle: a throwing companion does not break shutdown (we got here)");
  }
  {
    // RECLAMATION vs TEARDOWN (review finding H1). The object-level half; the real-process
    // half — an extra child surviving the primary's idle fire mid-call — is in
    // `test/lifecycle.test.ts`, which spawns actual serves.
    const lc = new OpencodeLifecycle({ projectDir: repo });
    let fired = 0;
    lc.onShutdown(() => {
      fired += 1;
    });
    lc.shutdown("idle");
    c.check(fired === 0, "reasons: 'idle' reclaims THIS child and does NOT run companions");
    lc.shutdown("per-call");
    c.check(fired === 0, "reasons: 'per-call' does NOT run companions either");
    lc.shutdown("stdin-end");
    c.check(fired === 1, "reasons: 'stdin-end' IS teardown and runs companions");
    lc.shutdown("transport-close");
    c.check(fired === 2, "reasons: 'transport-close' IS teardown");
    lc.shutdown();
    c.check(fired === 3, "reasons: an ABSENT reason defaults to teardown (never an orphan)");
    lc.shutdown("something-added-later");
    c.check(
      fired === 4,
      "reasons: an UNRECOGNIZED reason defaults to teardown, so a new reason cannot silently join the exempt set",
    );
  }

  // -------------------------------------------------------------------------
  // 4. Continuations: the SESSION's directory is the authority (finding M3).
  // -------------------------------------------------------------------------
  {
    const logDir = tmp("m96-logs-");
    const env = envWith({ GUILD_ROOT: guildRoot, GUILD_LOG_DIR: logDir, GUILD_PROJECT_DIR: repo });
    const fake = await startFakeOpencode({ historyText: "continued" });
    try {
      const router = spyRouter(repo, fakeServe(fake));
      // (a) A continuation with NO worktree INHERITS the session's root — the case that used
      //     to silently answer from the project root while continuing a worktree conversation.
      const inherited = await consult(
        { question: "more", model: "openai/m", sessionId: "ses_wt" },
        {
          serve: fakeServe(fake),
          router,
          env,
          cwd: repo,
          fetchSessionDirectory: async () => wt,
        },
      );
      c.check(inherited.ok, "continuation: a session created in a worktree continues fine");
      c.check(
        inherited.ok && inherited.attribution.worktree === wt,
        "continuation: it INHERITS the session's root without the caller repeating it",
      );
      c.check(
        router.asked.length === 1 && router.asked[0] === wt,
        "continuation: it is routed to the SESSION's child, not the primary",
      );

      // (b) A session created in the PROJECT root continues on the primary — no second child.
      const plain = await consult(
        { question: "more", model: "openai/m", sessionId: "ses_main" },
        {
          serve: fakeServe(fake),
          router,
          env,
          cwd: repo,
          fetchSessionDirectory: async () => repo,
        },
      );
      c.check(plain.ok, "continuation: a project-root session continues on the primary");
      c.check(router.asked.length === 1, "continuation: the project-root session spawns nothing new");

      // (c) An explicit worktree that DISAGREES with the session is an error naming both.
      const conflict = await consult(
        { question: "more", model: "openai/m", sessionId: "ses_wt", worktree: repo },
        {
          serve: fakeServe(fake),
          router,
          env,
          cwd: repo,
          fetchSessionDirectory: async () => wt,
        },
      );
      c.check(
        !conflict.ok && conflict.error.kind === "worktree-invalid",
        "continuation: a worktree that CONFLICTS with the session is refused",
      );
      c.check(
        !conflict.ok && conflict.error.message.includes(wt) && conflict.error.message.includes(repo),
        "continuation: the conflict message names BOTH roots",
      );

      // (d) A matching explicit worktree is fine — repeating yourself is allowed.
      const agree = await consult(
        { question: "more", model: "openai/m", sessionId: "ses_wt", worktree: wt },
        {
          serve: fakeServe(fake),
          router,
          env,
          cwd: repo,
          fetchSessionDirectory: async () => wt,
        },
      );
      c.check(agree.ok, "continuation: repeating the SAME worktree is accepted");

      // (e) A session that cannot be fetched is a REFUSAL — **when the answer could differ**,
      //     i.e. this server has actually routed some other root. That scoping is what stops
      //     `/guild:collaborate` and `/guild:workshop`, which never name a worktree, from
      //     newly depending on `GET /session/{id}` succeeding.
      const ambiguousRouter = spyRouter(repo, fakeServe(fake), [wt]);
      const unfetchable = await consult(
        { question: "more", model: "openai/m", sessionId: "ses_gone" },
        {
          serve: fakeServe(fake),
          router: ambiguousRouter,
          env,
          cwd: repo,
          fetchSessionDirectory: async () => {
            throw new Error("404 not found");
          },
        },
      );
      c.check(
        !unfetchable.ok && unfetchable.error.kind === "worktree-invalid",
        "continuation: an unfetchable session is refused when another root is in play",
      );

      // (e2) ...and the same failure with NO other root in play proceeds on the primary,
      //      exactly as it did before #96 — the plain collaborate/workshop path.
      const plainRouter = spyRouter(repo, fakeServe(fake));
      const degradedOk = await consult(
        { question: "more", model: "openai/m", sessionId: "ses_gone" },
        {
          serve: fakeServe(fake),
          router: plainRouter,
          env,
          cwd: repo,
          fetchSessionDirectory: async () => {
            throw new Error("404 not found");
          },
        },
      );
      c.check(
        degradedOk.ok,
        "continuation: with no other root in play, a failed session lookup does NOT break a plain continuation",
      );
      c.check(
        degradedOk.ok && degradedOk.attribution.worktree === undefined,
        "continuation: that fallback claims no read root (it is the pre-#96 path, not a guess)",
      );
      c.check(plainRouter.asked.length === 0, "continuation: the fallback routes nothing new");

      // (f) A session whose directory is not a worktree of this repository is refused.
      const foreign = await consult(
        { question: "more", model: "openai/m", sessionId: "ses_other" },
        {
          serve: fakeServe(fake),
          router,
          env,
          cwd: repo,
          fetchSessionDirectory: async () => otherWt,
        },
      );
      c.check(
        !foreign.ok && foreign.error.message.includes(otherWt),
        "continuation: a session created outside this repository's worktrees is refused by name",
      );

      // (g) A session reporting NO directory is refused rather than defaulted — again, when
      //     another root is in play.
      const noDir = await consult(
        { question: "more", model: "openai/m", sessionId: "ses_blank" },
        {
          serve: fakeServe(fake),
          router: spyRouter(repo, fakeServe(fake), [wt]),
          env,
          cwd: repo,
          fetchSessionDirectory: async () => undefined,
        },
      );
      c.check(!noDir.ok, "continuation: a session with no reported directory is refused");

      // (h) An explicit `worktree` makes the answer ambiguous ON ITS OWN, even with no extra
      //     root routed yet: the caller named a tree, so a session we cannot check is refused.
      const askedButBlind = await consult(
        { question: "more", model: "openai/m", sessionId: "ses_gone", worktree: wt },
        {
          serve: fakeServe(fake),
          router: spyRouter(repo, fakeServe(fake)),
          env,
          cwd: repo,
          fetchSessionDirectory: async () => {
            throw new Error("404 not found");
          },
        },
      );
      c.check(
        !askedButBlind.ok,
        "continuation: naming a worktree makes an unverifiable session a refusal by itself",
      );
    } finally {
      await fake.close();
    }
  }

  // -------------------------------------------------------------------------
  // 5. The receipts record WHICH TREE (finding M2), and the text channel says so (L7).
  // -------------------------------------------------------------------------
  {
    const logDir = tmp("m96-logs-");
    const env = envWith({ GUILD_ROOT: guildRoot, GUILD_LOG_DIR: logDir, GUILD_PROJECT_DIR: repo });
    const fake = await startFakeOpencode({ historyText: "answer bytes" });
    try {
      const router = spyRouter(repo, fakeServe(fake));
      const targeted = await consult(
        { question: "review", model: "openai/m", worktree: wt },
        { serve: fakeServe(fake), router, env, cwd: repo },
      );
      c.check(targeted.ok, "receipts: the targeted call ran");
      const runs = readdirSync(logDir).filter((n) => n !== "latest");
      c.check(runs.length === 1, "receipts: exactly one run dir");
      const lines = readFileSync(path.join(logDir, runs[0], "calls.jsonl"), "utf8")
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      const started = lines.find((e) => e.type === "call" && e.status === "started");
      c.check(started !== undefined, "receipts: a started entry exists");
      c.check(
        started !== undefined && started.read_root === wt,
        "receipts: the started entry records the READ ROOT the answer describes (M2)",
      );
      c.check(lines.length === 3, "receipts: still exactly three lifecycle entries (C22)");

      // L7: the note rides as a SECOND text block; content[0] stays byte-exact.
      const wire = consultToToolResult(targeted);
      c.check(
        wire.content[0].text === (targeted.ok ? targeted.answer : ""),
        "text: content[0] is still the byte-exact answer (never a prefix)",
      );
      c.check(
        wire.content.length === 2 && wire.content[1].text === `Read root: ${wt}`,
        "text: a Read root note is appended as its own block so a human sees the tree (L7)",
      );
    } finally {
      await fake.close();
    }
  }
  {
    // ...and an untargeted call is byte-identical to before: no note, no log field.
    const logDir = tmp("m96-logs-");
    const env = envWith({ GUILD_ROOT: guildRoot, GUILD_LOG_DIR: logDir, GUILD_PROJECT_DIR: repo });
    const fake = await startFakeOpencode({ historyText: "plain" });
    try {
      const r = await consult(
        { question: "q", model: "openai/m" },
        { serve: fakeServe(fake), env, cwd: repo },
      );
      c.check(r.ok, "control: an untargeted call runs");
      const wire = consultToToolResult(r);
      c.check(wire.content.length === 1, "control: no read-root block on an untargeted call");
      const runs = readdirSync(logDir).filter((n) => n !== "latest");
      const started = readFileSync(path.join(logDir, runs[0], "calls.jsonl"), "utf8")
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        .find((e) => e.type === "call" && e.status === "started");
      c.check(
        started !== undefined && !("read_root" in started),
        "control: the started entry has NO read_root field (shape-identical to pre-#96)",
      );
    } finally {
      await fake.close();
    }
  }

  for (const d of tmpDirs) {
    try {
      if (existsSync(d)) rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }

  console.log(`worktree.test: ${c.passes} passed, ${c.failures} failed`);
  return c.failures;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().then((f) => process.exit(f > 0 ? 1 : 0));
}
