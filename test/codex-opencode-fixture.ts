/** Executable fake opencode for the opt-in real-Codex client probe. No provider is called. */
import { createServer, request } from "node:http";
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { startFakeOpencode, type FakeOpencodeOpts } from "./fake-opencode-server.js";

const controlPath = process.env.GUILD_CODEX_FIXTURE_CONTROL!;
appendFileSync(controlPath + ".pids", `${process.pid}\n`);
const options: FakeOpencodeOpts = {historyText: "fixture answer", distinctSessions: true, gateTimeoutMs: 20000};
const fake = await startFakeOpencode(options);
fake.setOnMessage(() => {
  appendFileSync(controlPath + ".started", "turn\n");
  const control = JSON.parse(readFileSync(controlPath, "utf8"));
  options.historyText = control.answer ?? "fixture answer";
  options.messageDelayMs = control.delay ?? 0;
  options.gateTool = control.gate ? "webfetch" : undefined;
  options.gateMetadata = {url: "https://example.invalid/fixture"};
  if (control.edit) writeFileSync("codex-worker-result.txt", "written by the backend fixture\n");
});
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
const proxy = createServer((req, res) => {
  if (req.url === "/doc") {res.writeHead(200, {"content-type":"application/json"});res.end('{}');return;}
  const upstream = request(new URL(req.url!, fake.baseUrl), {method:req.method, headers:req.headers}, (reply) => {
    res.writeHead(reply.statusCode!, reply.headers); reply.pipe(res);
  });
  upstream.on("error", () => {res.writeHead(502);res.end();});
  req.pipe(upstream);
});
proxy.listen(port, "127.0.0.1");
