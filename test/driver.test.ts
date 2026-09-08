import { mkdtempSync, realpathSync, readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Checker, repoRoot } from "./harness.js";
import { init, payloadFiles, resolveGlobalDirs, payloadDest, scanInstalledPayload } from "../src/init.js";
import { codexConfig, installedDriver, codexRegistration } from "../src/driver.js";
import { formatSkewNote } from "../src/notice.js";
import { runDoctor } from "../src/cli.js";

export async function run(): Promise<number> {
  const c = new Checker();
  const temp = realpathSync(mkdtempSync(path.join(tmpdir(), "guild-driver-")));
  const launch = { command: "node", args: ["/path with spaces/cli.js", "serve"] };
  const install = (targetDir: string, driver: "claude" | "codex" | "both", uninstall = false) =>
    init({ targetDir, packageRoot: repoRoot, serverLaunch: launch, driver, uninstall });
  try {
    // Add a driver, upgrade it, then remove either side without losing shared assets or
    // ownership. Run both orders: the original Claude install must not be privileged.
    for (const first of ["claude", "codex"] as const) {
      const second = first === "claude" ? "codex" : "claude";
      const project = path.join(temp, first); mkdirSync(project);
      c.check(install(project, first).blocked.length === 0, `${first} fresh install`);
      const firstExclusive = first === "claude" ? ".claude/commands/guild/consult.md" : ".agents/skills/guild-consult/SKILL.md";
      const secondExclusive = second === "claude" ? ".claude/commands/guild/consult.md" : ".agents/skills/guild-consult/SKILL.md";
      c.check(!existsSync(path.join(project, secondExclusive)), "single driver installs no other frontend");
      install(project, second);
      install(project, first);
      const record = JSON.parse(readFileSync(path.join(project, "modelguild/.modelguild-install.json"), "utf8"));
      c.check(Boolean(record.files[firstExclusive] && record.files[secondExclusive]), "adding/upgrading preserves both ownership hashes");
      const edited = path.join(project, secondExclusive);
      writeFileSync(edited, readFileSync(edited, "utf8") + "\nUser customization\n");
      install(project, second);
      c.check(readFileSync(edited, "utf8").includes("User customization"), "upgrade preserves user-edited workflow");
      const g = resolveGlobalDirs({homeDir: path.join(temp, "home"), env: {}});
      c.check(installedDriver(project, g) === "both", "doctor detects a combined installation");
      install(project, first, true);
      c.check(!existsSync(path.join(project, firstExclusive)), "selected frontend removed");
      c.check(existsSync(edited) && existsSync(path.join(project, ".opencode/agent/guild-read.md")), "other frontend and shared backend survive");
      c.check(existsSync(path.join(project, "modelguild/.modelguild-install.json")), "shared ownership survives selective uninstall");
      c.check(readFileSync(path.join(project, ".gitignore"), "utf8").includes("modelguild"), "shared ignore rules survive");
      install(project, second, true);
      c.check(existsSync(edited), "uninstall keeps customized workflow");
      c.check(!existsSync(path.join(project, ".opencode/agent/guild-read.md")), "last frontend removal removes owned shared assets");
    }

    const home = path.join(temp, "global"); mkdirSync(home);
    const g = resolveGlobalDirs({homeDir: home, env: {}});
    const opts = {targetDir: temp, packageRoot: repoRoot, serverLaunch: launch, driver: "codex" as const, global: true, homeDir: home, xdgConfigHome: g.xdgConfigHome};
    init(opts);
    c.check(existsSync(path.join(home, ".agents/skills/guild-consult/SKILL.md")), "global skills are discoverable under ~/.agents/skills");
    c.check(!existsSync(path.join(home, ".claude/commands")), "Codex-only global install needs no Claude commands");
    c.check(existsSync(path.join(home, ".claude/modelguild/models.policy")), "drivers share the legacy config baseline");
    // Every shipped skill's relative shared reference resolves in either installation mode.
    for (const entry of payloadFiles("codex").filter(e => e.dest.endsWith("SKILL.md"))) {
      const loc = payloadDest(entry.dest, {global: true, targetDir: temp, global_dirs: g});
      const skillPath = path.join(loc.base, loc.rel);
      const skill = readFileSync(skillPath, "utf8");
      c.check(/^---\nname: guild-[a-z]+\ndescription: .+\n---/m.test(skill), "skill has discoverable metadata");
      const ref = /\]\(([^)]+)\)/.exec(skill)?.[1];
      c.check(Boolean(ref && existsSync(path.resolve(path.dirname(skillPath), ref))), "installed skill's shared reference resolves");
    }
    // All client payloads participate in the same skew scan.
    const common = path.join(home, ".agents/skills/modelguild-common.md");
    writeFileSync(common, readFileSync(common, "utf8") + "\nEdit\n");
    c.check(scanInstalledPayload({targetDir: temp, global_dirs: g, packageRoot: repoRoot}).unknown.length === 0, "Codex files have recognized ownership in scans");
    init({...opts, uninstall: true});
    c.check(existsSync(common), "global uninstall preserves edited shared skill guidance");

    const rejected = path.join(temp, "invalid");
    for (const options of [{driver: "invalid" as any}, {driver: "codex" as const, writeMcp: true}]) {
      let threw = false;
      try { init({targetDir: rejected, packageRoot: repoRoot, serverLaunch: launch, ...options}); } catch {threw = true;}
      c.check(threw && !existsSync(rejected), "invalid driver/registration combination refuses before writing");
    }
    const note = formatSkewNote({skewed: [], version: "0.7.2", driver: "codex"}).join("\n");
    c.check(note.includes("modelguild@0.7.2 init --driver codex"), "skew remedy upgrades the selected Codex payload");

    const config = codexConfig('/tmp/project "quoted"', launch);
    c.check(config.includes('tool_timeout_sec = 2100') && config.includes('GUILD_PROJECT_DIR'), "project registration includes complete-call timeout and root");
    c.check(!codexConfig(temp, launch, true).includes('cwd ='), "global registration does not pin every call to installation cwd");
    c.check(!codexConfig(temp, launch, true).includes('GUILD_PROJECT_DIR'), "global registration does not pin project env");

    // Real CLI subprocess boundary, fake binaries: diagnose Codex independently of a
    // failing Claude registration, and reject disabled or malformed Codex registration.
    const bin = path.join(temp, "bin"); mkdirSync(bin);
    writeFileSync(path.join(bin, "claude"), '#!/bin/sh\nexit 1\n', {mode: 0o755});
    writeFileSync(path.join(bin, "opencode"), '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.18.11; else echo "1 credentials"; fi\n', {mode: 0o755});
    const codexStub = (body: string) => writeFileSync(path.join(bin, "codex"), '#!/bin/sh\ncat <<\'JSON\'\n' + body + '\nJSON\n', {mode: 0o755});
    const oldPath = process.env.PATH;
    const oldRoot = process.env.GUILD_ROOT;
    const project = path.join(temp, "doctor"); mkdirSync(project); install(project, "codex");
    process.env.PATH = bin + path.delimiter + "/usr/bin:/bin";
    process.env.GUILD_ROOT = path.join(project, "modelguild");
    try {
      codexStub(JSON.stringify({enabled: true, transport: {type: "stdio", command: "node"}, tool_timeout_sec: 2100}));
      c.check(await runDoctor(["--dir", project], {homeDir: home, xdgConfigHome: g.xdgConfigHome}) === 0, "Codex-only doctor succeeds even when Claude is installed but unregistered");
      init({...opts, uninstall: false});
      rmSync(path.join(project, ".agents/skills/guild-review/SKILL.md"));
      rmSync(path.join(home, ".agents/skills/modelguild-common.md"));
      c.check(await runDoctor(["--dir", project, "--driver", "codex"], {homeDir: home, xdgConfigHome: g.xdgConfigHome}) === 1,
        "a project common file cannot mask a broken global skill reference");

      codexStub(JSON.stringify({enabled: false, transport: {type: "stdio"}}));
      c.check(!codexRegistration(project).ok, "disabled registration is not healthy");
      codexStub("not json");
      c.check(!codexRegistration(project).ok, "malformed registration is not healthy");
      codexStub(JSON.stringify({enabled: true, transport: {type: "stdio"}}));
      c.check(codexRegistration(project).messages.some(m => m.includes("60s")), "missing timeout surfaces Codex's shorter default");
    } finally {
      if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
      if (oldRoot === undefined) delete process.env.GUILD_ROOT; else process.env.GUILD_ROOT = oldRoot;
    }
  } finally { rmSync(temp, {recursive: true, force: true}); }
  console.log(`driver.test: ${c.passes} passed, ${c.failures} failed`);
  return c.failures;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().then((failures) => process.exit(failures > 0 ? 1 : 0));
}
