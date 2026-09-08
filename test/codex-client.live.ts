/** Real Codex App Server + real ModelGuild + scripted opencode. No model/provider calls.
 * Opt-in: npm run test:codex (requires Codex on PATH and a built dist/).
 * Exercises the actual MCP client, not Codex model reasoning or IDE button rendering.
 */
import {spawn, execFileSync, type ChildProcessWithoutNullStreams} from "node:child_process";
import {createInterface} from "node:readline";
import {mkdtempSync, realpathSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync} from "node:fs";
import path from "node:path";
import {tmpdir} from "node:os";
import {Checker, repoRoot, fixtureGitEnv} from "./harness.js";
import {init} from "../src/init.js";
import {runWatch} from "../src/cli.js";

class CodexClient {
  child: ChildProcessWithoutNullStreams;
  pending = new Map<number, {resolve: (v: any) => void; reject: (e: Error) => void}>();
  sequence = 0;
  action = "accept";
  elicitations = 0;
  notifications: any[] = [];
  constructor(cwd: string, home: string, config: string) {
    this.child = spawn("codex", ["-c", config, "app-server"], {cwd, env:{...process.env,CODEX_HOME:home}, stdio:"pipe"});
    this.child.stderr.resume();
    const lines = createInterface({input:this.child.stdout});
    lines.on("line", (line) => {
      let m; try {m=JSON.parse(line);} catch {return;}
      if (m.method === "mcpServer/elicitation/request") {
        this.elicitations++;
        this.child.stdin.write(JSON.stringify({id:m.id,result:{action:this.action,content:null,_meta:null}})+"\n");
      } else if (this.pending.has(m.id)) {
        const p=this.pending.get(m.id)!;this.pending.delete(m.id);
        m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
      } else this.notifications.push(m);
    });
    this.child.on("error", (e) => {
      for (const p of this.pending.values()) p.reject(e);
      this.pending.clear();
    });
    this.child.on("exit", () => {
      lines.close();
      for (const p of this.pending.values()) p.reject(new Error("Codex exited"));
      this.pending.clear();
    });
  }
  request(method: string, params: any = {}, timeout = 90000): Promise<any> {
    return new Promise((resolve,reject) => {
      const id=++this.sequence;
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`${method} timed out`));},timeout);
      this.pending.set(id,{resolve:v=>{clearTimeout(timer);resolve(v);},reject:e=>{clearTimeout(timer);reject(e);}});
      this.child.stdin.write(JSON.stringify({id,method,params})+"\n");
    });
  }
  async close() {
    if (this.child.exitCode !== null || !this.child.pid) return;
    const exit = new Promise<void>(r=>this.child.once("exit",()=>r()));
    this.child.stdin.end();
    const kill=setTimeout(()=>this.child.kill("SIGTERM"),5000);
    await exit; clearTimeout(kill);
  }
}

const c=new Checker();
const root=realpathSync(mkdtempSync(path.join(tmpdir(),"guild-codex-client-")));
const project=path.join(root,"project"), sibling=path.join(root,"sibling"), bin=path.join(root,"bin"), home=path.join(root,"home");
for (const dir of [project,bin,home]) mkdirSync(dir);
const control=path.join(root,"control.json");
const setControl=(v:unknown)=>writeFileSync(control,JSON.stringify(v));
setControl({});
const shq=(s:string)=>"'"+s.replace(/'/g,"'\\''")+"'";
writeFileSync(path.join(bin,"opencode"),`#!/bin/sh\nexec ${shq(process.execPath)} --import ${shq(path.join(repoRoot,"node_modules/tsx/dist/loader.mjs"))} ${shq(path.join(repoRoot,"test/codex-opencode-fixture.ts"))} "$@"\n`,{mode:0o755});
const git=(...args:string[])=>execFileSync("git",["-C",project,...args],{env:fixtureGitEnv(),stdio:"pipe"});
git("init");
const install=(targetDir:string)=>init({targetDir,packageRoot:repoRoot,driver:"codex",serverLaunch:{command:"node",args:[path.join(repoRoot,"dist/cli.js"),"serve"]}});
install(project);
writeFileSync(path.join(project,"baseline.txt"),"baseline\n");
git("add",".");git("commit","-m","fixture");git("worktree","add","-b","sibling",sibling);
// Install metadata is ignored; the tracked agents/skills are present in the sibling.
const config='mcp_servers.modelguild = {command='+JSON.stringify(process.execPath)+',args='+JSON.stringify([path.join(repoRoot,"dist/cli.js"),"serve"])+',cwd='+JSON.stringify(project)+',startup_timeout_sec=60,tool_timeout_sec=2100,env={PATH='+JSON.stringify(bin+path.delimiter+process.env.PATH)+',GUILD_CODEX_FIXTURE_CONTROL='+JSON.stringify(control)+',GUILD_PROJECT_DIR='+JSON.stringify(project)+',GUILD_ROOT='+JSON.stringify(path.join(project,"modelguild"))+',GUILD_APPROVE_EGRESS="ask",GUILD_APPROVE_TIMEOUT_MS="15000",GUILD_PAYLOAD_NOTICE="off"}}';
const client=new CodexClient(project,home,config);
let backendPid:number|undefined;
try {
  await client.request("initialize",{clientInfo:{name:"modelguild_compatibility",version:"1.0"},capabilities:{experimentalApi:true}});
  client.child.stdin.write(JSON.stringify({method:"initialized"})+"\n");
  const skills=await client.request("skills/list",{cwds:[project],forceReload:true});
  c.check(skills.data[0].skills.filter((s:any)=>s.name.startsWith("guild-")).length===8,"Codex discovers all eight installed skills");
  c.check(skills.data[0].errors.length===0,"Codex reports no skill load errors");
  const thread=await client.request("thread/start",{cwd:project,ephemeral:true});
  const threadId=thread.thread.id;
  const tool=async(name:string,args:unknown={})=>client.request("mcpServer/tool/call",{threadId,server:"modelguild",tool:name,arguments:args,_meta:{progressToken:"compatibility"}});
  const servers=await client.request("mcpServerStatus/list",{threadId});
  c.check(Object.keys(servers.data.find((s:any)=>s.name==="modelguild").tools).length===6,"Codex discovers six ModelGuild tools");
  const wrong=await tool("guild_consult",{question:"unused",timeoutMs:0});
  c.check(wrong.isError===true,"structured tool errors survive Codex");
  setControl({answer:"FIRST"});
  const first=await tool("guild_consult",{question:"first",model:"openai/test",keepSession:true});
  c.check(first.structuredContent?.answer==="FIRST","consult returns authoritative fixture answer through Codex");
  setControl({answer:"SECOND"});
  const second=await tool("guild_consult",{question:"next",model:"openai/test",sessionId:first.structuredContent?.sessionId,keepSession:true});
  c.check(second.structuredContent?.answer==="SECOND","continuation returns its own answer");
  setControl({answer:"PANEL"});
  const panel=await tool("guild_panel",{question:"panel",models:["openai/test","google/test"]});
  c.check(panel.structuredContent?.results?.length===2,"two panel results survive Codex");
  for (const action of ["accept","decline","cancel"]) {
    client.action=action;setControl({gate:true,answer:"gated"});
    const before=client.elicitations;
    const gated=await tool("guild_consult",{question:"gated",model:"openai/test"});
    c.check(client.elicitations===before+1,`Codex relays ${action} elicitation`);
    const approval=gated.structuredContent?.approval;
    c.check(action==="accept" ? approval?.approved===1 : approval?.rejected===1,`${action} settles the backend gate correctly`);
  }
  client.action="cancel";
  setControl({gate:true,answer:"WATCH"});
  let watchPrompts=0;
  const watching=runWatch(["--dir",project,"--approve"], {
    env:{...process.env,GUILD_ROOT:path.join(project,"modelguild")},
    maxPolls:100,pollMs:50,prompt:async()=>{watchPrompts++;return "y";},
  });
  await new Promise(r=>setTimeout(r,100));
  const watched=await tool("guild_consult",{question:"watch approval",model:"openai/test"});
  await watching;
  c.check(watchPrompts===1 && watched.structuredContent?.approval?.approved===1,
    "watch --approve can answer after Codex cancels elicitation");
  setControl({edit:true,answer:"EDIT"});
  const edited=await tool("guild_delegate",{task:"edit fixture",model:"openai/test",worktree:sibling});
  c.check(existsSync(path.join(sibling,"codex-worker-result.txt")) && !existsSync(path.join(project,"codex-worker-result.txt")),"backend edits only the targeted worktree");
  const capture=edited.structuredContent?.capture;
  c.check(Boolean(capture?.patchPath && readFileSync(capture.patchPath,"utf8").includes("written by the backend fixture")),"receipt captures the targeted tree's actual diff");
  setControl({delay:65000,answer:"LONG"});
  console.log("Checking a 65-second tool call through Codex...");
  const long=await tool("guild_consult",{question:"long",model:"openai/test"});
  c.check(long.structuredContent?.answer==="LONG","call longer than Codex's default 60s completes");
  c.check(Boolean(long.structuredContent?.activity), "activity summary survives in the completed Codex result");
  console.log("Progress notifications exposed by App Server direct calls:", client.notifications.some(n=>JSON.stringify(n).includes("progress")));
  // This Codex direct-call surface currently exposes no progress notifications. Keep
  // the observation explicit; do not pretend this proves CLI/IDE progress rendering.
  // guild_status obtains the primary child pid without a model turn.
  const status=await tool("guild_status");
  backendPid=status.structuredContent?.pid ?? JSON.parse(status.content[0].text).pid;
  const before=readFileSync(control+".started","utf8").length;
  setControl({delay:65000,answer:"INTERRUPTED"});
  const interrupted=tool("guild_consult",{question:"close during turn",model:"openai/test"}).catch(()=>undefined);
  for(let i=0;i<50 && readFileSync(control+".started","utf8").length===before;i++) {
    await new Promise(r=>setTimeout(r,100));
  }
  c.check(readFileSync(control+".started","utf8").length>before,"worker started before client-close interruption");
  await client.close();
  await interrupted;
  const pids=readFileSync(control+".pids","utf8").trim().split("\n").map(Number);
  let alive=true;
  for(let i=0;i<50;i++) {
    alive=pids.some(pid=>{try {process.kill(pid,0);return true;} catch {return false;}});
    if (!alive) break;
    await new Promise(r=>setTimeout(r,100));
  }
  c.check(!alive,"closing Codex during a turn tears down every worktree backend");
} finally {
  await client.close();
  git("worktree","remove","--force",sibling);
  rmSync(root,{recursive:true,force:true});
}
console.log(`codex-client.live: ${c.passes} passed, ${c.failures} failed (scripted backend; no model calls)`);
process.exitCode=c.failures ? 1 : 0;
