/** Focused tests for the child-process suite runner. */

import { EventEmitter } from "node:events";
import { Checker } from "./harness.js";
import { runSuites, type Spawn, type Suite } from "./run.js";

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
}

export async function run(): Promise<number> {
  const t = new Checker();
  const children = new Map<string, FakeChild>();
  const started: string[] = [];
  const spawn: Spawn = (_command, args) => {
    const child = new FakeChild();
    const name = args.at(-1)!;
    children.set(name, child);
    started.push(name);
    return child;
  };
  const lines: string[] = [];
  const suites: Suite[] = ["one", "two", "three"].map((name) => ({ name, command: "node", args: [name] }));
  const result = runSuites(suites, { concurrency: 2, spawn, write: (text) => lines.push(text) });

  await Promise.resolve();
  t.check(started.join(",") === "one,two", "starts no more than the concurrency cap");
  children.get("one")!.stdout.emit("data", "one stdout\n");
  children.get("one")!.stderr.emit("data", "one stderr\n");
  children.get("one")!.stdout.emit("data", "one later\n");
  t.check(lines.length === 0, "buffers a suite's stdout and stderr until it closes");
  children.get("one")!.emit("close", 0);
  await new Promise<void>((resolve) => setImmediate(resolve));
  t.check(started.join(",") === "one,two,three", "starts the next suite only after a slot opens");
  children.get("two")!.stdout.emit("data", "two stdout\n");
  children.get("two")!.emit("close", 1);
  children.get("three")!.stderr.emit("data", "three stderr\n");
  children.get("three")!.emit("close", 0);
  const completed = await result;

  const rendered = lines.join("");
  t.check(rendered.includes("=== one ===\none stdout\none stderr\none later\n") && rendered.includes("=== two ===\ntwo stdout\n"),
    "flushes each suite's buffered output as one labelled block");
  t.check(rendered.includes("one stdout\none stderr\none later"), "preserves stdout/stderr emission order within a suite");
  t.check(rendered.includes("=== three ===\nthree stderr\n"), "keeps stderr with its suite rather than interleaving it");
  t.check(completed.failures.length === 1 && completed.failures[0] === "two",
    "continues after a failed suite and aggregates its failure");

  const limited = new FakeChild();
  const limitedOutput: string[] = [];
  const limitedRun = runSuites([{ name: "limited", command: "node", args: ["limited"] }], {
    spawn: () => limited,
    outputLimitBytes: 5,
    write: (text) => limitedOutput.push(text),
  });
  limited.stdout.emit("data", "abc");
  limited.stderr.emit("data", "def");
  limited.emit("close", 0);
  await limitedRun;
  t.check(limitedOutput.join("") === "=== limited ===\nabcde\n[output truncated after 5 bytes]\n\n",
    "bounds combined output and visibly reports truncation");

  const signalled = new FakeChild();
  const signalResult = runSuites([{ name: "signalled", command: "node", args: ["signalled"] }], {
    spawn: () => signalled,
    write: () => undefined,
  });
  signalled.emit("close", null, "SIGTERM");
  t.check((await signalResult).failures.join(",") === "signalled", "treats a signal-terminated child as a failed suite");

  console.log(`runner.test: ${t.passes} passed, ${t.failures} failed`);
  return t.failures;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().then((failures) => process.exit(failures > 0 ? 1 : 0));
}
