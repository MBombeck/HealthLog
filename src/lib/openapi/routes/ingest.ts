/**
 * OpenAPI route table — the external medication-ingest endpoint.
 *
 * Part of the OpenAPI route table; aggregated in `./index.ts`. The request
 * body is the runtime `externalIntakeSchema`; the response is the shared
 * `MedicationIntakeEvent` resource the medications module already publishes,
 * so the two surfaces cannot describe the same row differently.
 *
 * This route is its own module because its AUTH is its own thing. It is one
 * of the three surfaces that resolve a Bearer token OUTSIDE `requireAuth`
 * (`src/__tests__/bearer-scope-enforcement-guard.test.ts` freezes the set),
 * and it is the only one that a home-automation bridge is meant to call. So
 * the token rules it applies are written out here rather than left to the
 * generic security scheme: no cookie session reaches it, and the scope check
 * is a two-stage one the other Bearer surfaces do not have.
 */
import type { ZodOpenApiObject } from "zod-openapi";

import { externalIntakeSchema } from "@/lib/validations/medication";
import { repeatedIntakeEventResource } from "./medications/schemas";
import { dataEnvelope, errorEnvelope, stdResponses } from "./shared";

const externalIntakeRequest = externalIntakeSchema.meta({
  id: "ExternalMedicationIntakeRequest",
  description:
    "An externally-observed dose. `medicationName` is matched case-insensitively against the token owner's ACTIVE medications — there is no id form on this surface. `takenAt` is optional and defaults to now, bounded by the same plausibility range the interactive create paths use. `idempotencyKey` is an identity, not a windowed replay token: it is stored on the row forever and matched by equality. Derive one key per take (for example from the take's time) and reuse it only to retry that same request: a fixed key records the first dose and answers every later one as a replay of it, and a key that rotates per client launch logs a re-sent dose again. There is no `scheduledFor`; the slot is resolved from `takenAt`.",
});

export const ingestPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/ingest/medication": {
    post: {
      tags: ["Medications"],
      summary: "Record a dose from an external integration",
      description:
        "Logs a medication intake from outside the app — a chat bridge, a home-automation rule, a button on a shelf.\n\n**Auth is Bearer only.** A cookie session does not authenticate here: the route reads the `Authorization` header itself, hashes it and looks the token up, so a browser with a valid login and no token gets 401. The token must carry either the `*` wildcard or the `medication:ingest` scope — AND, once the named medication resolves, either `*` or that medication's own `medication:{id}:ingest` scope. The second check runs after the lookup. An unknown name and a name outside the token's scope both answer the same 404 (`ingest.medication.notFound`), so a scoped token cannot learn which medications exist.\n\n**The operator can switch this off.** With the global API kill switch disabled every request is refused with 403 before the token is even read.\n\n**Replay is by `idempotencyKey`, and the status says which happened.** A key already stored for this token's owner and the same medication, written within the last day, returns the existing row with **200**; a fresh dose returns **201**; a key already used for another medication returns **409** without its row. Replay is answered only after both scope checks. Nothing else distinguishes them — same body shape, same fields — so branch on the status code.\n\n**A dose is attributed to its scheduled slot, not stamped ad-hoc.** When the take falls inside a schedule's window band it converges onto that slot's canonical row (closing the pending reminder rather than leaving it open beside a duplicate ad-hoc take); outside every band it answers the nearest slot of the same local day within six hours when that slot is still open (and never reaches past a nearer slot that is already answered); otherwise it lands as a standalone row with `scheduledFor = takenAt`. A take of a slot that already holds a take within two hours is the same dose reported twice and answers 200 with `alreadyTaken: true`. Only a genuine pending-to-taken transition consumes inventory, so a re-post that converges onto an already-taken slot does not decrement stock twice.\n\nRate-limited to 60 requests per minute **per token**. A household running a chat bridge, a button and a home-automation rule gets three independent allowances rather than three shares of one, which is what the previous per-IP bucket gave them. A request that presents no valid token falls back to a per-IP bucket with the same ceiling, so an unauthenticated flood is still capped.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: externalIntakeRequest } },
      },
      responses: {
        "201": {
          description: "The dose was recorded. Body is the created row.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                repeatedIntakeEventResource,
                "ExternalMedicationIntakeCreatedEnvelope",
              ),
            },
          },
        },
        "200": {
          description:
            "Replay: a row with this `idempotencyKey` already exists for the token's owner and is returned unchanged. Or a repeat: the slot this take binds to already holds a take recorded within two hours of it, and the body is that row with `alreadyTaken: true`. Either way nothing was written and no inventory was consumed.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                repeatedIntakeEventResource,
                "ExternalMedicationIntakeReplayEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
        "401": {
          description:
            "No `Authorization: Bearer …` header, or a token that is unknown, revoked or past its expiry. The three cases are not distinguished on the wire, and all four are charged to the per-IP bucket rather than to any token.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "403": {
          description:
            "Refused. Either the operator has the global API switch off (the message says so), or the token lacks `medication:ingest` / `*`.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "404": {
          description:
            "No ACTIVE medication of the token owner's that this token may record matches `medicationName` (`errorCode: ingest.medication.notFound`). The name is matched case-insensitively with surrounding and repeated whitespace folded (`\"Ramipril \"` finds `Ramipril`); `Ramipril 5 mg` does not. An unknown name and one outside the token's scope give the same answer.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "409": {
          description:
            "The `idempotencyKey` is already stored for a dose of another medication, or (`ingest.idempotencyKey.reused`) for a take of this one recorded more than a day ago: a fixed key reused for a new take. Nothing was written and that dose is not returned.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "413": {
          description: "Body exceeds 64 KiB.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "415": {
          description: "`Content-Type` is not `application/json`.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "422": {
          description:
            "Validation failed, with every issue listed rather than the first — an integration operator should see the whole shape at once. An empty or unstable `idempotencyKey` fails here: the column is unique table-wide, so an empty key would resolve to whichever unrelated row stored it first. Also 422 with `meta.errorCode` = `medication.intake.notTracked` (v1.42.0) when the named medication is kept as a record only (`trackIntake: false`); checked after the token's scope, so a token without this medication's scope learns nothing about it.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "429": {
          description:
            "More than 60 requests in a minute for this token — or, when no valid token was presented, from this client IP. `meta.errorCode` = `ingest.rate_limited`, plus the standard rate-limit headers: `Retry-After` (whole seconds, at least 1), `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset`.",
          content: { "application/json": { schema: errorEnvelope } },
        },
      },
    },
  },
};
