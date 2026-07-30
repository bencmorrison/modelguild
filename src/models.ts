/**
 * `guild_models` — enumerate the running serve's AUTHED PROVIDER CONFIGURATION.
 *
 * IT IS NOT A REACHABILITY LIST, AND THIS FILE USED TO SAY IT WAS (issue #117, maintainer
 * report 2026-07-30). The set is per-PROVIDER, not per-model entitlement: a GitHub Copilot
 * subscription authenticates the provider, and the config then lists model ids that
 * subscription is not entitled to. Probed on 1.18.7 — five listed ids each completed a full
 * round-trip and came back with an EMPTY answer and `session error: The requested model is
 * not supported.` in the activity trace. What this tool answers is "which ids can be named",
 * not "which ids will answer".
 *
 * NO FILTER IS OFFERED, and the payload's own `status` field is the reason it cannot be one.
 * `/config/providers` carries a per-model `status`; re-probed 2026-07-30 it had exactly ONE
 * value across the entire payload — `active`, 25 of 25 — so it partitions nothing and a filter
 * on it would remove no id while claiming to have checked. **An earlier version of this comment
 * said something stronger and FALSE** — that `active` was read "including ids that had failed at
 * call time earlier the same day" — which the next sentence contradicted, because those five ids
 * were **absent** from that payload entirely and so were never observed carrying any status at
 * all. (Provenance: the error was the coordinating Claude's, in the brief this file was written
 * against; corrected 2026-07-30. It matters because the false claim was the *sole* stated
 * justification for offering no filter, and the true observation is a better one.) A static list
 * in this repo is worse: the catalog moved within hours of the issue being filed (39 ids at
 * filing, 25 at the probe, and all five failing ids simply gone), so a shipped denylist would be
 * stale on arrival and would start withholding ids the user has. Probe-and-cache costs a call
 * per model and goes stale the same way. So the honest fix is the description: this enumerates
 * configuration, and an unreachable id is caught at CALL time — how loudly depends on the tool.
 * An id absent from the catalog answers HTTP 500 ⇒ `call-failed`, everywhere. A LISTED id the
 * provider rejects ends the turn empty, and only the READ tools refuse that (`empty-answer`,
 * C74); `guild_delegate` does not opt in, so there it is `ok:true` with an empty `report` and a
 * null `patchPath` — silent, by design, because an empty report beside a real patch is a
 * successful delegation and this path cannot tell the two apart.
 *
 * This is the LAST thing the migrated command docs shelled out to the `opencode`
 * binary for (`Bash(opencode models:*)`): a read-only enumeration of the caller's
 * authed provider/model ids, so the driver can pick a panel/consult model without a
 * subprocess. No policy interaction, no model call — it only reads a control-plane
 * endpoint of the already-running serve.
 *
 * SOURCE: `GET /config/providers` on the live `opencode serve`. Verified live on
 * opencode 1.18.4 to return EXACTLY the same 19 ids as `opencode models` (byte-for-byte
 * after sort), plus a per-provider `default` map that the CLI does not surface. The
 * fuller `/provider` endpoint is the whole 4 MB registry (every model opencode knows of,
 * authed or not) — the wrong set to show a user, so `/config/providers` (authed only) is
 * deliberately the source. The serve is already supervised by the lifecycle, so this
 * adds no process and no auth beyond what `opencode serve` already holds.
 */

import type { ServeHandle } from "./lifecycle.js";
import type { McpToolResult } from "./consult.js";

/** The minimal serve dependency: run `fn` against a ready serve (the lifecycle). */
export interface ServeRunner {
  withServe<T>(fn: (h: ServeHandle) => Promise<T>): Promise<T>;
}

const HTTP_MS = 10_000;

export interface ProviderInfo {
  /** Provider id, e.g. "openai". */
  id: string;
  /** Human-readable provider name, e.g. "OpenAI" (omitted if the endpoint has none). */
  name?: string;
  /** The provider's model ids as full `provider/model` specs, sorted. */
  models: string[];
  /** The provider's default model as a full `provider/model` spec, if opencode names one. */
  default?: string;
}

export interface ModelsResult {
  ok: boolean;
  /** Every authed model as a `provider/model` id, sorted. */
  models: string[];
  /** Per-provider grouping (id/name/models/default). */
  providers: ProviderInfo[];
  /** provider id → its default `provider/model` spec (only providers that name one). */
  defaults: Record<string, string>;
  /** Total model count (== models.length; convenience for the driver). */
  count: number;
  /** Present iff ok:false — the serve/HTTP failure that prevented enumeration. */
  error?: { message: string };
}

// The wire shape of GET /config/providers (only the fields we read; others ignored).
interface WireProvider {
  id?: unknown;
  name?: unknown;
  models?: unknown;
}
interface WireConfigProviders {
  providers?: unknown;
  default?: unknown;
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(HTTP_MS) });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GET ${url} → ${res.status} ${res.statusText} ${body}`.trim());
  }
  return res.json();
}

/**
 * Parse a `/config/providers` payload into the flat + grouped model views. Pure and
 * defensive: an entry with no `id` or no `models` object is skipped rather than throwing,
 * so a future/odd provider shape degrades to "fewer models listed", never a crash.
 *
 * The per-model `status` field is read by NOTHING here, deliberately — see the file header:
 * it carried one value (`active`) for every id in the payload, so it separates nothing and
 * filtering on it would be a guarantee this cannot make.
 */
export function parseProviders(raw: unknown): Omit<ModelsResult, "ok" | "error"> {
  const root = (raw ?? {}) as WireConfigProviders;
  const providersRaw = Array.isArray(root.providers) ? (root.providers as WireProvider[]) : [];
  const defaultMap =
    root.default && typeof root.default === "object"
      ? (root.default as Record<string, unknown>)
      : {};

  const providers: ProviderInfo[] = [];
  const allModels: string[] = [];
  const defaults: Record<string, string> = {};

  for (const p of providersRaw) {
    if (typeof p.id !== "string" || p.id.length === 0) continue;
    const providerId = p.id;
    const modelsObj =
      p.models && typeof p.models === "object" ? (p.models as Record<string, unknown>) : {};
    const ids = Object.keys(modelsObj)
      .map((modelId) => `${providerId}/${modelId}`)
      .sort();
    allModels.push(...ids);

    const info: ProviderInfo = { id: providerId, models: ids };
    if (typeof p.name === "string" && p.name.length > 0) info.name = p.name;
    const def = defaultMap[providerId];
    if (typeof def === "string" && def.length > 0) {
      const spec = `${providerId}/${def}`;
      info.default = spec;
      defaults[providerId] = spec;
    }
    providers.push(info);
  }

  providers.sort((a, b) => a.id.localeCompare(b.id));
  allModels.sort();
  return { models: allModels, providers, defaults, count: allModels.length };
}

/**
 * List the models in the running serve's authed provider config (NOT a reachability
 * claim — see the file header). Read-only; no policy, no model call.
 * A serve/HTTP failure is returned as `ok:false` with the error message (the tool
 * surfaces it as `isError`) rather than thrown, matching the other tools' shape.
 */
export async function models(deps: { serve: ServeRunner }): Promise<ModelsResult> {
  try {
    const parsed = await deps.serve.withServe(async (h) => {
      const raw = await fetchJson(`${h.baseUrl}/config/providers`);
      return parseProviders(raw);
    });
    return { ok: true, ...parsed };
  } catch (err) {
    return {
      ok: false,
      models: [],
      providers: [],
      defaults: {},
      count: 0,
      error: { message: (err as Error).message },
    };
  }
}

/**
 * Map a `ModelsResult` to the MCP wire shape. The text block is a human-readable,
 * provider-grouped listing (what the driver reads to pick a model); the full structured
 * data rides in `structuredContent` for programmatic use.
 */
export function modelsToToolResult(r: ModelsResult): McpToolResult {
  if (!r.ok) {
    const msg = `guild_models: could not list models — ${r.error?.message ?? "unknown error"}`;
    return {
      content: [{ type: "text", text: msg }],
      structuredContent: { error: r.error },
      isError: true,
    };
  }
  const lines: string[] = [];
  for (const p of r.providers) {
    const header = p.name ? `${p.name} (${p.id})` : p.id;
    lines.push(header + (p.default ? `  [default: ${p.default}]` : ""));
    for (const id of p.models) lines.push(`  ${id}`);
  }
  const text =
    r.count === 0
      ? "No models available. Run `opencode auth login` to authenticate a provider."
      : // "configured", not "available": the set is per-provider, so a listed id can still be
        // rejected at call time (issue #117). The text channel is what a human reads, so it
        // carries the caveat rather than leaving it in the tool description alone.
        `${r.count} model(s) in the authed provider config (per-provider, not per-model ` +
        `entitlement — a listed id may still be rejected by the provider at call time):\n` +
        lines.join("\n");
  return {
    content: [{ type: "text", text }],
    structuredContent: {
      models: r.models,
      providers: r.providers,
      defaults: r.defaults,
      count: r.count,
    },
  };
}
