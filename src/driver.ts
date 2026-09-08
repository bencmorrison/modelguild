/** Codex frontend configuration. Auth and model execution remain opencode-side (#226). */
import { spawnSync } from "node:child_process";
import { type Driver, type ServerLaunch, type GlobalDirs, locatePayload, COMMAND_DOCS } from "./init.js";

export const CODEX_TOOL_TIMEOUT_SEC = 2100;
export const CODEX_STARTUP_TIMEOUT_SEC = 60;

/** Inventory available workflows, including tracked/manual copies, not the user's preferred
 * client. Keep scanning both for payload notices; doctor accepts an explicit --driver and
 * treats an absent client CLI as an inconclusive registration check. */
export function installedDriver(targetDir: string, global_dirs: GlobalDirs, globalOnly = false): Driver {
  const opts = { targetDir, global_dirs, globalOnly };
  const codex = COMMAND_DOCS.some(c => locatePayload(`.agents/skills/guild-${c}/SKILL.md`, opts) !== "none");
  const claude = COMMAND_DOCS.some(c => locatePayload(`.claude/commands/guild/${c}.md`, opts) !== "none");
  return codex ? (claude ? "both" : "codex") : "claude";
}

/** JSON string encoding is also valid for these TOML basic strings; never shell-interpolate it. */
export function codexConfig(targetDir: string, launch: ServerLaunch, global = false): string {
  const lines = [
    "[mcp_servers.modelguild]",
    `command = ${JSON.stringify(launch.command)}`,
    `args = ${JSON.stringify(launch.args)}`,
    `startup_timeout_sec = ${CODEX_STARTUP_TIMEOUT_SEC}`,
    `tool_timeout_sec = ${CODEX_TOOL_TIMEOUT_SEC}`,
  ];
  if (!global) lines.push(`cwd = ${JSON.stringify(targetDir)}`);
  const env = { ...launch.env, ...(!global ? { GUILD_PROJECT_DIR: targetDir } : {}) };
  if (Object.keys(env).length) {
    lines.push("", "[mcp_servers.modelguild.env]");
    for (const [key, value] of Object.entries(env)) lines.push(`${JSON.stringify(key)} = ${JSON.stringify(value)}`);
  }
  return lines.join("\n");
}

/** A null verdict means Codex is absent, so registration could not be checked. */
export function codexRegistration(targetDir: string): { ok: boolean | null; unregistered?: boolean; messages: string[] } {
  const res = spawnSync("codex", ["mcp", "get", "modelguild", "--json"], {
    cwd: targetDir, encoding: "utf8", timeout: 15_000,
  });
  if ((res.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
    return { ok: null, messages: ["Cannot inspect Codex MCP registration: codex is not on PATH. Available workflow files do not establish which client you use; check with `codex mcp get modelguild --json` in your Codex environment, or select `--driver claude`."] };
  }
  if (res.error) return { ok: false, messages: ["Cannot inspect Codex MCP registration: check that codex is installed and answering `codex mcp get modelguild --json`."] };
  // Only the CLI's observed no-entry response is an optional registration miss.
  // A config-parse error or another failed command must not disappear behind a working client.
  const noEntry = `${res.stdout ?? ""}\n${res.stderr ?? ""}`.includes("No MCP server named 'modelguild' found");
  if (res.status !== 0) return { ok: false, unregistered: noEntry, messages: ["Codex MCP server 'modelguild' is not available; check that the init-generated table is in .codex/config.toml or $CODEX_HOME/config.toml (default ~/.codex/config.toml). If the project table is already present, check project trust: Codex ignores project configuration in untrusted projects."] };
  try {
    const config = JSON.parse(res.stdout);
    if (config.enabled === false || !config.transport) return { ok: false, messages: ["Codex MCP server 'modelguild' is disabled or has no transport."] };
    const messages = ["Codex MCP server 'modelguild' registered (codex mcp get --json)."];
    // Codex MCP docs: https://learn.chatgpt.com/docs/extend/mcp?surface=cli
    // Documented tool_timeout_sec default: 60 seconds (verified 2026-09-08).
    const timeout = config.tool_timeout_sec ?? 60;
    if (timeout < CODEX_TOOL_TIMEOUT_SEC) messages.push(`! Codex tool timeout is ${timeout}s; use tool_timeout_sec = ${CODEX_TOOL_TIMEOUT_SEC} for default ModelGuild turns and panel retries, or longer for custom deadlines.`);
    if (config.transport.type === "stdio" && config.transport.cwd && config.transport.cwd !== targetDir) {
      messages.push(`! Codex starts ModelGuild in ${config.transport.cwd}; this doctor checked ${targetDir}. Check the configured project root.`);
    }
    return { ok: true, messages };
  } catch {
    return { ok: false, messages: ["Codex returned an unrecognized MCP configuration; inspect `codex mcp get modelguild --json`."] };
  }
}
