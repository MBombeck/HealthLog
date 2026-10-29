/**
 * The model list a Codex sign-in is offered, read the way the official Codex
 * CLI reads it.
 *
 * A fixed preference list goes stale at every retirement: on 2026-10-14 every
 * model the shipped list named was retired for ChatGPT sign-in and Codex
 * answered 503 until a release changed the list. The backend says which
 * models an account may use, on the same sign-in as the responses call:
 *
 *   GET https://chatgpt.com/backend-api/codex/models?client_version=<x.y.z>
 *   Authorization: Bearer <access token>
 *   ChatGPT-Account-ID: <account id>
 *
 * Wire shape, from openai/codex `codex-rs/protocol/src/openai_models.rs`
 * (`ModelsResponse`, `ModelInfo`, `ModelVisibility`, `InputModality`), read
 * by `codex-rs/codex-api/src/endpoint/models.rs` (`ModelsClient`, which
 * appends `client_version`) under the 5 s bound and per-account cache
 * identity of `codex-rs/model-provider/src/models_endpoint.rs` and
 * `models_identity.rs`:
 *
 *   { "models": [ { "slug": "gpt-6-luna", "visibility": "list",
 *                   "supported_in_api": true, "priority": 4,
 *                   "input_modalities": ["text", "image"],
 *                   "model_specialty": null, ... } ] }
 *
 * Only the fields read below matter here; everything else in an entry (the
 * instruction templates make up most of a ~500 KB body) is ignored.
 *
 * The list is a hint, never a gate. A read that fails, times out, runs past
 * the size bound, does not parse or comes back empty leaves the client on
 * its built-in order, exactly as before the list existed. A failed read is
 * retried after `CODEX_CATALOG_RETRY_MS`, not on every request, and one
 * signal per sign-in reports the stretch.
 */
import { safeFetch, SafeFetchError } from "@/lib/safe-fetch";
import { readBodyCapped } from "@/lib/http/read-capped";
import { emitSignal } from "@/lib/logging/signal";
import {
  codexCredentialKey,
  getCodexCatalogState,
  setCodexCatalogState,
  type CodexCatalogState,
  type CodexCredential,
} from "./codex-slug-cache";

const CODEX_MODELS_ENDPOINT = "https://chatgpt.com/backend-api/codex/models";

/**
 * The `client_version` sent with the read. The backend leaves out models
 * whose `minimal_client_version` is above it (every gpt-6 entry in the
 * upstream `models-manager/models.json` names 0.153.0 or later), so a version
 * far behind the current Codex CLI hides the models an account actually has.
 * This is the Codex CLI release current when it was last checked
 * (rust-v0.165.0, 2026-10-27); move it when a new line needs a newer client.
 */
export const CODEX_MODELS_CLIENT_VERSION = "0.165.0";

/** Same bound as the Codex CLI's model refresh. */
const MODELS_TIMEOUT_MS = 5_000;
/** The upstream bundle is ~540 KB for twelve models. */
const MODELS_MAX_BYTES = 4 * 1024 * 1024;
/** More entries than any account has been offered; the rest are ignored. */
const MAX_MODELS = 200;
/** What a slug may look like before it goes into a request body or a log. */
const SLUG_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;

const ORIGINATOR = "healthlog";
const USER_AGENT = "HealthLog/1.0 (+https://github.com/MBombeck/HealthLog)";

/** One model the account is offered, reduced to what the client uses. */
export interface CodexOfferedModel {
  slug: string;
  /** `visibility: "list"`: shown in the Codex CLI's picker. */
  listed: boolean;
  /** The list's own order (lower first); null when the entry has none. */
  priority: number | null;
  /** `input_modalities`, or null when the entry does not say. */
  inputModalities: readonly string[] | null;
  /** `model_specialty` (e.g. a security-focused line), null for general models. */
  specialty: string | null;
}

/** Why a read of the list gave nothing usable. A closed set: it is log meta. */
export type CodexCatalogFailure =
  | "timeout"
  | "network"
  | "auth"
  | "http_error"
  | "too_large"
  | "unparsable"
  | "empty";

/** What one request learned about the list. */
export interface CodexCatalogRead {
  /** The offered models, or null when the list could not be used. */
  models: readonly CodexOfferedModel[] | null;
  /** Whether this request read the backend or used an earlier read. */
  from: "live" | "cache";
  failure: CodexCatalogFailure | null;
}

/** The access a read needs: the same sign-in as the responses call. */
export interface CodexCatalogAuth {
  accessToken: string;
  accountId: string;
}

/**
 * Parse a `/models` body. Returns null when the body is not the documented
 * envelope; entries without a usable slug are skipped, not fatal. An empty
 * array is returned as such and the caller treats it as unusable.
 */
export function parseCodexModelList(body: unknown): CodexOfferedModel[] | null {
  if (!body || typeof body !== "object") return null;
  const list = (body as { models?: unknown }).models;
  if (!Array.isArray(list)) return null;
  const seen = new Set<string>();
  const out: CodexOfferedModel[] = [];
  for (const raw of list.slice(0, MAX_MODELS)) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    const slug = typeof entry.slug === "string" ? entry.slug.trim() : "";
    if (!SLUG_SHAPE.test(slug) || seen.has(slug)) continue;
    seen.add(slug);
    const modalities = Array.isArray(entry.input_modalities)
      ? entry.input_modalities.filter((m): m is string => typeof m === "string")
      : null;
    out.push({
      slug,
      listed: entry.visibility === "list",
      priority:
        typeof entry.priority === "number" && Number.isFinite(entry.priority)
          ? entry.priority
          : null,
      inputModalities: modalities,
      specialty:
        typeof entry.model_specialty === "string" && entry.model_specialty
          ? entry.model_specialty
          : null,
    });
  }
  return out;
}

/** One read of the backend, never cached and never thrown out of. */
export async function fetchCodexModelList(
  auth: CodexCatalogAuth,
): Promise<
  | { ok: true; models: CodexOfferedModel[] }
  | { ok: false; reason: CodexCatalogFailure; status: number | null }
> {
  let res: Response;
  try {
    res = await safeFetch(
      `${CODEX_MODELS_ENDPOINT}?client_version=${CODEX_MODELS_CLIENT_VERSION}`,
      {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${auth.accessToken}`,
          "ChatGPT-Account-ID": auth.accountId,
          originator: ORIGINATOR,
          "User-Agent": USER_AGENT,
        },
      },
      { timeoutMs: MODELS_TIMEOUT_MS },
    );
  } catch (error) {
    const timedOut =
      (error instanceof SafeFetchError && error.kind === "timeout") ||
      (error instanceof Error && error.name === "TimeoutError");
    return {
      ok: false,
      reason: timedOut ? "timeout" : "network",
      status: null,
    };
  }
  if (!res.ok) {
    void res.body?.cancel().catch(() => {});
    return {
      ok: false,
      reason: res.status === 401 || res.status === 403 ? "auth" : "http_error",
      status: res.status,
    };
  }
  let text: string;
  try {
    const read = await readBodyCapped(res, MODELS_MAX_BYTES);
    if (!read.ok) return { ok: false, reason: "too_large", status: res.status };
    text = read.text;
  } catch (error) {
    // The timeout signal also covers the body; a stall mid-body lands here.
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    return {
      ok: false,
      reason: timedOut ? "timeout" : "network",
      status: res.status,
    };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, reason: "unparsable", status: res.status };
  }
  const models = parseCodexModelList(json);
  if (models === null) {
    return { ok: false, reason: "unparsable", status: res.status };
  }
  if (models.length === 0) {
    return { ok: false, reason: "empty", status: res.status };
  }
  return { ok: true, models };
}

/** Reads in flight, one per sign-in, so a burst of requests reads once. */
const inflight = new Map<string, Promise<CodexCatalogRead>>();

/**
 * The account's model list for this sign-in: a trusted earlier read when
 * there is one, else one bounded read of the backend shared by every request
 * that asks meanwhile.
 *
 * An expired token (401) is not remembered: the responses call refreshes it
 * on its own 401, and the next request reads the list with the new one.
 * Every other failure is remembered for `CODEX_CATALOG_RETRY_MS`.
 */
export function readCodexModelCatalog(
  credential: CodexCredential,
  auth: CodexCatalogAuth,
): Promise<CodexCatalogRead> {
  const state = getCodexCatalogState(credential);
  if (state?.kind === "offered") {
    return Promise.resolve({
      models: state.models,
      from: "cache",
      failure: null,
    });
  }
  if (state?.kind === "unreadable") {
    return Promise.resolve({
      models: null,
      from: "cache",
      failure: state.reason,
    });
  }
  const pending = inflight.get(credential.key);
  if (pending) return pending;
  const read = fetchCodexModelList(auth)
    .then((result): CodexCatalogRead => {
      if (result.ok) {
        setCodexCatalogState(credential, {
          kind: "offered",
          models: result.models,
          at: Date.now(),
        });
        return { models: result.models, from: "live", failure: null };
      }
      if (result.status !== 401) {
        const first = setCodexCatalogState(credential, {
          kind: "unreadable",
          reason: result.reason,
          at: Date.now(),
        });
        if (first) {
          emitSignal({
            action: "ai.codex.models_unreadable",
            level: "warn",
            meta: {
              connection:
                credential.key === codexCredentialKey.central
                  ? "central"
                  : "personal",
              reason: result.reason,
              status: result.status,
            },
          });
        }
      }
      return { models: null, from: "live", failure: result.reason };
    })
    .finally(() => {
      if (inflight.get(credential.key) === read) {
        inflight.delete(credential.key);
      }
    });
  inflight.set(credential.key, read);
  return read;
}

/** The offered models from an earlier read, without touching the network. */
export function cachedCodexModels(
  credential: CodexCredential,
  now: number = Date.now(),
): readonly CodexOfferedModel[] | null {
  return offeredModels(getCodexCatalogState(credential, now));
}

/** The models a list read offered, or null when it offered none. */
export function offeredModels(
  state: CodexCatalogState | null,
): readonly CodexOfferedModel[] | null {
  return state?.kind === "offered" ? state.models : null;
}
