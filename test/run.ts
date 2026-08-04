/**
 * Test runner: isolates suites in child processes, atomically prints their bounded,
 * emission-ordered output, and runs up to four at once. `--offline` omits the three
 * suites needing real opencode.
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

function defaultSuites(offline: boolean): Suite[] {
  const excluded = new Set<string>(offline ? OFFLINE_EXCLUDED : []);
  return ALL_SUITES.filter((name) => !excluded.has(name)).map((name) => ({
    name,
    command: process.execPath,
    args: [tsxBin, path.join(repoRoot, "test", `${name}.test.ts`)],
  }));
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
  const offline = process.argv.slice(2).includes("--offline");
  if (offline) {
    console.log(`Offline mode: excluding ${OFFLINE_EXCLUDED.join(", ")} (need real opencode).\n`);
  }
  const result = await runSuites(defaultSuites(offline));
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
