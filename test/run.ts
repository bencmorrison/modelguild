/**
 * M1 test runner: run every offline test module in sequence, aggregate failures.
 * No model is called; spawning `opencode serve` is free and expected.
 */

import { run as lifecycle } from "./lifecycle.test.js";
import { run as orphan } from "./orphan.test.js";
import { run as mcpClient } from "./mcp-client.test.js";
import { run as client } from "./client.test.js";
import { run as activity } from "./activity.test.js";
import { run as approve } from "./approve.test.js";
import { run as log } from "./log.test.js";
import { run as policy } from "./policy.test.js";
import { run as config } from "./config.test.js";
import { run as consult } from "./consult.test.js";
import { run as panel } from "./panel.test.js";
import { run as research } from "./research.test.js";
import { run as delegate } from "./delegate.test.js";
import { run as modelsSuite } from "./models.test.js";
import { run as initSuite } from "./init.test.js";
import { run as doctorSuite } from "./doctor.test.js";

const suites: Array<[string, () => Promise<number>]> = [
  ["lifecycle", lifecycle],
  ["orphan", orphan],
  ["mcp-client", mcpClient],
  ["client", client],
  ["activity", activity],
  ["approve", approve],
  ["log", log],
  ["policy", policy],
  ["config", config],
  ["consult", consult],
  ["panel", panel],
  ["research", research],
  ["delegate", delegate],
  ["models", modelsSuite],
  ["init", initSuite],
  ["doctor", doctorSuite],
];

let total = 0;
for (const [name, fn] of suites) {
  try {
    total += await fn();
  } catch (err) {
    console.error(`\nSuite "${name}" threw:`, err);
    total += 1;
  }
  console.log("");
}

if (total > 0) {
  console.error(`FAILED: ${total} check(s) failed across all suites.`);
  process.exit(1);
}
console.log("All M1 suites passed.");
