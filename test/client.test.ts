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
  isBlank,
  sendMessage,
  fetchHistory,
  finalAssistantText,
  finalAssistantChannel,
  finalAssistantError,
  servingAgent,
  turnStartIndex,
  toolParts,
  splitModel,
  OpencodeHttpError,
  AgentMismatchError,
  type ServeProvider,
  type SessionHistory,
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

  // 10. TURN-SCOPED EXTRACTION (issue #117 review, defect 1) --------------------
  //
  //     Unit-level, on hand-built histories, because the property is about the SHAPE of the
  //     payload and the shapes here are copied from a live capture (opencode 1.18.7,
  //     `GET /session/{id}/message`, 2026-07-30) rather than from a design table:
  //
  //       {role:"user",      parts:["text"],                                   texts:["…BANANA"]}
  //       {role:"assistant", finish:"stop", error:null,
  //                          parts:["step-start","reasoning","text","step-finish"], texts:["BANANA"]}
  //       {role:"user",      parts:["text"],                                   texts:["…KIWI"]}
  //       {role:"assistant", finish:null, parts:[],
  //                          error:{name:"APIError", data:{message:"You have exceeded your
  //                                 monthly quota", statusCode:402, …}}}
  //
  //     `fetchHistory` returns the WHOLE session, so an unbounded backward walk answers the
  //     second question with the first answer.
  {
    const user = (text: string) => ({
      role: "user",
      info: { role: "user" } as Record<string, unknown>,
      parts: [{ type: "text", text }] as Array<Record<string, unknown>>,
    });
    const answered = (text: string, agent?: string) => ({
      role: "assistant",
      info: { role: "assistant", finish: "stop", error: null, ...(agent ? { agent } : {}) } as Record<
        string,
        unknown
      >,
      parts: [
        { type: "step-start" },
        { type: "reasoning", text: "…" },
        { type: "text", text },
        { type: "step-finish" },
      ] as Array<Record<string, unknown>>,
    });
    const rejected = (agent?: string) => ({
      role: "assistant",
      info: {
        role: "assistant",
        finish: null,
        error: {
          name: "APIError",
          data: {
            message: "You have exceeded your monthly quota",
            statusCode: 402,
            isRetryable: false,
            responseBody: "SHOULD-NOT-BE-QUOTED",
            responseHeaders: { "x-request-id": "SHOULD-NOT-BE-QUOTED" },
          },
        },
        ...(agent ? { agent } : {}),
      } as Record<string, unknown>,
      parts: [] as Array<Record<string, unknown>>,
    });
    const toolOnly = (agent?: string) => ({
      role: "assistant",
      info: { role: "assistant", finish: "tool-calls", ...(agent ? { agent } : {}) } as Record<
        string,
        unknown
      >,
      parts: [
        { type: "step-start" },
        { type: "tool", tool: "read", state: { status: "completed" } },
        { type: "step-finish" },
      ] as Array<Record<string, unknown>>,
    });

    const crossTurn: SessionHistory = {
      messages: [user("Reply with exactly: BANANA"), answered("BANANA", "guild-read"), user("Reply with exactly: KIWI"), rejected("build")],
    };
    c.check(turnStartIndex(crossTurn) === 3, "turn scope: the turn starts just past the LAST user message");
    c.check(
      finalAssistantText(crossTurn) === "",
      "turn scope: a silent turn yields '' — NOT the previous turn's answer (the #117 defect)",
    );
    c.check(
      servingAgent(crossTurn) === undefined,
      "turn scope: servingAgent does not validate this turn against the PREVIOUS turn's message",
    );

    // The reason the backward walk exists, still working: one turn split across a tool-only
    // assistant message and a text-bearing one.
    const multiMessageTurn: SessionHistory = {
      messages: [user("q"), toolOnly("guild-read"), answered("THE ANSWER", "guild-read")],
    };
    c.check(
      finalAssistantText(multiMessageTurn) === "THE ANSWER",
      "turn scope: a tool-only assistant message still cannot blank the answer",
    );
    c.check(servingAgent(multiMessageTurn) === "guild-read", "turn scope: servingAgent reads the answering message");

    // And it still reaches back across a tool-only message WITHIN the turn on a continuation.
    const continuedMulti: SessionHistory = {
      messages: [user("q1"), answered("OLD", "guild-read"), user("q2"), toolOnly("guild-read"), answered("NEW", "guild-read")],
    };
    c.check(finalAssistantText(continuedMulti) === "NEW", "turn scope: a continuation returns ITS OWN turn's answer");

    // No user message at all (the low-level fixtures): the whole history is the turn.
    const noUser: SessionHistory = { messages: [answered("ONLY", "guild-read")] };
    c.check(turnStartIndex(noUser) === 0, "turn scope: with no user message the whole history is the turn");
    c.check(finalAssistantText(noUser) === "ONLY", "turn scope: an undelimited history is unchanged");

    // A text part that is PRESENT but not a string is no answer — and must not reach back.
    const nonString: SessionHistory = {
      messages: [
        user("q1"),
        answered("OLD"),
        user("q2"),
        {
          role: "assistant",
          info: { role: "assistant", finish: "stop" } as Record<string, unknown>,
          parts: [{ type: "text", text: 42 }] as Array<Record<string, unknown>>,
        },
      ],
    };
    c.check(finalAssistantText(nonString) === "", "turn scope: a non-string text part is no answer, and borrows nothing");

    // C74's BOUND: a preamble inside the turn IS this turn's text.
    const preamble: SessionHistory = {
      messages: [user("q1"), answered("OLD"), user("q2"), answered("I'll start by"), rejected()],
    };
    c.check(finalAssistantText(preamble) === "I'll start by", "turn scope: C74's bound — a preamble inside the turn is returned");

    // --- ISSUE #168: THE REASONING FALLBACK -------------------------------------------------
    // opencode's `Part` union carries `ReasoningPart` with its own `text`, and opencode's own
    // TUI renders it. A turn whose visible output arrived that way reconstructed to "" here and
    // was refused as `empty-answer` while the model demonstrably answered — the reported
    // failure. `answerSource` falls back to it, and ONLY when `text` found nothing.
    const reasoningOnly = (text: string, agent?: string) => ({
      role: "assistant",
      info: { role: "assistant", finish: "stop", ...(agent ? { agent } : {}) } as Record<string, unknown>,
      parts: [
        { type: "step-start" },
        { type: "reasoning", text },
        { type: "step-finish" },
      ] as Array<Record<string, unknown>>,
    });

    const reasoned: SessionHistory = {
      messages: [user("q"), toolOnly("guild-read"), reasoningOnly("THE REASONED ANSWER", "guild-read")],
    };
    c.check(
      finalAssistantText(reasoned) === "THE REASONED ANSWER",
      "#168: a reasoning-only turn reconstructs to the reasoning text, not ''",
    );
    // THE COUPLING (issue #168): the masquerade check must see the same message the answer came
    // from, or it goes blind on precisely the turns the fallback newly admits.
    c.check(
      servingAgent(reasoned) === "guild-read",
      "#168: servingAgent reads the reasoning message — the mismatch check is not blinded by the fallback",
    );

    // FALLBACK, NEVER A MERGE. `answered()` already carries a reasoning part beside its text, so
    // this asserts the priority directly: text alone, no chain-of-thought prefix.
    c.check(
      finalAssistantText({ messages: [user("q"), answered("THE ANSWER")] }) === "THE ANSWER",
      "#168: text wins outright over a reasoning part in the same message — no merge",
    );
    // And across MESSAGES within one turn: a reasoning-bearing message must not beat a later
    // text-bearing one, nor an earlier one. Both directions, because the two passes walk
    // independently and a single-pass implementation would get exactly one of them right.
    c.check(
      finalAssistantText({
        messages: [user("q"), reasoningOnly("EARLIER-REASONING"), answered("LATER-TEXT")],
      }) === "LATER-TEXT",
      "#168: a text-bearing message later in the turn wins over an earlier reasoning-only one",
    );
    c.check(
      finalAssistantText({
        messages: [user("q"), answered("EARLIER-TEXT"), reasoningOnly("LATER-REASONING")],
      }) === "EARLIER-TEXT",
      "#168: an earlier text-bearing message still wins over a later reasoning-only one",
    );

    // TURN-SCOPED, both passes. The fallback must not reach back across a user message and
    // answer this turn with the previous turn's reasoning — the BANANA defect by a second door.
    c.check(
      finalAssistantText({
        messages: [user("q1"), reasoningOnly("PREVIOUS-TURN-REASONING"), user("q2"), rejected()],
      }) === "",
      "#168: the reasoning fallback is turn-scoped — a silent turn borrows nothing from the last one",
    );
    // A reasoning part present but NOT a string is no answer, same rule as `text`.
    c.check(
      finalAssistantText({
        messages: [
          user("q"),
          {
            role: "assistant",
            info: { role: "assistant", finish: "stop" } as Record<string, unknown>,
            parts: [{ type: "reasoning", text: 42 }] as Array<Record<string, unknown>>,
          },
        ],
      }) === "",
      "#168: a non-string reasoning part is no answer",
    );

    // --- AN EMPTY TEXT PART MUST NOT BLOCK THE FALLBACK ------------------------------------
    // The gate is the JOINED STRING, not part presence. `{type:"text", text:""}` is exactly how
    // `tools-then-silent` — this repo's own model of #168's reported turn — ends, so a
    // presence-gated fallback would never have fired on the very shape it was written for.
    // All three arrangements, because a fallback can be wrong about any one of them alone.
    const emptyText = (agent?: string) => ({
      role: "assistant",
      info: { role: "assistant", finish: "stop", ...(agent ? { agent } : {}) } as Record<string, unknown>,
      parts: [{ type: "step-start" }, { type: "text", text: "" }] as Array<Record<string, unknown>>,
    });
    const bothInOne = {
      role: "assistant",
      info: { role: "assistant", finish: "stop", agent: "guild-read" } as Record<string, unknown>,
      parts: [
        { type: "reasoning", text: "COT" },
        { type: "text", text: "" },
      ] as Array<Record<string, unknown>>,
    };
    c.check(
      finalAssistantText({ messages: [user("q"), bothInOne] }) === "COT",
      "#168: an EMPTY text part in the same message does not block the reasoning fallback",
    );
    c.check(
      servingAgent({ messages: [user("q"), bothInOne] }) === "guild-read",
      "#168: ...and servingAgent still reads that message",
    );
    c.check(
      finalAssistantText({ messages: [user("q"), reasoningOnly("COT"), emptyText()] }) === "COT",
      "#168: an empty-text message AFTER a reasoning one does not block the fallback",
    );
    c.check(
      finalAssistantText({ messages: [user("q"), emptyText(), reasoningOnly("COT")] }) === "COT",
      "#168: an empty-text message BEFORE a reasoning one does not block the fallback",
    );
    // And the same rule fixes a defect that has nothing to do with reasoning: a trailing
    // empty-text message used to blank a real answer earlier in the same turn.
    c.check(
      finalAssistantText({ messages: [user("q"), answered("REAL ANSWER"), emptyText()] }) === "REAL ANSWER",
      "#168: a trailing EMPTY text message no longer blanks a real answer earlier in the turn",
    );
    // --- ISSUE #185: A TRAILING WHITESPACE-ONLY MESSAGE MUST NOT DISCARD A REAL ANSWER -----
    // #168's gate was `length > 0`, so `"\n"` or `"  "` satisfied it and blanked an answer
    // emitted earlier in the same turn — the same defect in a narrower shape. The gate is now
    // split: passes 1-2 decide WHICH MESSAGE ANSWERED on a non-blank test, passes 3-4 keep THE
    // BYTES of a turn that produced nothing else. Both halves are pinned here, because either
    // one collapsed back into the other reopens one of the two defects.
    const wsText = (ws: string, agent?: string) => ({
      role: "assistant",
      info: { role: "assistant", finish: "stop", ...(agent ? { agent } : {}) } as Record<string, unknown>,
      parts: [{ type: "step-start" }, { type: "text", text: ws }] as Array<Record<string, unknown>>,
    });
    const wsReasoning = (ws: string) => ({
      role: "assistant",
      info: { role: "assistant", finish: "stop" } as Record<string, unknown>,
      parts: [{ type: "reasoning", text: ws }] as Array<Record<string, unknown>>,
    });
    // Table 1 of issue #185 — measured on the pre-fix code, every row losing the answer.
    c.check(
      finalAssistantText({ messages: [user("q"), answered("REAL"), wsText("\n")] }) === "REAL",
      "#185: a trailing whitespace-only ('\\n') message no longer discards a real answer",
    );
    c.check(
      finalAssistantText({ messages: [user("q"), answered("REAL"), wsText("  ")] }) === "REAL",
      "#185: a trailing '  ' message no longer discards a real answer",
    );
    c.check(
      finalAssistantText({ messages: [user("q"), reasoningOnly("COT"), wsText("\n")] }) === "COT",
      "#185: a trailing whitespace-only message no longer discards a promoted reasoning answer",
    );
    // THE COUPLING, on the shape #185 introduces: the answering message is an EARLIER one, so
    // the masquerade check must read that one. Pre-fix it read the trailing message's agent and
    // would have reported a mismatch against an agent that answered nothing.
    c.check(
      servingAgent({ messages: [user("q"), answered("REAL", "guild-read"), wsText("\n", "build")] }) ===
        "guild-read",
      "#185: servingAgent reads the message that answered, not the trailing whitespace one",
    );
    // Table 2 of issue #185 — the byte-exact half. A whitespace-only answer with nothing else in
    // the turn is captured VERBATIM (and refused by requireAnswer's own trim), so `raw_response`
    // keeps what the model emitted. `trim()` as the single gate is what this forbids.
    c.check(
      finalAssistantText({ messages: [user("q"), wsText("\n  \t\n")] }) === "\n  \t\n",
      "#185: whitespace-only text ALONE is kept BYTE-EXACT",
    );
    // …and the same for reasoning, which #168 made an answer channel: a turn whose only output
    // is whitespace reasoning still records those bytes rather than reconstructing to "". The
    // issue proposed three tiers and this is the fourth; without it this case silently lost the
    // bytes the third tier exists to preserve.
    c.check(
      finalAssistantText({ messages: [user("q"), wsReasoning("  ")] }) === "  ",
      "#185: whitespace-only REASONING alone is kept BYTE-EXACT too — the gate split is symmetric",
    );
    // The residual #168 stated, now closed: whitespace text beside reasoning falls through to
    // the reasoning instead of keeping the whitespace and being refused.
    c.check(
      finalAssistantText({
        messages: [user("q"), { ...bothInOne, parts: [{ type: "reasoning", text: "COT" }, { type: "text", text: "  " }] }],
      }) === "COT",
      "#185: whitespace text BESIDE reasoning promotes the reasoning — #168's stated residual, closed",
    );
    c.check(
      finalAssistantText({ messages: [user("q"), reasoningOnly("COT"), wsText("  ")] }) === "COT",
      "#185: ...and across messages in the turn as well",
    );
    // TURN-SCOPED, on the new passes too: a turn whose only content is whitespace answers with
    // that whitespace and is refused — it must NOT reach back for the previous turn's answer.
    c.check(
      finalAssistantText({ messages: [user("q1"), answered("OLD"), user("q2"), wsText("\n")] }) === "\n",
      "#185: the byte-preserving passes are turn-scoped — no borrowing across a user message",
    );

    // --- ISSUE #195: THE BLANK ALPHABET, AND THE TWO GATES AGREEING ON IT -------------------
    // #185 split the gate in two; #195 is that the PREDICATE feeding it was ECMA-262's
    // `WhiteSpace`, which stops at `Zs` / U+FEFF / the line terminators. A trailing message of
    // one U+200B therefore won the walk AND passed `requireAnswer` — the SILENT half of the
    // defect, where the whitespace half at least failed loudly. Both gates now read one exported
    // `isBlank` (issue #204's constraint): widening one site alone is what produced the silent
    // half, so the table below asserts the invariant itself, not merely the new characters.
    // The alphabet is `trim()` plus `Cf` (format), `Cc` (control) and `Cs` (lone surrogate);
    // U+2800 is the one deliberate hole and has its own block below.
    const BLANK_TABLE: Array<[string, string]> = [
      // `Cf` — format characters, the shape the issue was filed on.
      ["U+200B ZERO WIDTH SPACE (Cf)", "\u200b"],
      ["U+180E MONGOLIAN VOWEL SEPARATOR (Cf)", "\u180e"],
      ["U+202E RIGHT-TO-LEFT OVERRIDE (Cf)", "\u202e"],
      ["U+00AD SOFT HYPHEN (Cf)", "\u00ad"],
      ["U+2060 WORD JOINER (Cf)", "\u2060"],
      ["U+061C ARABIC LETTER MARK (Cf)", "\u061c"],
      ["U+200E LEFT-TO-RIGHT MARK (Cf)", "\u200e"],
      // `Cc` — controls. U+0085 is the one that breaks the "it is all format characters"
      // framing: Unicode's own `White_Space=Yes` includes it, ECMA-262's `WhiteSpace`
      // production does not, so `trim()` returns it unchanged.
      ["U+0085 NEXT LINE (Cc)", "\u0085"],
      ["U+0000 NUL (Cc)", "\u0000"],
      ["U+007F DELETE (Cc)", "\u007f"],
      ["U+0001 START OF HEADING (Cc)", "\u0001"],
      ["U+009F APPLICATION PROGRAM COMMAND (Cc)", "\u009f"],
      // `Cs` — a LONE surrogate half. `\p{Cs}` matches one under the `u` flag; a well-formed
      // PAIR is a single astral code point and is NOT `Cs`, which the emoji control below pins.
      ["lone surrogate U+D800 (Cs)", "\ud800"],
      ["lone surrogate U+DFFF (Cs)", "\udfff"],
      // Already inside `trim()`'s own alphabet — kept so a widening that somehow lost one fails.
      ["U+00A0 NO-BREAK SPACE", "\u00a0"],
      ["U+FEFF ZERO WIDTH NO-BREAK SPACE", "\ufeff"],
      ["U+3000 IDEOGRAPHIC SPACE", "\u3000"],
      ["U+2028 LINE SEPARATOR", "\u2028"],
      ["U+2029 PARAGRAPH SEPARATOR", "\u2029"],
      // Mixtures: the predicate is over the WHOLE string, not over its first character.
      ["space + U+200B + space", " \u200b "],
      ["NUL + lone surrogate", "\u0000\ud800"],
      ["plain whitespace", " \t\n"],
    ];
    for (const [name, ch] of BLANK_TABLE) {
      // Half one: the answering gate. A trailing message of nothing but this must not win.
      c.check(
        finalAssistantText({ messages: [user("q"), answered("THE REAL ANSWER"), wsText(ch)] }) ===
          "THE REAL ANSWER",
        `#195: a trailing ${name} message no longer discards a real answer`,
      );
      // Half two: THE INVARIANT, stated as code (issue #204). A turn whose ONLY output is this
      // falls through to the byte-preserving passes — so the bytes survive verbatim — and every
      // string those passes can return must be one `requireAnswer` refuses. Asserting both
      // together is what a single-site widening would fail: the bytes would come back and the
      // refusal would not fire.
      const alone = finalAssistantText({ messages: [user("q"), wsText(ch)] });
      c.check(
        alone === ch && isBlank(alone),
        `#195/#204: ${name} alone is kept BYTE-EXACT and is still blank ⇒ requireAnswer refuses`,
      );
    }
    // NON-BLANK, the direction that would make the gate refuse everything. The emoji is the
    // `Cs` control: a well-formed surrogate PAIR is one astral code point, not a surrogate, so
    // widening to `\p{Cs}` must not swallow an answer that is a single emoji.
    c.check(
      !isBlank("THE REAL ANSWER") && !isBlank("a") && !isBlank("\u200ba") && !isBlank("\u0000a"),
      "#195: a real answer, a single letter, and a letter behind a ZWSP or a NUL are NON-blank",
    );
    c.check(
      !isBlank("\u{1F600}") &&
        finalAssistantText({ messages: [user("q"), answered("REAL"), wsText("\u{1F600}")] }) ===
          "\u{1F600}",
      "#195: a well-formed surrogate PAIR is NOT `Cs` — an emoji-only answer is still an answer",
    );
    // THE ONE STATED RESIDUAL, pinned so nobody reads the widening as "every invisible
    // character". U+2800 is category `So` — an ordinary PRINTING character whose glyph renders
    // as nothing — so no category predicate reaches it. It still wins the walk and is still
    // returned as an answer; that is a known limit of this fix, not an oversight.
    c.check(
      !isBlank("\u2800") &&
        finalAssistantText({ messages: [user("q"), answered("THE REAL ANSWER"), wsText("\u2800")] }) ===
          "\u2800",
      "#195 STATED RESIDUAL: U+2800 BRAILLE PATTERN BLANK (So) is not blank and still wins the walk",
    );
    // THE CHANNEL-CROSSING CASE from the issue: pass 1 used to accept the ZWSP text and never
    // reach the reasoning, so a promoted answer was lost AND the receipt recorded no channel.
    c.check(
      finalAssistantText({ messages: [user("q"), reasoningOnly("REASONED ANSWER"), wsText("\u200b")] }) ===
        "REASONED ANSWER",
      "#195: a trailing ZWSP no longer discards a promoted REASONING answer",
    );
    c.check(
      finalAssistantChannel({
        messages: [user("q"), reasoningOnly("REASONED ANSWER"), wsText("\u200b")],
      }) === "reasoning",
      "#195: ...and the promotion is reported on the reasoning channel, not left undefined",
    );

    // --- THE CHANNEL IS RECORDED (issue #168) ----------------------------------------------
    c.check(
      finalAssistantChannel(reasoned) === "reasoning",
      "#168: a promoted answer reports its channel",
    );
    c.check(
      finalAssistantChannel({ messages: [user("q"), answered("THE ANSWER")] }) === undefined,
      "#168: an ordinary answer reports NO channel — absent, not 'text' (C29 optional-field)",
    );
    c.check(
      finalAssistantChannel({ messages: [user("q1"), reasoningOnly("OLD"), user("q2"), rejected()] }) ===
        undefined,
      "#168: a turn that answered nothing reports no channel",
    );
    // #185: the byte-preserving passes report their channel on the same rule — a turn kept for
    // its bytes alone still came off `reasoning`, and the EXTRACTOR says so. Scoped to the
    // extractor deliberately (issue #202): `EmptyAnswerError` carries no channel field, so the
    // read tools' refusal RECEIPT omits `answer_channel` — do not read this as a claim about
    // what `calls.jsonl` records for a refused turn.
    c.check(
      finalAssistantChannel({ messages: [user("q"), wsReasoning("  ")] }) === "reasoning",
      "#185: whitespace reasoning kept for its bytes still reports the reasoning channel",
    );
    c.check(
      finalAssistantChannel({ messages: [user("q"), wsText("\n")] }) === undefined,
      "#185: whitespace text kept for its bytes reports no channel — it came off `text`",
    );

    // The provider's own diagnosis, whitelisted.
    const diag = finalAssistantError(crossTurn);
    c.check(diag === "APIError: You have exceeded your monthly quota (HTTP 402)", `provider error formatted: ${String(diag)}`);
    c.check(
      !String(diag).includes("SHOULD-NOT-BE-QUOTED"),
      "provider error: response body/headers are NOT stringified into the message",
    );
    c.check(
      finalAssistantError(multiMessageTurn) === undefined,
      "provider error: a healthy turn reports nothing rather than inventing a cause",
    );
    c.check(
      finalAssistantError({ messages: [user("q1"), rejected(), user("q2"), answered("fine")] }) === undefined,
      "provider error: an EARLIER turn's error is not attributed to this turn",
    );
    // Untrusted third-party text: bounded and flattened to one line.
    const noisy: SessionHistory = {
      messages: [
        user("q"),
        {
          role: "assistant",
          info: {
            role: "assistant",
            error: { name: "APIError", data: { message: `line1\nline2\t${"x".repeat(500)}` } },
          } as Record<string, unknown>,
          parts: [] as Array<Record<string, unknown>>,
        },
      ],
    };
    const flat = finalAssistantError(noisy) ?? "";
    c.check(!/[\n\t]/.test(flat), "provider error: control characters are stripped, not passed through");
    c.check(flat.length <= 301, `provider error: bounded (${flat.length} chars)`);
  }

  console.log(`client.test: ${c.passes} passed, ${c.failures} failed`);
  return c.failures;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().then((f) => process.exit(f > 0 ? 1 : 0));
}
