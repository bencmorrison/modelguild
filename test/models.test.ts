/**
 * guild_models test. Offline: a tiny node:http fixture serves a
 * `/config/providers` payload shaped exactly like opencode 1.18.4's, and a stub serve
 * runner points `models()` at it — no opencode, no model call. Also unit-tests the pure
 * `parseProviders`, the error path (serve throws), and the tool-result mapping.
 */

import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { Checker, fakeServeHandle } from "./harness.js";
import { models, modelsToToolResult, parseProviders, type ServeRunner } from "../src/models.js";

// A trimmed but structurally faithful /config/providers body (opencode 1.18.4 shape).
const FIXTURE = {
  providers: [
    {
      id: "openai",
      name: "OpenAI",
      models: {
        "gpt-5.5": { id: "gpt-5.5" },
        "gpt-5.4": { id: "gpt-5.4" },
      },
    },
    {
      id: "opencode",
      name: "opencode",
      models: {
        "big-pickle": { id: "big-pickle" },
        "deepseek-v4-flash-free": { id: "deepseek-v4-flash-free" },
      },
    },
  ],
  default: { openai: "gpt-5.5", opencode: "big-pickle" },
};

function startFixture(body: unknown, opts: { fail?: boolean } = {}): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    if (opts.fail) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "boom" }));
      return;
    }
    if (req.url === "/config/providers") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

function stubServe(baseUrl: string): ServeRunner {
  const handle = fakeServeHandle(baseUrl, process.pid);
  return { withServe: async (fn) => fn(handle) };
}

export async function run(): Promise<number> {
  const c = new Checker();
  console.log("== models.test ==");

  // --- pure parseProviders -------------------------------------------------
  const parsed = parseProviders(FIXTURE);
  c.check(parsed.count === 4, `parseProviders counts 4 models (got ${parsed.count})`);
  c.check(
    JSON.stringify(parsed.models) ===
      JSON.stringify([
        "openai/gpt-5.4",
        "openai/gpt-5.5",
        "opencode/big-pickle",
        "opencode/deepseek-v4-flash-free",
      ]),
    "flat models are provider/model ids, sorted",
  );
  c.check(
    parsed.defaults.openai === "openai/gpt-5.5" && parsed.defaults.opencode === "opencode/big-pickle",
    "per-provider defaults resolved to provider/model specs",
  );
  const openai = parsed.providers.find((p) => p.id === "openai");
  c.check(openai?.name === "OpenAI" && openai?.default === "openai/gpt-5.5", "provider grouping carries name + default");

  // Defensive parse: junk shapes degrade to fewer models, never throw.
  c.check(parseProviders({}).count === 0, "empty object → 0 models (no throw)");
  c.check(parseProviders(null).count === 0, "null → 0 models (no throw)");
  c.check(
    parseProviders({ providers: [{ id: "x", models: { m: {} } }, { models: { skipme: {} } }] }).count === 1,
    "a provider with no id is skipped",
  );

  // --- models() over the http fixture -------------------------------------
  const good = await startFixture(FIXTURE);
  try {
    const r = await models({ serve: stubServe(good.baseUrl) });
    c.check(r.ok === true, "models() ok over a healthy serve");
    c.check(r.count === 4, `models() returns 4 ids (got ${r.count})`);
    c.check(r.models.includes("openai/gpt-5.5"), "models() includes a known id");
    const tr = modelsToToolResult(r);
    c.check(tr.isError !== true, "tool result is not an error on success");
    c.check(
      (tr.structuredContent?.count as number) === 4 && Array.isArray(tr.structuredContent?.models),
      "tool result carries structuredContent.models + count",
    );
    c.check(
      typeof tr.content[0]?.text === "string" && (tr.content[0].text as string).includes("openai/gpt-5.5"),
      "tool text lists ids for the driver",
    );
  } finally {
    await good.close();
  }

  // --- error path ----------------------------------------------------------
  const bad = await startFixture(FIXTURE, { fail: true });
  try {
    const r = await models({ serve: stubServe(bad.baseUrl) });
    c.check(r.ok === false, "models() ok:false on an HTTP failure");
    c.check(r.count === 0 && r.models.length === 0, "failed models() yields no ids");
    const tr = modelsToToolResult(r);
    c.check(tr.isError === true, "tool result is isError on failure");
  } finally {
    await bad.close();
  }

  // Serve that throws (serve won't start) → ok:false, no throw upward.
  const throwing: ServeRunner = { withServe: async () => { throw new Error("no serve"); } };
  const r2 = await models({ serve: throwing });
  c.check(r2.ok === false && /no serve/.test(r2.error?.message ?? ""), "serve failure surfaces as ok:false with the message");

  console.log(`models.test: ${c.passes} passed, ${c.failures} failed`);
  return c.failures;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().then((f) => process.exit(f > 0 ? 1 : 0));
}
