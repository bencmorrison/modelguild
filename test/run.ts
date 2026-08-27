/**
 * Test runner: isolates suites in child processes, atomically prints their bounded,
 * emission-ordered output, and runs up to four at once. `--offline` omits the three
 * suites needing real opencode. Non-flag arguments (issue #194) name which suites to
 * run — an unknown name refuses before any suite starts, rather than silently running
 * everything, which is what made `npx tsx test/run.ts <typo>` a trap.
 */

import { spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const tsxBin = path.join(repoRoot, "node_modules", ".bin", "tsx");

export const ALL_SUITES = [
  "lifecycle", "orphan", "mcp-client", "serve-stderr", "client", "activity",
  "approve", "log", "policy", "config", "consult", "panel", "research",
  "delegate", "models", "init", "doctor", "worktree", "agentfloor", "runner",
] as const;

export const OFFLINE_EXCLUDED = ["lifecycle", "orphan", "mcp-client"] as const;
export const OUTPUT_LIMIT_BYTES = 1024 * 1024;

export interface Suite {
  name: string;
  command: string;
  args: string[];
}

interface Child extends EventEmitter {
  stdout: EventEmitter | null;
  stderr: EventEmitter | null;
}

export type Spawn = (command: string, args: string[], options: SpawnOptions) => Child;

export interface RunOptions {
  concurrency?: number;
  spawn?: Spawn;
  write?: (text: string) => void;
  outputLimitBytes?: number;
}

export interface RunResult {
  failures: string[];
}

function suiteEntry(name: string): Suite {
  return {
    name,
    command: process.execPath,
    args: [tsxBin, path.join(repoRoot, "test", `${name}.test.ts`)],
  };
}

/**
 * Resolve which suite names an invocation asked for (issue #194).
 *
 * No names ⇒ every suite, unchanged from before this issue. Named suites run ONLY
 * those — an unknown name is reported rather than silently ignored, which is the
 * defect: `npx tsx test/run.ts <typo>` used to start the entire suite with no
 * warning. `unknown` is checked by the caller before anything runs.
 */
export function resolveRequestedNames(names: string[]): { names: string[]; unknown: string[] } {
  if (names.length === 0) return { names: [...ALL_SUITES], unknown: [] };
  const known = new Set<string>(ALL_SUITES);
  const unknown = names.filter((name) => !known.has(name));
  return { names, unknown };
}

/**
 * Split requested names into what actually runs and what `--offline` excludes
 * (issue #194). A named suite that is also in `OFFLINE_EXCLUDED` is reported as
 * excluded, not silently dropped — composing `--offline` with an explicit name is
 * the same "excluded, and it says so" contract the no-args case already has, rather
 * than a second, stricter behaviour (an error) that only bites when a name is given.
 */
export function partitionForOffline(names: string[], offline: boolean): { toRun: string[]; excluded: string[] } {
  const excludedSet = new Set<string>(offline ? OFFLINE_EXCLUDED : []);
  return {
    toRun: names.filter((name) => !excludedSet.has(name)),
    excluded: names.filter((name) => excludedSet.has(name)),
  };
}

function output(name: string, buffer: Buffer, outputBytes: number, truncated: boolean, outputLimitBytes: number, write: (text: string) => void): void {
  write(`=== ${name} ===\n`);
  const text = buffer.subarray(0, outputBytes).toString();
  if (text) write(text.endsWith("\n") ? text : `${text}\n`);
  if (truncated) write(`[output truncated after ${outputLimitBytes} bytes]\n`);
  write("\n");
}

/** Run all requested suites, continuing after every child failure or spawn error. */
export async function runSuites(suites: Suite[], options: RunOptions = {}): Promise<RunResult> {
  const concurrency = options.concurrency ?? 4;
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("concurrency must be a positive integer");
  const outputLimitBytes = options.outputLimitBytes ?? OUTPUT_LIMIT_BYTES;
  if (!Number.isInteger(outputLimitBytes) || outputLimitBytes < 0) throw new Error("outputLimitBytes must be a non-negative integer");
  const spawn = options.spawn ?? ((command, args, childOptions) => nodeSpawn(command, args, childOptions) as unknown as Child);
  const write = options.write ?? ((text) => process.stdout.write(text));
  const failures: string[] = [];
  let next = 0;

  async function runOne(suite: Suite): Promise<void> {
    await new Promise<void>((resolve) => {
      const buffer = Buffer.allocUnsafe(outputLimitBytes);
      let outputBytes = 0;
      let truncated = false;
      let settled = false;
      const capture = (chunk: Buffer | string) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const remaining = outputLimitBytes - outputBytes;
        if (remaining <= 0) {
          truncated = true;
          return;
        }
        const captured = Math.min(bytes.length, remaining);
        bytes.copy(buffer, outputBytes, 0, captured);
        outputBytes += captured;
        if (bytes.length > remaining) truncated = true;
      };
      const finish = (failed: boolean, error?: Error) => {
        if (settled) return;
        settled = true;
        if (error) capture(`${error.message}\n`);
        output(suite.name, buffer, outputBytes, truncated, outputLimitBytes, write);
        if (failed) failures.push(suite.name);
        resolve();
      };

      let child: Child;
      try {
        child = spawn(suite.command, suite.args, { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
      } catch (error) {
        finish(true, error instanceof Error ? error : new Error(String(error)));
        return;
      }
      child.stdout?.on("data", capture);
      child.stderr?.on("data", capture);
      child.once("error", (error: Error) => finish(true, error));
      child.once("close", (code: number | null, signal: NodeJS.Signals | null | undefined) => finish(code !== 0 || signal != null));
    });
  }

  async function worker(): Promise<void> {
    for (;;) {
      const suite = suites[next++];
      if (!suite) return;
      await runOne(suite);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, suites.length) }, worker));
  return { failures };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const offline = argv.includes("--offline");
  const requestedNames = argv.filter((arg) => arg !== "--offline");

  const { names, unknown } = resolveRequestedNames(requestedNames);
  if (unknown.length > 0) {
    console.error(`Unknown suite name(s): ${unknown.join(", ")}.`);
    console.error(`Known suites: ${ALL_SUITES.join(", ")}.`);
    process.exitCode = 1;
    return;
  }

  const { toRun, excluded } = partitionForOffline(names, offline);
  if (excluded.length > 0) {
    console.log(`Offline mode: excluding ${excluded.join(", ")} (need real opencode).\n`);
  }

  const result = await runSuites(toRun.map(suiteEntry));
  if (result.failures.length > 0) {
    console.error(`FAILED: ${result.failures.length} suite(s) failed: ${result.failures.join(", ")}.`);
    process.exitCode = 1;
  } else {
    console.log("All test suites passed.");
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
