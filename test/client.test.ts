/**
 * Typed opencode client tests — OFFLINE-FIRST.
 *
 * Every case runs against the `node:http` fake (test/fake-opencode-server.ts): no
 * opencode, no model. They pin the wire-shape contract (the two distinct model key
 * shapes, agent threading), the byte-exact round-trip of an awkward string, the
 * history-vs-sync discrimination (the fake serves DIFFERENT text in each), session
 * teardown on both success and error paths, and timeout abort behavior.
 */

import {
  askViaAgent,
  createSession,
  sendMessage,
  fetchHistory,
  finalAssistantText,
  toolParts,
  splitModel,
  OpencodeHttpError,
  AgentMismatchError,
  type ServeProvider,
} from "../src/client.js";
import { startFakeOpencode, type FakeOpencode } from "./fake-opencode-server.js";
import { Checker, fakeServeHandle } from "./harness.js";

/** A `ServeProvider` that points `withServe` at an already-running fake — the M1
 * lifecycle contract exercised without spawning opencode. */
function fakeServe(fake: FakeOpencode): ServeProvider {
  const handle = fakeServeHandle(fake.baseUrl);
  return { withServe: (fn) => fn(handle) };
}

/** A string that would expose every classic capture bug: embedded newlines, a
 * trailing newline (the `$(cat)` trap from the bash layer), quotes, and unicode. */
const AWKWARD =
  'line one\n"quoted" value\ttab\ncafé ☕ — naïve façade\n{"json":true}\ntrailing-newline-follows\n';

export async function run(): Promise<number> {
  const c = new Checker();
  console.log("== client.test ==");

  // splitModel unit checks -----------------------------------------------------
  {
    const a = splitModel("openai/gpt-5.5");
    c.check(a.providerID === "openai" && a.modelID === "gpt-5.5", "splitModel splits provider/model");
    const b = splitModel("bare-model");
    c.check(b.providerID === "opencode" && b.modelID === "bare-model", "splitModel defaults provider to opencode");
    const nested = splitModel("openai/family/variant");
    c.check(
      nested.providerID === "openai" && nested.modelID === "family/variant",
      "splitModel only splits on the first slash",
    );
    try {
      splitModel("");
      c.check(false, "splitModel throws on an empty model spec");
    } catch (err) {
      c.check(
        err instanceof Error && err.message.includes("empty model spec"),
        "splitModel throws on an empty model spec",
      );
    }
  }

  // 1. createSession sends the {id, providerID} shape + agent threading --------
  {
    const fake = await startFakeOpencode({ historyText: "x" });
    try {
      await createSession({ baseUrl: fake.baseUrl, agent: "guild-read", title: "t", model: "openai/gpt-5" });
      const body = fake.recorded.createBodies[0];
      const model = body.model as Record<string, unknown> | undefined;
      c.check(!!model && model.id === "gpt-5" && model.providerID === "openai", "createSession model = {id, providerID}");
      c.check(!!model && !("modelID" in model), "createSession model has NO modelID key (not swapped)");
      c.check(body.agent === "guild-read", "createSession threads the agent");
      c.check(body.title === "t", "createSession sends the title");
    } finally {
      await fake.close();
    }
  }

  // 2. sendMessage sends the {providerID, modelID} shape + agent threading -----
  {
    const fake = await startFakeOpencode({ historyText: "x" });
    try {
      await sendMessage({
        baseUrl: fake.baseUrl,
        sessionId: "ses_fake",
        agent: "guild-read",
        model: "openai/gpt-5",
        parts: [{ type: "text", text: "hi" }],
      });
      const body = fake.recorded.messageBodies[0];
      const model = body.model as Record<string, unknown> | undefined;
      c.check(!!model && model.providerID === "openai" && model.modelID === "gpt-5", "sendMessage model = {providerID, modelID}");
      c.check(!!model && !("id" in model), "sendMessage model has NO id key (not swapped)");
      c.check(body.agent === "guild-read", "sendMessage threads the agent");
      const parts = body.parts as Array<Record<string, unknown>>;
      c.check(Array.isArray(parts) && parts[0]?.text === "hi", "sendMessage forwards the parts");
    } finally {
      await fake.close();
    }
  }

  // 2b. the two shapes are genuinely different keys (swap-catcher, side by side)-
  {
    const fake = await startFakeOpencode({ historyText: "x" });
    try {
      await createSession({ baseUrl: fake.baseUrl, agent: "a", model: "prov/mdl" });
      await sendMessage({ baseUrl: fake.baseUrl, sessionId: "ses_fake", agent: "a", model: "prov/mdl", parts: [{ type: "text", text: "q" }] });
      const createModel = fake.recorded.createBodies[0].model as Record<string, unknown>;
      const msgModel = fake.recorded.messageBodies[0].model as Record<string, unknown>;
      c.check("id" in createModel && !("modelID" in createModel), "create uses `id`, message does not");
      c.check("modelID" in msgModel && !("id" in msgModel), "message uses `modelID`, create does not");
    } finally {
      await fake.close();
    }
  }

  // 3. sendMessage returns metadata ONLY — never the sync text -----------------
  {
    const fake = await startFakeOpencode({ historyText: "x", syncText: "SYNC-LEAK" });
    try {
      const r = await sendMessage({
        baseUrl: fake.baseUrl,
        sessionId: "ses_fake",
        agent: "a",
        model: "openai/gpt-fake",
        parts: [{ type: "text", text: "q" }],
      });
      c.check(r.finish === "stop" && r.cost === 0.0042, "sendMessage surfaces completion metadata (finish, cost)");
      c.check(r.providerID === "openai" && r.modelID === "gpt-fake", "sendMessage surfaces provider/model ids");
      // Structural + serialized proof the sync text is unreachable via SendResult.
      c.check(!JSON.stringify(r).includes("SYNC-LEAK"), "SendResult does not carry the sync body text");
    } finally {
      await fake.close();
    }
  }

  // 4. byte-exact round-trip of an awkward string, FROM HISTORY -----------------
  {
    const fake = await startFakeOpencode({ historyText: AWKWARD });
    try {
      const r = await askViaAgent(fakeServe(fake), { agent: "guild-read", model: "openai/gpt-fake", prompt: "q" });
      c.check(r.text === AWKWARD, "askViaAgent returns byte-identical text (newlines/quotes/unicode)");
      c.check(r.text.length === AWKWARD.length, `text length preserved (${r.text.length} chars)`);
      c.check(r.text.endsWith("\n"), "trailing newline preserved (no $(cat)-style stripping)");
      c.check(
        Buffer.from(r.text, "utf8").equals(Buffer.from(AWKWARD, "utf8")),
        "text is byte-for-byte identical (utf8 buffer compare)",
      );
    } finally {
      await fake.close();
    }
  }

  // 5. THE DISCRIMINATION TEST: history is the source, NOT the sync response ----
  //    Fake serves "HISTORY-RIGHT" in GET history and "SYNC-WRONG" in the POST
  //    body. A client that read the sync body would return the wrong string.
  {
    const fake = await startFakeOpencode({ historyText: "HISTORY-RIGHT-ANSWER", syncText: "SYNC-WRONG-ANSWER" });
    try {
      const r = await askViaAgent(fakeServe(fake), { agent: "guild-read", model: "openai/gpt-fake", prompt: "q" });
      c.check(r.text === "HISTORY-RIGHT-ANSWER", "final text comes from GET history");
      c.check(r.text !== "SYNC-WRONG-ANSWER", "final text is NOT the sync POST body");
      // And directly on the extractor, independent of the compose path.
      const hist = await fetchHistory({ baseUrl: fake.baseUrl, sessionId: "ses_fake" });
      c.check(finalAssistantText(hist) === "HISTORY-RIGHT-ANSWER", "finalAssistantText reads the last assistant text from history");
    } finally {
      await fake.close();
    }
  }

  // 6. tool parts exposed in the typed {tool, state:{status,input,error,output}} -
  {
    const fake = await startFakeOpencode({ historyText: "x" });
    try {
      const hist = await fetchHistory({ baseUrl: fake.baseUrl, sessionId: "ses_fake" });
      const tps = toolParts(hist);
      c.check(tps.length === 1, "one tool part extracted from history");
      c.check(tps[0]?.tool === "read", "tool part name is 'read'");
      c.check(tps[0]?.state.status === "completed", "tool part status is 'completed'");
      c.check(tps[0]?.state.output === "MARKER-FILE-CONTENTS", "tool part output surfaced");
      c.check(tps[0]?.state.error === undefined, "tool part error undefined for a completed call");
      const input = tps[0]?.state.input as Record<string, unknown> | undefined;
      c.check(!!input && input.filePath === "/x/marker.txt", "tool part input surfaced");
    } finally {
      await fake.close();
    }
  }

  // 7. session deleted on the SUCCESS path -------------------------------------
  {
    const fake = await startFakeOpencode({ historyText: "ok" });
    try {
      await askViaAgent(fakeServe(fake), { agent: "guild-read", model: "openai/gpt-fake", prompt: "q" });
      c.check(fake.recorded.deletes.includes("ses_fake"), "session deleted after a successful ask");
      c.check(fake.recorded.deletes.length === 1, "session deleted exactly once");
    } finally {
      await fake.close();
    }
  }

  // 8. session deleted on the ERROR path (history read fails) ------------------
  {
    const fake = await startFakeOpencode({ historyText: "x", failHistory: true });
    try {
      let threw = false;
      try {
        await askViaAgent(fakeServe(fake), { agent: "guild-read", model: "openai/gpt-fake", prompt: "q" });
      } catch (err) {
        threw = true;
        c.check(err instanceof OpencodeHttpError, "history failure surfaces an OpencodeHttpError");
        c.check((err as OpencodeHttpError).detail.status === 500, "error carries the HTTP status (500)");
        c.check((err as OpencodeHttpError).detail.sessionId === "ses_fake", "error carries the sessionId");
      }
      c.check(threw, "askViaAgent rejects when the history read fails");
      c.check(fake.recorded.deletes.includes("ses_fake"), "session STILL deleted on the error path (finally)");
    } finally {
      await fake.close();
    }
  }

  // 8b. keepSession: returns the id and SKIPS the delete (M7 Option B) -----------
  {
    const fake = await startFakeOpencode({ historyText: "kept" });
    try {
      const r = await askViaAgent(fakeServe(fake), {
        agent: "guild-read",
        model: "openai/gpt-fake",
        prompt: "q",
        keepSession: true,
      });
      c.check(r.sessionId === "ses_fake", "keepSession returns the session id");
      c.check(fake.recorded.deletes.length === 0, "keepSession skips the finally-delete");
      c.check(fake.recorded.createBodies.length === 1, "keepSession still created the session (fresh)");
    } finally {
      await fake.close();
    }
  }

  // 8c. sessionId: CONTINUES an existing session — NO create call (M7 Option B) ---
  {
    const fake = await startFakeOpencode({ historyText: "continued" });
    try {
      const r = await askViaAgent(fakeServe(fake), {
        agent: "guild-read",
        model: "openai/gpt-fake",
        prompt: "the only new bytes",
        sessionId: "ses_existing",
      });
      c.check(r.sessionId === "ses_existing", "continuation returns the continued session id");
      c.check(fake.recorded.createBodies.length === 0, "continuation makes NO POST /session (no create)");
      c.check(fake.recorded.messageBodies.length === 1, "continuation sends exactly one turn");
      c.check(fake.recorded.historyGets.includes("ses_existing"), "history read against the continued id");
      c.check(fake.recorded.deletes.includes("ses_existing"), "continued session deleted (keepSession not set)");
    } finally {
      await fake.close();
    }
  }

  // 8d. sessionId + keepSession: continue AND keep alive (round-2 into round-3) ---
  {
    const fake = await startFakeOpencode({ historyText: "continued-kept" });
    try {
      const r = await askViaAgent(fakeServe(fake), {
        agent: "guild-read",
        model: "openai/gpt-fake",
        prompt: "next turn",
        sessionId: "ses_keep",
        keepSession: true,
      });
      c.check(r.sessionId === "ses_keep", "continue+keep returns the id");
      c.check(fake.recorded.createBodies.length === 0, "continue+keep makes no create call");
      c.check(fake.recorded.deletes.length === 0, "continue+keep skips the delete");
    } finally {
      await fake.close();
    }
  }

  // 8e. DELETION MATRIX — created-here + THROW + keepSession → DELETE (no orphan) ----
  //     A kept session whose turn threw has an UNRETURNABLE id; keeping it would be a
  //     durable on-disk orphan (sessions persist), so it MUST be torn down.
  {
    const fake = await startFakeOpencode({ historyText: "x", failHistory: true });
    try {
      let threw = false;
      try {
        await askViaAgent(fakeServe(fake), {
          agent: "guild-read",
          model: "openai/gpt-fake",
          prompt: "q",
          keepSession: true, // intent to keep — but the throw overrides it for a created session
        });
      } catch {
        threw = true;
      }
      c.check(threw, "matrix: created+throw+keep rejects");
      c.check(fake.recorded.deletes.includes("ses_fake"), "matrix: created+throw+keep DELETES (no orphan)");
      c.check(fake.recorded.deletes.length === 1, "matrix: created+throw+keep deletes exactly once");
    } finally {
      await fake.close();
    }
  }

  // 8f. DELETION MATRIX — CONTINUED + THROW → NEVER delete (caller owns the id) -------
  //     The caller supplied the session and may retry; deleting it would destroy state we
  //     did not create (e.g. a workshop round-1 session). True regardless of keepSession.
  {
    for (const keep of [false, true]) {
      const fake = await startFakeOpencode({ historyText: "x", failHistory: true });
      try {
        let threw = false;
        try {
          await askViaAgent(fakeServe(fake), {
            agent: "guild-read",
            model: "openai/gpt-fake",
            prompt: "q",
            sessionId: "ses_owned",
            keepSession: keep,
          });
        } catch {
          threw = true;
        }
        c.check(threw, `matrix: continued+throw (keep=${keep}) rejects`);
        c.check(fake.recorded.createBodies.length === 0, `matrix: continued+throw (keep=${keep}) made no create`);
        c.check(fake.recorded.deletes.length === 0, `matrix: continued+throw (keep=${keep}) NEVER deletes (caller owns the id)`);
      } finally {
        await fake.close();
      }
    }
  }

  // 8g. AGENT MISMATCH — opencode serves a DIFFERENT agent than requested → throw ------
  //     Fail closed: a served 'build' when 'guild-read' was requested is a masquerade.
  {
    const fake = await startFakeOpencode({ historyText: "wrong-agent answer", servedAgent: "build" });
    try {
      let mismatch = false;
      try {
        await askViaAgent(fakeServe(fake), {
          agent: "guild-read",
          model: "openai/gpt-fake",
          prompt: "q",
          expectedAgent: "guild-read",
        });
      } catch (err) {
        mismatch = err instanceof AgentMismatchError;
        if (mismatch) {
          c.check((err as AgentMismatchError).requested === "guild-read", "mismatch: error names requested agent");
          c.check((err as AgentMismatchError).actual === "build", "mismatch: error names actual served agent");
        }
      }
      c.check(mismatch, "mismatch: askViaAgent throws AgentMismatchError on a wrong-agent answer");
      c.check(fake.recorded.deletes.includes("ses_fake"), "mismatch: the wrong-agent session is cleaned up (created+throw)");
    } finally {
      await fake.close();
    }
  }

  // 8h. AGENT MATCH — served agent equals requested → no throw, answer returned --------
  {
    const fake = await startFakeOpencode({ historyText: "right answer", servedAgent: "guild-read" });
    try {
      const r = await askViaAgent(fakeServe(fake), {
        agent: "guild-read",
        model: "openai/gpt-fake",
        prompt: "q",
        expectedAgent: "guild-read",
      });
      c.check(r.text === "right answer", "match: answer returned when the served agent matches");
    } finally {
      await fake.close();
    }
  }

  // 9. timeout abort behavior --------------------------------------------------
  {
    const fake = await startFakeOpencode({ historyText: "x", messageDelayMs: 1_000 });
    try {
      let threw = false;
      const started = Date.now();
      try {
        await sendMessage({
          baseUrl: fake.baseUrl,
          sessionId: "ses_fake",
          agent: "a",
          model: "openai/gpt-fake",
          parts: [{ type: "text", text: "q" }],
          timeoutMs: 120,
        });
      } catch (err) {
        threw = true;
        c.check(err instanceof OpencodeHttpError, "timeout surfaces an OpencodeHttpError with context");
        c.check((err as OpencodeHttpError).detail.path.endsWith("/message"), "timeout error names the path");
      }
      const elapsed = Date.now() - started;
      c.check(threw, "sendMessage aborts when the response exceeds the timeout");
      c.check(elapsed < 800, `abort fired near the timeout, not the delay (${elapsed}ms < 1000ms delay)`);
    } finally {
      await fake.close();
    }
  }

  console.log(`client.test: ${c.passes} passed, ${c.failures} failed`);
  return c.failures;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().then((f) => process.exit(f > 0 ? 1 : 0));
}
