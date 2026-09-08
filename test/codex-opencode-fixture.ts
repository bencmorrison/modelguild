/** Executable fake opencode for the opt-in real-Codex client probe. No provider is called. */
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { startFakeOpencode, type FakeOpencodeOpts } from "./fake-opencode-server.js";

const controlPath = process.env.GUILD_CODEX_FIXTURE_CONTROL!;
appendFileSync(controlPath + ".pids", `${process.pid}\n`);
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
const options: FakeOpencodeOpts = {historyText: "fixture answer", distinctSessions: true, gateTimeoutMs: 20000, port};
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
// Bind the fixture directly: request targets never become outbound URLs.
console.log(fake.baseUrl);
