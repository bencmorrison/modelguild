/** Real Codex reasoning → ModelGuild MCP → real opencode providers (#226).
 * Opt-in, outside npm test/CI; requires explicit worker IDs and existing CLI logins.
 * Artifacts are retained for receipt/diff review. Assertions read MCP events, evidence
 * and files, never the driver's PASS/FAIL prose. This proves the core CLI route, not
 * all eight workflows or IDE/approval rendering; that matrix is tracked in issue #226.
 * The 15-minute outer deadline includes Codex reasoning and can interrupt a worker
 * still within its own 180-second budget; timing out does not prove a worker hung.
 */
import assert from "node:assert/strict";
import {spawn, spawnSync, execFileSync} from "node:child_process";
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, createWriteStream} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {finished} from "node:stream/promises";
import {init} from "../src/init.js";
import {EvidenceLog} from "../src/log.js";
import {fixtureGitEnv, repoRoot} from "./harness.js";

interface Manifest { model: string; panelModel: string; marker: string }
const jsonLines = (file: string): any[] => readFileSync(file,"utf8").trim().split("\n").filter(Boolean).map(l=>JSON.parse(l));

function verify(root: string): void {
  const {model,panelModel,marker}: Manifest = JSON.parse(readFileSync(path.join(root,"manifest.json"),"utf8"));
  const project=path.join(root,"project"), sibling=path.join(root,"sibling");
  const events=jsonLines(path.join(root,"core.jsonl"));
  assert(events.some(e=>e.type==="turn.completed"),"Codex turn must complete");
  assert(!events.some(e=>e.type==="turn.failed" || e.type==="error"),"Codex must not report a failed turn");
  const calls=events.filter(e=>e.type==="item.completed" && e.item?.type==="mcp_tool_call" &&
    ["guild_consult","guild_panel","guild_delegate"].includes(e.item.tool)).map(e=>e.item);
  assert.deepEqual(calls.map(c=>c.tool),["guild_consult","guild_consult","guild_panel","guild_delegate"],"exactly four core calls, no retries");
  for (const call of calls) {
    assert.equal(call.server,"modelguild");
    assert.equal(call.status,"completed");
    assert(!call.error && !call.result?.is_error,"MCP call must succeed");
    assert(call.result?.structured_content,"structured result must survive Codex");
  }
  const [first,next,panel,edit]=calls.map(c=>c.result.structured_content);
  const log=new EvidenceLog({cwd:project,env:{}});
  const receipt=(runId: string, callId: string, expectedModel: string, answer: string, agent: string) => {
    assert(runId && callId,"receipt identifiers must exist");
    assert.equal(log.verify(runId).code,0,`evidence chain verifies: ${runId}`);
    const rows=jsonLines(path.join(project,"modelguild/logs",runId,"calls.jsonl"));
    const completed=rows.filter(r=>r.call_id===callId && r.status==="completed");
    assert.equal(completed.length,1,"one completed receipt per call");
    assert.equal(completed[0].model,expectedModel);
    assert.equal(completed[0].agent,agent);
    assert.equal(completed[0].exit_code,0);
    assert.equal(completed[0].raw_response,answer,"receipt preserves returned answer bytes");
    return {started:rows.find(r=>r.call_id===callId && r.status==="started"),completed:completed[0]};
  };
  const consultReceipts=[first,next].map(r=>{
    assert.equal(r.model,model);assert.equal(r.requestedModel,model);
    assert(r.answer.includes(marker),"consult must return the planted marker");
    return receipt(r.runId,r.callId,model,r.answer,"guild-read");
  });
  assert(first.activity.toolCalls>0,"initial worker must use a tool");
  assert(first.sessionId,"initial session must be retained");
  assert.equal(calls[1].arguments.sessionId,first.sessionId);
  assert.equal(next.sessionId,first.sessionId);
  assert.equal(consultReceipts[1].completed.session_id,first.sessionId,"completed receipt must identify the continued session");
  assert(consultReceipts[1].completed.turn>1,"completed receipt must record a later turn");
  assert.deepEqual(panel.results.map((r:any)=>r.model).sort(),[model,panelModel].sort());
  for (const r of panel.results) {
    assert(!r.error,"each panel member must answer successfully");
    assert(r.text.includes(marker));assert(r.activity.toolCalls>0,"panel worker must use a tool");
    receipt(panel.runId,r.callId,r.model,r.text,"guild-read");
  }
  assert.equal(edit.model,model);assert.equal(edit.requestedModel,model);
  assert.equal(edit.worktree,sibling);
  assert.equal(receipt(edit.runId,edit.callId,model,edit.report,"guild-build").started.write_root,sibling);
  assert.equal(edit.capture.captureComplete,true);assert.equal(edit.capture.recordFailed,false);
  assert.equal(edit.capture.filesChanged,1);
  assert.equal(readFileSync(path.join(sibling,"worker-result.txt"),"utf8"),marker+"\n");
  assert(!existsSync(path.join(project,"worker-result.txt")),"primary tree must not receive the edit");
  const patch=readFileSync(edit.capture.patchPath,"utf8");
  assert(patch.includes("diff --git a/worker-result.txt b/worker-result.txt\n"));
  assert(patch.includes("\n+"+marker+"\n"),"captured patch must contain the actual write");
  if (edit.capture.scaffoldWarning) console.log("Capture caveat:",edit.capture.scaffoldWarning);
  console.log("PASS: real Codex consult, continuation, panel and sibling-worktree delegation; receipts and patch verified.");
}

async function run(): Promise<string> {
  const model=process.env.GUILD_LIVE_MODEL, panelModel=process.env.GUILD_LIVE_PANEL_MODEL;
  assert(model && panelModel && model!==panelModel,
    "Set GUILD_LIVE_MODEL and a distinct GUILD_LIVE_PANEL_MODEL to exact, available provider/model IDs. This test calls real models.");
  const version=(binary:string)=>{
    const result=spawnSync(binary,["--version"],{encoding:"utf8",timeout:10_000});
    assert(!result.error && result.status===0,
      `Cannot run ${binary} --version (${result.error?.message ?? `exit ${result.status}`}); ensure ${binary} is installed and executable on PATH.`);
    return result.stdout.trim();
  };
  const versions={codex:version("codex"),opencode:version("opencode")};
  const root=realpathSync(mkdtempSync(path.join(tmpdir(),"guild-codex-driver-")));
  console.log("Live test artifacts (retained):",root);
  const project=path.join(root,"project"), sibling=path.join(root,"sibling"), marker="GUILD226_BLUE";
  writeFileSync(path.join(root,"manifest.json"),JSON.stringify({model,panelModel,marker,versions}));
  mkdirSync(project);
  const git=(...args:string[])=>execFileSync("git",["-C",project,...args],{env:fixtureGitEnv(),stdio:"pipe"});
  git("init");
  const cli=path.join(repoRoot,"dist/cli.js");
  init({targetDir:project,packageRoot:repoRoot,driver:"codex",serverLaunch:{command:process.execPath,args:[cli,"serve"]}});
  writeFileSync(path.join(project,"note.txt"),`The project token is ${marker}.\n`);
  git("add",".");git("commit","-m","Synthetic driver fixture");git("worktree","add","-b","worker-target",sibling);
  const config='mcp_servers.modelguild={command='+JSON.stringify(process.execPath)+',args='+JSON.stringify([cli,"serve"])+',cwd='+JSON.stringify(project)+',startup_timeout_sec=60,tool_timeout_sec=2100,env={GUILD_PROJECT_DIR='+JSON.stringify(project)+',GUILD_ROOT='+JSON.stringify(path.join(project,"modelguild"))+',GUILD_PAYLOAD_NOTICE="off",GUILD_MESSAGE_TIMEOUT_MS="180000",GUILD_PANEL_RETRY_EMPTY="0"}}';
  writeFileSync(path.join(root,"config-argument.txt"),config);
  const prompt=`Validate the installed ModelGuild Codex driver skills in this disposable repository. Use the actual installed skills and ModelGuild MCP tools. The user authorized live model calls and synthetic files. Explicit model choices: ${model} and ${panelModel}. Keep answers short. Do not substitute models, retry failed turns, make commits, or edit implementation files. If a local shell sandbox cannot mount, request normal approved escalation for required reads; do not disable the sandbox.
Perform these steps in order:
1. Use $guild-consult with ${model} and keepSession:true to ask the worker to read note.txt and return its token.
2. Continue the SAME sessionId and model with guild_consult; ask it to repeat the token from conversation context without reading files again. Retain its sessionId in the result.
3. Use $guild-panel with ${model} and ${panelModel} to read note.txt and report its token. Inspect both outcomes independently.
4. Use $guild-delegate with ${model} and worktree ${sibling}: create worker-result.txt containing exactly ${marker} and a newline. The primary tree must not receive that edit. Review the actual files and captured patch.
Report outcomes, identities, receipt IDs, write root and capture caveats. A refusal is a failure to report, never invent success. Stop after these four steps.`;
  writeFileSync(path.join(root,"core-prompt.txt"),prompt);
  // Keep provider/Codex login environment, but isolate ModelGuild test configuration.
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith("GUILD_")));
  const child=spawn("codex",["exec","--ignore-user-config","--ephemeral","--approve-for-me","--json","-C",project,"-c",config,"--output-last-message",path.join(root,"core-result.md"),"-"],{env,stdio:"pipe"});
  const out=createWriteStream(path.join(root,"core.jsonl")), err=createWriteStream(path.join(root,"core.stderr"));
  child.stdout.pipe(out);child.stderr.pipe(err);child.stdin.on("error",()=>{});child.stdin.end(prompt);
  let timedOut=false;
  const timer=setTimeout(()=>{timedOut=true;child.kill("SIGTERM");},15*60_000);
  // TERM closes the MCP transport; this is not a tool-cancellation proof (#232).
  const kill=setTimeout(()=>child.kill("SIGKILL"),15*60_000+10_000);
  try {
    const code=await new Promise<number|null>((resolve,reject)=>{child.once("error",reject);child.once("close",resolve);});
    await Promise.all([finished(out),finished(err)]);
    assert(!timedOut,"live driver test exceeded 15 minutes; inspect retained receipts and files");
    assert.equal(code,0,"Codex exited unsuccessfully; inspect core.stderr/core.jsonl");
  } finally {clearTimeout(timer);clearTimeout(kill);}
  return root;
}

try {
  const args=process.argv.slice(2);
  assert(args.length===0 || (args.length===2 && args[0]==="--verify"),"Usage: tsx test/codex-driver.live.ts [--verify artifact-directory]");
  verify(args.length ? path.resolve(args[1]) : await run());
} catch (error) {console.error(error);process.exitCode=1;}
