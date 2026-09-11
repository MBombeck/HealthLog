/**
 * Shared OpenAPI building blocks — response envelopes and standard error responses used across every route module.
 *
 * Part of the OpenAPI route table; aggregated in `./index.ts`.
 * Schemas come from `src/lib/validations/*` where shared with the
 * runtime request parsing, so the wire contract stays single-source.
 */
import { z } from "zod/v4";

import { renderErrorCodeCatalogue } from "../error-codes";
import {
  createMeasurementSchema as createMeasurementSchemaBase,
  listMeasurementsSchema as listMeasurementsSchemaBase,
  measurementTypeEnum as measurementTypeEnumBase,
  measurementSourceEnum as measurementSourceEnumBase,
} from "@/lib/validations/measurement";
import { loginPasswordSchema as loginPasswordSchemaBase } from "@/lib/validations/auth";
import { coachPrefsSchema as coachPrefsSchemaBase } from "@/lib/validations/coach-prefs";
import { createBatchWorkoutSchema as createBatchWorkoutSchemaBase } from "@/lib/validations/workout";

/**
 * Common envelopes — every HealthLog API response wraps payload in
 * `{ data, error, meta? }`. The OpenAPI surface mirrors that contract
 * so iOS / external-ingest clients can decode uniformly.
 */
/**
 * One rejected field from a multi-issue 422.
 *
 * `returnAllZodIssues` has emitted this since v1.4.42 so a client can fix
 * three bad fields in one round-trip instead of three, and 166 route files
 * send it — but no component schema declared it, so the very consumer it was
 * built for could not read it from the contract. `params` never ships: some
 * Zod codes embed the offending value in it and that is user content.
 */
const validationIssue = z
  .object({
    path: z
      .string()
      .describe(
        "Dot-joined path to the rejected field, e.g. `entries.3.measuredAt`. Empty string when the whole body was rejected.",
      ),
    code: z
      .string()
      .describe(
        "Zod issue code, e.g. `invalid_type`, `too_small`, `unrecognized_keys`. Treat an unfamiliar code as a generic rejection of `path`.",
      ),
    message: z
      .string()
      .describe(
        "English sentence describing the rejection. Safe to log; show the user your own wording keyed on `path`.",
      ),
    keys: z
      .array(z.string())
      .optional()
      .describe(
        "Only on `unrecognized_keys`: the refused key names, bounded to 10 and 64 characters each. Zod reports every unknown key of one object in a single issue whose `path` is the object, so the names live here and nowhere in `path`.",
      ),
  })
  .meta({
    id: "ValidationIssue",
    description:
      "One rejected field in a multi-issue 422. Sanitised: no rejected VALUE is echoed back.",
  });

export const errorEnvelope = z
  .object({
    data: z.null(),
    error: z.string(),
    details: z
      .object({ issues: z.array(validationIssue) })
      .optional()
      .describe(
        "Present on a 422 raised by the multi-issue validator: every field the request got wrong, not only the first. Absent on every other status.",
      ),
    // Loose on purpose. Real refusals put more than the two named keys here —
    // `removedIn` / `replacedBy` on a 410, `module` beside `module.disabled`,
    // the per-integration context on a failed connection test — and a closed
    // object made the body invalid against its own published schema, which any
    // strict generated decoder is entitled to reject.
    meta: z
      .looseObject({
        requestId: z.string().optional(),
        errorCode: z
          .string()
          .optional()
          .describe(
            "Stable machine code for this refusal. Branch on it rather than on `error`, which is prose and may be reworded. Every code the API emits today is enumerated below, grouped by the surface that emits it; four naming conventions coexist and none of them will be renamed, because a code is a wire value a shipped client branches on. Treat an unlisted code the way you would treat an unlisted enum member — as a refusal you do not recognise, not as a malformed response — since the list grows with the surfaces. Three families are outside it on purpose: `assistant.disabled.<surface>` is built from a template so the last segment is open (`assistant.disabled.coach` is the one the native client names); the integration-probe classes (`credentials_rejected`, `rate_limited`, `upstream_error`, `timeout`, `connection_failed` and the per-provider additions) are enumerated in each `/test` operation instead, where the differences can be stated; and a 401 raised by a route checking a credential of its own may carry no code at all. " +
              renderErrorCodeCatalogue(),
          ),
      })
      .optional(),
  })
  .meta({
    id: "ErrorEnvelope",
    description:
      "Standard error response: `data` is null, `error` is human prose. `meta.errorCode` carries the stable machine code where one exists, and `meta` may carry further per-refusal context. A 422 from the multi-issue validator additionally carries `details.issues` — every field the request got wrong, so a client can fix them in one round-trip.",
  });

export function dataEnvelope<T extends z.ZodType>(payload: T, id: string) {
  return z
    .object({
      data: payload,
      error: z.null(),
      meta: z.object({ requestId: z.string().optional() }).optional(),
    })
    .meta({ id });
}

// ── Schemas — annotated for spec emission ────────────────────────────
//
// `.meta()` CLONES in Zod 4 rather than annotating in place, so the returned
// schema has to be captured and referenced: a bare `schema.meta({...})`
// statement registers nothing and the component id it names never reaches the
// emitted document. These seven are shared across route modules, so the
// annotated clone is exported from here under the name the use sites already
// spell and the base import is aliased. A module that wants the published
// form imports it from `./shared`; importing the raw schema from
// `@/lib/validations/*` instead is what inlined these anonymously.

export const measurementTypeEnum = measurementTypeEnumBase.meta({
  id: "MeasurementType",
  description:
    "DB-stored measurement category. v1.4.23 added 7 Apple Health values (HRV, resting HR, active energy, flights, walking/running distance, VO2 max, body temperature).",
});

export const measurementSourceEnum = measurementSourceEnumBase.meta({
  id: "MeasurementSource",
  description:
    "Origin of the measurement. v1.4.23 added APPLE_HEALTH for the iOS HealthKit batch ingest path.",
});

export const loginPasswordSchema = loginPasswordSchemaBase.meta({
  id: "LoginPasswordRequest",
  description:
    "Email-or-username login. The native-client flow returns a paired access + refresh token when X-Client-Type: native or the iOS UA prefix is present.",
});

export const createMeasurementSchema = createMeasurementSchemaBase.meta({
  id: "CreateMeasurementRequest",
  description:
    "Single-measurement ingest body. Plausibility-range guard runs server-side; out-of-range values fail 422. `glucoseContext` stays REQUIRED on a `BLOOD_GLUCOSE` row here: this is the hand-entry surface, where the person taking the reading knows whether it was fasting or after a meal. The bulk ingest paths (CSV import, JSON import, device sync) accept a contextless reading, because a sensor export classifies nothing per sample.",
});

export const listMeasurementsSchema = listMeasurementsSchemaBase.meta({
  id: "ListMeasurementsQuery",
  description:
    "Query params for the measurements list endpoint. `limit` capped at 500.",
});

export const coachPrefsSchema = coachPrefsSchemaBase.meta({
  id: "CoachPrefs",
  description:
    "Per-user Coach prompt-tuning preferences (v1.4.23 H4). All fields default to the legacy v1.4.22 behaviour when omitted.",
});

export const createBatchWorkoutSchema = createBatchWorkoutSchemaBase.meta({
  id: "CreateBatchWorkoutRequest",
  description:
    "Typed workout batch ingest. Each entry is an HKWorkout-aligned record with an optional nested GeoJSON LineString route AND an optional route-independent per-workout heart-rate series (`samples`: `[{ t, hr?, speedMs?, power?, cadence? }]`, up to 30 000 points). The `samples` series is the strain-engine input for indoor workouts that have no GPS route. Up to 100 workouts per call; nested route geometry capped at 20 000 points. Withings server-to-server callers pass source: WITHINGS and ship no route (Withings reports aggregates only).",
});

// ── Optimistic concurrency (v1.32.21 / R5a) ──────────────────────────
// The write endpoints that read-modify-write a per-user blob accept an
// optional `baseUpdatedAt` base token (the `updatedAt` the client last
// read) and guard the write on the stored row still carrying it. A stale
// token fails the write with 409 and changes nothing; an omitted token
// takes the prior unconditional write (backward-compatible). The token is
// OPAQUE — clients only ever echo a server-returned value.

/**
 * Optional request field carrying the optimistic-concurrency base token.
 * Extend a request schema with `{ baseUpdatedAt: baseUpdatedAtField }` at the
 * OpenAPI layer: the runtime strips it pre-Zod (`takeBaseToken`), so the
 * runtime schema alone would under-document the wire.
 */
export const baseUpdatedAtField = z.iso
  .datetime({ offset: true })
  .optional()
  .describe(
    "Optimistic-concurrency base token: the `updatedAt` the client last read for this resource. Omit it for the legacy unconditional write (older clients are unaffected). When present, the write is guarded on the stored row still carrying this exact value — a stale token fails with 409 and changes nothing. A present-but-unparseable value fails with 422 and `meta.errorCode` = `invalid_base_updated_at` — note that this is NOT the unconditional write: sending `null` or a malformed string is rejected rather than treated as an omitted token. Treat as opaque: only ever echo a server-returned value, never parse or synthesise it.",
  );

/**
 * Optional response field echoing the fresh optimistic-concurrency token.
 * Every guarded GET / write response carries the stored row's `updatedAt`; the
 * client echoes it back as `baseUpdatedAt` on the next write.
 */
export const updatedAtTokenField = z.iso
  .datetime({ offset: true })
  .optional()
  .describe(
    "Optimistic-concurrency token: the stored row's `updatedAt` at read/write time. Echo it back as `baseUpdatedAt` on the next write. Opaque — only ever echo a server-returned value, never parse or synthesise it.",
  );

/**
 * The 409 the guarded write returns when the base token is stale. `errorCode`
 * is per-endpoint; the caller passes the resource noun + the concrete
 * errorCode so the prose enumerates it.
 */
export function conflictResponse409(resource: string, errorCode: string) {
  return {
    "409": {
      description: `${resource} changed since it was loaded (optimistic-concurrency conflict). No write happened. Re-read the resource, re-apply the user's change against the fresh state, and resend with the new token. \`meta.errorCode\` = \`${errorCode}\`.`,
      content: { "application/json": { schema: errorEnvelope } },
    },
  };
}

/**
 * The 422 a malformed `baseUpdatedAt` earns, for the write endpoints that
 * accept the token in their body.
 *
 * Spread AFTER `...stdResponses` — the generic 422 there would otherwise
 * overwrite this one and the errorCode would vanish from the contract.
 *
 * Worth stating outright because the shape surprises implementers: an
 * unparseable token is NOT silently downgraded to the unconditional write.
 * `null`, an empty string and a non-ISO string all 422. The unconditional
 * write is reached by OMITTING the key, nothing else. `invalid_base_updated_at`
 * had lived only in route tests since v1.32.21, so a client had no way to
 * learn this from the published spec.
 */
export const invalidBaseTokenResponse = {
  "422": {
    description:
      "Request validation failed. When the body carried a `baseUpdatedAt` that could not be parsed as an ISO-8601 timestamp — including an explicit `null` — `meta.errorCode` = `invalid_base_updated_at` and nothing was written. Omit the key entirely for the unconditional write; do not send `null` for it.",
    content: { "application/json": { schema: errorEnvelope } },
  },
};

/**
 * The 400 an unparseable JSON body earns.
 *
 * `safeJson` has answered 400 for a body that will not parse since it was
 * written, and roughly two hundred and twenty routes go through it — but seven
 * `/api/auth/me/*` writes hand-rolled the parse and answered 422, so a client's
 * "my serializer produced garbage" branch had to accept two statuses on a
 * subset of routes it could not predict. They answer 400 now, and this is the
 * response that says so. The dotted token each route already carried moved to
 * `meta.errorCode`, where a machine code belongs.
 *
 * Spread only on the operations that hand-rolled the parse. It is deliberately
 * NOT folded into `stdResponses`: that set is spread onto reads as well, and a
 * GET that accepts no body has no malformed body to refuse.
 */
export const malformedJsonResponse = {
  "400": {
    description:
      "The request body is not parseable JSON. Nothing was read and nothing was written. `meta.errorCode` names the surface that refused it (`<surface>.body.invalid_json`). This is a client-side serialisation fault, not a validation failure — a body that parses but fails the schema is the 422 beside this.",
    content: { "application/json": { schema: errorEnvelope } },
  },
};

// ── Standard 401 / 422 / 429 responses ───────────────────────────────

export const stdResponses = {
  "401": {
    description:
      "Authentication required or invalid credentials. The generic auth gates — the ones every route passes through before its own body runs — name the reason in `meta.errorCode`, and that is the field to branch on there; the English sentence beside it may be reworded or localised at any time. `auth.missing`: no session cookie and no Bearer header; send the user to sign in. `auth.token.expired`: the Bearer token's lifetime has passed; refresh and retry the request. `auth.token.invalid`: unknown, revoked, or the owning account is gone; discard the credential and sign in again — retrying will not help. `auth.mfa.code_invalid`: a second factor presented on a step-up flow did not verify; re-prompt for a code and keep the session. The related 403 refusals carry `auth.scope.insufficient` (the credential is valid but its scope does not reach this route, including any Bearer token against an admin surface) and `auth.admin.required` (a cookie session that is not an admin's). A route that checks a credential of its own — sign-in, the MFA challenge exchange, a password confirmation — may still answer 401 with prose and no code, so a missing `meta.errorCode` means the route refused the credential it was handed, not that the response is malformed.",
    content: { "application/json": { schema: errorEnvelope } },
  },
  "422": {
    description: "Request validation failed.",
    content: { "application/json": { schema: errorEnvelope } },
  },
  "429": {
    description:
      "Rate limit exceeded. The response carries `Retry-After` (whole seconds, rounded up and never below 1 — wait at least that long before retrying), `X-RateLimit-Limit` (the bucket's cap), `X-RateLimit-Remaining` and `X-RateLimit-Reset` (the reset instant, ISO-8601, not epoch seconds). Back off on `Retry-After` rather than guessing. A 429 raised by a ceiling that is not one of these buckets — a daily AI budget, an upstream provider's own refusal relayed onward — carries none of them, because there is no bucket to describe.",
    content: { "application/json": { schema: errorEnvelope } },
    // Declared rather than only described: a generated client gets a typed
    // accessor for the field the description tells it to back off on.
    headers: {
      "Retry-After": {
        description:
          "Whole seconds to wait before retrying. Rounded up, never below 1.",
        schema: { type: "integer" as const, minimum: 1 },
      },
      "X-RateLimit-Limit": {
        description: "Requests the bucket allows per window.",
        schema: { type: "integer" as const, minimum: 1 },
      },
      "X-RateLimit-Remaining": {
        description: "Requests left in the current window; 0 on a refusal.",
        schema: { type: "integer" as const, minimum: 0 },
      },
      "X-RateLimit-Reset": {
        description:
          "Instant the current window rolls over, ISO-8601 — not epoch seconds.",
        schema: { type: "string" as const, format: "date-time" },
      },
    },
  },
};

/**
 * The 429 the shared single-record write bucket answers with.
 *
 * The batch endpoints have been capped at 60 calls a minute since they were
 * written and the per-record siblings were not capped at all, which is exactly
 * backwards: the batch endpoint is the one a well-behaved client uses. The
 * eleven single-record creates now share one generous per-account bucket, and
 * this is the response that names it — a client that meets a ceiling should be
 * able to read which one it met without a bug report.
 *
 * Spread AFTER `...stdResponses` so it replaces the generic 429 on those
 * operations. The headers block is the one the standard 429 already declares.
 *
 * `record-write-rate-limit-contract.test.ts` holds the numbers in this sentence
 * to the constants in `src/lib/rate-limit.ts`, so the paragraph cannot drift
 * away from the bucket it describes.
 */
export const recordWriteRateLimitResponse = {
  "429": {
    description:
      "Rate limit exceeded. This route shares one per-account bucket with the other single-record writes — `record-write:<accountId>`, 300 requests per 60 seconds — keyed on the ACTING account, so a delegate burns their own allowance rather than the record owner's. Nothing was written. `meta.errorCode` is `record_write.rate_limited`, which is what tells this refusal apart from a route's own narrower bucket when both can answer 429. The `Retry-After`, `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset` headers describe that bucket; back off on `Retry-After` rather than guessing. Every request counts against the bucket, refused ones included: the check runs before the body is read, so a client looping on a 422 spends the same allowance as one that writes rows. A client with more than a handful of rows to send should use the batch endpoint for its domain instead of looping this one.",
    content: { "application/json": { schema: errorEnvelope } },
    headers: stdResponses["429"].headers,
  },
};

/**
 * The 429 the profile email-address bucket answers with.
 *
 * Changing the address asks whether another account already holds it, and the
 * answer is a 409 versus a 200 — an existence check over every address on the
 * instance, available to any signed-in caller. Neither route that reaches it
 * had a ceiling of any kind, and `apiHandler` supplies no default, so the
 * sweep was bounded only by the network. This is the response that names the
 * bucket now capping it.
 *
 * Spread AFTER `...stdResponses` so it replaces the generic 429 on those two
 * operations. The headers block is the one the standard 429 already declares.
 *
 * `profile-email-rate-limit-contract.test.ts` holds the numbers in this
 * sentence to the constants in `src/lib/rate-limit.ts`, so the paragraph
 * cannot drift away from the bucket it describes.
 */
export const profileEmailRateLimitResponse = {
  "429": {
    description:
      "Too many email-address changes, and the request asked for nothing else. The address change shares one per-account bucket across both profile routes — `profile-email:<accountId>`, 10 requests per 3600 seconds — keyed on the ACTING account, so an account cannot collect a fresh allowance by probing a different address. `meta.errorCode` is `profile.update.emailRateLimited`. Only a request whose `email` actually differs from the address on file is counted: re-saving a form that carries the unchanged address is free, and so is any update that does not touch `email` at all. A request that carries other fields beside the refused address does NOT get this response — it answers 200, saves those fields, and names `email` in `rejectedFields` with code `rate_limited`, so one spent budget cannot block an unrelated profile edit for an hour. The `Retry-After`, `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset` headers describe that bucket; back off on `Retry-After` rather than guessing.",
    content: { "application/json": { schema: errorEnvelope } },
    headers: stdResponses["429"].headers,
  },
};

// ── Idempotent writes ────────────────────────────────────────────────

/**
 * What a route wrapped in `withIdempotency` accepts and answers.
 *
 * The mechanism has worked since long before it was published: send
 * `Idempotency-Key` on a write, and a retry of the same key replays the first
 * response instead of doing the work twice. It was described in route comments
 * and nowhere a client could read it, so an app generated against the contract
 * had no way to know a retry was safe. This publishes it.
 *
 * Three things a client cannot infer and has to be told:
 *
 *   1. **A malformed key is ignored, not refused.** `getIdempotencyKey` tests
 *      `^[A-Za-z0-9_\-:.]{8,128}$` and returns null on a miss, so a key that is
 *      too short or carries a stray character is indistinguishable from sending
 *      none at all — the write proceeds, unprotected, with a 200. This is the
 *      one failure here that is silent, which is why it leads.
 *   2. **The replay is marked.** A response served from the cache carries
 *      `X-Idempotent-Replay: true`. Without reading it a client cannot tell a
 *      fresh 201 from a replayed one, which matters when the body reports what
 *      was created.
 *   3. **A concurrent duplicate is refused, not queued.** While the first
 *      request is still running, a second one under the same key gets 409 with
 *      `X-Idempotent-Replay: false` — the header is present in both directions
 *      precisely so the two cases are told apart. Retry after a delay.
 *
 * Scope, so nobody reads more into it than is there: only POST, PUT, PATCH and
 * DELETE are covered (`SUPPORTED_METHODS`), the key is scoped per user and per
 * `(method, path)`, and `isCachableStatus` refuses to cache 5xx or the
 * transient 401 / 403 / 408 / 429 — a retry after one of those runs for real.
 *
 * `src/__tests__/idempotency-contract-publication.test.ts` holds this to the
 * routes that actually wrap `withIdempotency`, in both directions, so a new
 * idempotent route that forgets to say so fails, and so does a claim here for
 * a route that dropped the wrapper.
 */
export const idempotencyKeyParameter = {
  name: "Idempotency-Key",
  in: "header" as const,
  required: false,
  schema: {
    type: "string" as const,
    pattern: "^[A-Za-z0-9_\\-:.]{8,128}$",
    minLength: 8,
    maxLength: 128,
  },
  description:
    "Makes this write safe to retry. Send the same key again and the first response is replayed rather than the work repeated, marked with `X-Idempotent-Replay: true`. A key that does not match the pattern is IGNORED rather than refused — the write then proceeds unprotected and looks exactly like a request that carried no key, so validate the key on your side. Scoped per user and per (method, path): the same key on a different route is a different key. While a first request under this key is still in flight, a second is refused with 409 rather than queued.",
};

/**
 * Response headers are Zod here, not an OpenAPI literal — `zod-openapi` types
 * `headers` as a `ZodObject` and emits the schema from it. Writing the literal
 * shape by hand typechecks nowhere and was the first thing this file got wrong.
 */
const idempotentReplayHeaders = z.object({
  "X-Idempotent-Replay": z.enum(["true", "false"]).meta({
    description:
      "`true` when this response was replayed from a stored one rather than produced now; `false` on the 409 that refuses a duplicate still in flight. Absent when the request carried no usable key.",
  }),
});

interface IdempotentConflictResponse {
  "409": {
    description: string;
    content: { "application/json": { schema: typeof errorEnvelope } };
    headers: typeof idempotentReplayHeaders;
  };
}

/**
 * The 409 an idempotent route answers while an earlier request under the same
 * key is still running, plus the replay header on the way back.
 *
 * Cached by identity like {@link recordRefusal} above, for the same reason: a
 * fresh object per call site would print this paragraph thirty-seven times.
 */
let idempotentConflictCache: IdempotentConflictResponse | null = null;

export function idempotentWrite(): IdempotentConflictResponse {
  if (idempotentConflictCache) return idempotentConflictCache;
  idempotentConflictCache = {
    "409": {
      description:
        "A request with this `Idempotency-Key` is already in progress. Nothing was written by this call. Retry after a short delay; the response carries `X-Idempotent-Replay: false` to separate it from a replay.",
      content: { "application/json": { schema: errorEnvelope } },
      headers: idempotentReplayHeaders,
    },
  };
  return idempotentConflictCache;
}

// ── The delegated-record refusal (v1.37.0) ───────────────────────────

/**
 * What a route that can act on somebody else's record answers when it may not.
 *
 * One string, published on every such path, byte for byte. The refusal carries
 * no reason on the wire and the description says why: a selector naming an
 * account that does not exist, one naming an account that granted nothing, a
 * grant whose sections do not reach the surface and a read grant on a write are
 * all the same status, the same code and the same bytes, because a
 * distinguishable refusal is an account-enumeration oracle for anybody with a
 * login. Ninety paraphrases of that would invite a client to tell them apart.
 *
 * `src/__tests__/openapi-sharing-denial.test.ts` recomputes the set of routes
 * that resolve through `requireRecordAuth` / `requireGuardianAuth` and holds
 * every one of them to this exact sentence.
 */
export const SHARING_ACCESS_DENIED_DESCRIPTION =
  "Refused: this request named a record the caller may not act on (`meta.errorCode` = `sharing.access.denied`). Byte-identical for an account that does not exist, an account that granted nothing, a grant whose sections do not reach this surface, and a read grant on a request that writes — the response carries no reason, so it is not an account-enumeration oracle. The reason reaches the record owner's activity feed and the operator's audit trail instead. On the cookie transport the same code answers one further case: a session that has entered a shared record and sends a request without its record-context assertion, which is a client older than the fence — leave the record and reload. A request that names no record but the caller's own never reaches this response, so a client that never switches and never sends the per-request account selector will not see it.";

/**
 * The OTHER sharing refusal, for a route that names no record at all.
 *
 * A route resolving through `requireAuth` serves the caller and only the
 * caller, and refuses outright while the browser is inside somebody else's
 * record rather than quietly answering with the caller's own rows. That
 * posture matters most on the routes where being wrong is unrecoverable — the
 * record wipe, the account deletion, the encrypted archive — and it was
 * documented nowhere on them. A client that switches records has to know which
 * of its calls stop working, and finding out by wiping the wrong record is not
 * a contract.
 *
 * One sentence, spliced onto whatever else the operation's 403 already says,
 * for the same reason the delegable refusal is one string: a paraphrase per
 * path invites a client to tell them apart.
 */
export const SHARING_NOT_PERMITTED_DESCRIPTION =
  "Refused: the request was made while the session is acting on another account (`meta.errorCode` = `sharing.not_permitted`). This operation resolves the CALLER and never a named record, so under a switch it refuses instead of quietly answering with the caller's own — leave the shared record first. No grant at any level opens it.";

/**
 * The 403 above, optionally sharing the status with the reasons a route already
 * refuses for.
 *
 * OpenAPI allows one response per status, so a module-gated delegable route
 * cannot publish two 403 objects. The other reasons come first, in their own
 * words, and the shared sentence is spliced on the end — which keeps it
 * byte-identical everywhere and keeps the module gate's own prose intact.
 *
 * Memoised by the composed text so identical responses are one object: the YAML
 * emitter aliases by identity, and a fresh object per call site would print
 * this paragraph a hundred and eighteen times.
 */
interface RefusalResponse {
  "403": {
    description: string;
    content: { "application/json": { schema: typeof errorEnvelope } };
  };
}

const refusalCache = new Map<string, RefusalResponse>();

export function recordRefusal(...alsoRefusesFor: string[]): RefusalResponse {
  const description = [...alsoRefusesFor, SHARING_ACCESS_DENIED_DESCRIPTION]
    .filter(Boolean)
    .join("\n\n");
  const cached = refusalCache.get(description);
  if (cached) return cached;
  const response = {
    "403": {
      description,
      content: { "application/json": { schema: errorEnvelope } },
    },
  };
  refusalCache.set(description, response);
  return response;
}

// ── AI-consent precondition (v1.16.13) ───────────────────────────────
// The server-managed AI-egress gate requires an active ConsentReceipt
// (`ai_full`, or the surface-specific `ai_insights_only` / `ai_coach`)
// before any health snapshot leaves for the operator's global LLM key.
// Interactive routes surface this as a 403 with
// `meta.errorCode = "consent.ai.required"`; clients render an inline
// grant-consent notice and call POST /api/consent/ai (or, on web, POST
// /api/consent/ai/web) to mint the receipt. BYOK / local / ChatGPT-OAuth
// chains are the user's own egress and never trip this gate.
//
// There is no `consentRequiredResponse` beside this description any more, and
// the absence is deliberate. Every route that could answer it is also a route
// the sharing fence can refuse, and OpenAPI allows one response per status, so
// the two 403s share a single description built by `recordRefusal(...)`. A
// second exported 403 body would be a second way to write the same operation.
export const AI_CONSENT_REQUIRED_DESCRIPTION =
  "AI consent required: no active ConsentReceipt for the server-managed provider. `meta.errorCode` = `consent.ai.required`. Mint a receipt via POST /api/consent/ai before retrying.";

// ── Module-disabled gate (v1.18.0) ───────────────────────────────────
// Every module-scoped route runs `requireModuleEnabled(userId, key)`,
// which returns a 403 when the account has the module turned off — even
// with a valid Bearer token. The envelope carries
// `meta.errorCode = "module.disabled"` and `meta.module` (the disabled
// module key) so the iOS retry classifier branches on it and the client
// can drop the whole surface. The errorEnvelope shape already declares
// `meta.errorCode`; `meta.module` is documented here in prose.
export const MODULE_DISABLED_DESCRIPTION =
  'Module disabled for this account: the user (or operator) has the module turned off. `meta.errorCode` = `module.disabled` and `meta.module` carries the disabled module key (e.g. "sleep"). Returned even for a valid Bearer token. Clients hide the whole module surface end-to-end rather than retry.';

export const moduleDisabledResponse = {
  "403": {
    description: MODULE_DISABLED_DESCRIPTION,
    content: { "application/json": { schema: errorEnvelope } },
  },
};

/**
 * What a device revocation actually removed.
 *
 * Two paths answer with this exact shape, because two routes are two doors onto
 * one `revokeDeviceCascade` call: `DELETE /api/devices/{id}` and
 * `DELETE /api/auth/me/devices/{id}`. They were documented independently and
 * each minted a component called `DeviceRevokeResponse`, which the emitter
 * refuses outright — one id cannot name two schemas. It lives here rather than
 * in either module so neither owns it and the next door onto the same call
 * finds it.
 *
 * The counts are the point. A client can tell the person how many credentials
 * were killed rather than only that something happened.
 */
export const deviceRevokeResponse = z
  .object({
    id: z.string(),
    revoked: z.literal(true),
    refreshTokensRevoked: z
      .number()
      .int()
      .describe("Refresh tokens the cascade revoked."),
    accessTokensRevoked: z
      .number()
      .int()
      .describe("Access tokens the cascade revoked."),
  })
  .meta({
    id: "DeviceRevokeResponse",
    description:
      "What the revocation cascade actually removed. The counts let a client say how many credentials were killed rather than only that something happened.",
  });
