/**
 * MCP client test: drive the server through the real MCP SDK client over
 * stdio — guild_status is listed, its call returns coherent data, and NO `opencode
 * serve` process survives the client's close. Offline (guild_status makes no model
 * call; it only reads /doc, /global/health, /agent).
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Checker, pidAlive, waitFor, tsxBin, serverEntry, repoRoot } from "./harness.js";

const CALL_MS = 40_000;

export async function run(): Promise<number> {
  const c = new Checker();
  console.log("== mcp-client.test ==");

  const transport = new StdioClientTransport({
    command: tsxBin,
    args: [serverEntry],
    cwd: repoRoot,
    env: { ...process.env, GUILD_PROJECT_DIR: repoRoot } as Record<string, string>,
  });
  const client = new Client({ name: "modelguild-m1-test", version: "0.0.0" });

  let servePid: number | undefined;
  try {
    await client.connect(transport);

    const tools = await client.listTools();
    const tool = tools.tools.find((t) => t.name === "guild_status");
    c.check(tool !== undefined, "guild_status is listed");
    c.check(
      tool?.inputSchema?.type === "object",
      "guild_status inputSchema.type is 'object'",
    );

    const result = await client.callTool(
      { name: "guild_status", arguments: {} },
      undefined,
      { timeout: CALL_MS },
    );
    const content = result.content as Array<{ type: string; text?: string }>;
    c.check(Array.isArray(content) && content.length === 1, "call returned one content block");
    c.check(content[0]?.type === "text", "content block is text");

    // `structuredContent` must ACTUALLY be on the wire (issue #94, review finding H1). The tool
    // description promises `structuredContent.payload`; for a while the data existed only inside
    // `content[0].text` as JSON, so a caller following the description read a field that was not
    // there. This is the only test that sees the real MCP wire shape.
    const structured = result.structuredContent as
      | { payload?: { serverVersion?: unknown; skewed?: unknown; drifted?: unknown; unknown?: unknown; noticeStatePath?: unknown } }
      | undefined;
    c.check(structured !== undefined, "guild_status returns structuredContent (not only a JSON text blob)");
    c.check(
      structured?.payload !== undefined,
      "structuredContent.payload is present — the exact field the tool description names",
    );
    c.check(
      typeof structured?.payload?.serverVersion === "string" &&
        Array.isArray(structured.payload.skewed) &&
        Array.isArray(structured.payload.drifted) &&
        Array.isArray(structured.payload.unknown) &&
        typeof structured.payload.noticeStatePath === "string",
      "structuredContent.payload carries the version, the three classified lists, and the notice state path",
    );

    const status = JSON.parse(content[0]?.text ?? "{}") as {
      opencodeVersion?: unknown;
      port?: unknown;
      pid?: unknown;
      agentCount?: unknown;
    };
    c.check(
      typeof status.opencodeVersion === "string" && /^\d+\.\d+/.test(status.opencodeVersion),
      `opencodeVersion looks like a version (${JSON.stringify(status.opencodeVersion)})`,
    );
    c.check(typeof status.port === "number" && status.port > 0, `port is a positive number (${status.port})`);
    c.check(typeof status.pid === "number" && status.pid > 0, `pid is a positive number (${status.pid})`);
    c.check(
      typeof status.agentCount === "number" && status.agentCount > 0,
      `agentCount is positive (${status.agentCount}) — the guild-* defs are present`,
    );
    // The reported serve must actually be the live process.
    if (typeof status.pid === "number") {
      servePid = status.pid;
      c.check(pidAlive(status.pid), "reported serve pid is a live process during the call");
    }

    // An invalid per-call timeoutMs is rejected by the handler (resolveTimeoutArg) BEFORE
    // any model call — a tool INPUT error, isError:true, naming the field. Exercises the
    // server-level branch the offline parse test can't reach (one case: the four tools'
    // branches are the identical delegation). Offline: no opencode turn is attempted.
    const badTimeout = await client.callTool(
      { name: "guild_consult", arguments: { question: "hi", timeoutMs: 0 } },
      undefined,
      { timeout: CALL_MS },
    );
    c.check(badTimeout.isError === true, "guild_consult with timeoutMs:0 → isError");
    const btContent = badTimeout.content as Array<{ type: string; text?: string }>;
    c.check(
      /timeoutMs/.test(btContent[0]?.text ?? ""),
      `invalid-timeout error names the field (${JSON.stringify(btContent[0]?.text)})`,
    );
  } finally {
    await client.close().catch(() => {});
  }

  if (servePid !== undefined) {
    const gone = await waitFor(() => !pidAlive(servePid!), 15_000);
    c.check(gone, `no opencode serve process remains after client close (pid ${servePid})`);
  }

  console.log(`mcp-client.test: ${c.passes} passed, ${c.failures} failed`);
  return c.failures;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().then((f) => process.exit(f > 0 ? 1 : 0));
}
