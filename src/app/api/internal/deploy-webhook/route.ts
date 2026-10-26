import { envOr } from "@/lib/env";
import { createHmac, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { apiHandler } from "@/lib/api-handler";
import { annotate, getEvent } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import {
  apiError,
  getClientIp,
  isJsonContentType,
  readBodyText,
} from "@/lib/api-response";
import { dispatchLocalisedNotification } from "@/lib/notifications/dispatch-localised";
import { prisma } from "@/lib/db";

/**
 * Deploy-status webhook (v1.4.15).
 *
 * Coolify (Settings → Notifications → Webhook) calls this endpoint after
 * every deploy attempt. We verify the request via a shared secret in the
 * `X-Deploy-Webhook-Secret` header (timing-safe compare against
 * `process.env.DEPLOY_WEBHOOK_SECRET`), audit-log the event, and on
 * failure page the admin via Telegram if the channel is configured.
 *
 * Why a *separate* webhook for status when Coolify already has a deploy
 * trigger URL: the trigger is one-shot ("queue a deploy"); the status
 * comes back asynchronously when the container is healthy / fails to
 * start. Without this surface we lose visibility once the deploy is
 * fired — exactly the gap that produced v1.4.6..v1.4.14's manual
 * verification recipe (the maintainer had to SSH and check digests).
 *
 * Payload shape: Coolify sends a free-form JSON object whose exact
 * fields drift between beta releases. We treat it as `Record<string,
 * unknown>` and only extract a small set of well-known keys
 * (`status`, `application_name`, `application_uuid`, `deployment_uuid`,
 * `error`) defensively, falling back to "unknown" when missing. The
 * payload itself is stored in the audit-log `details` field so a
 * future Coolify upgrade that adds richer metadata becomes
 * automatically available without code change.
 */

interface CoolifyDeployPayload {
  status?: unknown;
  application_name?: unknown;
  application_uuid?: unknown;
  deployment_uuid?: unknown;
  error?: unknown;
  [key: string]: unknown;
}

interface NormalizedEvent {
  outcome: "success" | "failure" | "unknown";
  applicationName: string;
  applicationUuid: string | null;
  deploymentUuid: string | null;
  error: string | null;
  raw: CoolifyDeployPayload;
}

function asStringOr<T extends string | null>(
  value: unknown,
  fallback: T,
): string | T {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function classifyOutcome(status: unknown): NormalizedEvent["outcome"] {
  if (typeof status !== "string") return "unknown";
  const s = status.toLowerCase();
  // Coolify uses "success" / "finished" for happy path and
  // "failed" / "error" / "stopped" for unhappy. Anything else is
  // logged but doesn't trigger a Telegram page (avoids alert fatigue
  // on intermediate states like "queued" or "in_progress").
  if (s === "success" || s === "finished" || s === "succeeded")
    return "success";
  if (s === "failed" || s === "error" || s === "stopped" || s === "failure") {
    return "failure";
  }
  return "unknown";
}

function normalizePayload(payload: CoolifyDeployPayload): NormalizedEvent {
  return {
    outcome: classifyOutcome(payload.status),
    applicationName: asStringOr(payload.application_name, "unknown"),
    applicationUuid: asStringOr(payload.application_uuid, null),
    deploymentUuid: asStringOr(payload.deployment_uuid, null),
    error: asStringOr(payload.error, null),
    raw: payload,
  };
}

/**
 * Freshness and signature.
 *
 * The secret header alone cannot stop a replay: whoever holds a captured
 * request holds the secret it carries, and can send a fresh request of any
 * content. A timestamp beside it changed nothing, because the timestamp was
 * covered by nothing and could be rewritten with the rest. Earlier versions
 * called it replay protection; it was a staleness hint.
 *
 * A sender that can compute a signature authenticates without sending the
 * secret at all: `X-Deploy-Webhook-Signature: sha256=<hex>` is the
 * HMAC-SHA256, under `DEPLOY_WEBHOOK_SECRET`, of the timestamp header's
 * value, a dot, and the raw body, and the timestamp must lie within five
 * minutes. A capture of such a request is useless after the window and
 * reveals no secret.
 *
 *   - Default: a signed request is verified as above; an unsigned one
 *     authenticates with the secret header, as Coolify's stock sender does,
 *     and a timestamp it carries must still be fresh.
 *   - `DEPLOY_WEBHOOK_REQUIRE_TIMESTAMP=true`: what it has always meant, the
 *     secret header plus a fresh timestamp; an unsigned request without one
 *     is refused. It keeps a stale capture out, not a fresh forgery by
 *     someone who saw the secret. A signed request is accepted as above.
 *   - `DEPLOY_WEBHOOK_REQUIRE_SIGNATURE=true`: only a signed request is
 *     accepted; the secret header alone is refused. This is the setting
 *     that stops a replay. It has its own name so that an operator who set
 *     the timestamp flag, with a sender that adds a timestamp but cannot
 *     sign, keeps the behaviour they asked for.
 *
 * See docs/ops/deploy.md ("Deploy-status webhook") for the operator
 * guidance.
 */
const TIMESTAMP_WINDOW_MS = 5 * 60 * 1000;

function parseTimestamp(raw: string): number | null {
  // Unix seconds (10 digits covers 2001-2286) or milliseconds.
  if (/^\d{10}$/.test(raw)) return Number(raw) * 1000;
  if (/^\d{13}$/.test(raw)) return Number(raw);
  const iso = Date.parse(raw);
  return Number.isFinite(iso) ? iso : null;
}

function checkTimestampFreshness(
  request: NextRequest,
  now: number = Date.now(),
): { ok: boolean; reason?: string } {
  const raw = request.headers.get("x-deploy-webhook-timestamp");
  if (raw === null || raw === "") {
    return flagSet("DEPLOY_WEBHOOK_REQUIRE_TIMESTAMP")
      ? { ok: false, reason: "timestamp_missing" }
      : { ok: true };
  }
  const ts = parseTimestamp(raw);
  if (ts === null) return { ok: false, reason: "timestamp_invalid" };
  if (Math.abs(now - ts) > TIMESTAMP_WINDOW_MS) {
    return { ok: false, reason: "timestamp_outside_window" };
  }
  return { ok: true };
}

function flagSet(
  name: "DEPLOY_WEBHOOK_REQUIRE_TIMESTAMP" | "DEPLOY_WEBHOOK_REQUIRE_SIGNATURE",
): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  return value === "true" || value === "1";
}

/**
 * A signed request: the HMAC of `timestamp.body` under the shared secret,
 * with a fresh timestamp. Null when the request carries no signature.
 */
function verifySignature(
  request: NextRequest,
  rawBody: string,
  now: number = Date.now(),
): { ok: boolean; reason?: string } | null {
  const header = request.headers.get("x-deploy-webhook-signature");
  if (header === null) return null;
  const expected = process.env.DEPLOY_WEBHOOK_SECRET;
  if (!expected) return { ok: false, reason: "secret_unset" };
  const timestamp = request.headers.get("x-deploy-webhook-timestamp");
  if (!timestamp) return { ok: false, reason: "timestamp_missing" };
  const ts = parseTimestamp(timestamp);
  if (ts === null) return { ok: false, reason: "timestamp_invalid" };
  if (Math.abs(now - ts) > TIMESTAMP_WINDOW_MS) {
    return { ok: false, reason: "timestamp_outside_window" };
  }
  const mac = createHmac("sha256", expected)
    .update(`${timestamp}.${rawBody}`, "utf8")
    .digest("hex");
  const a = Buffer.from(`sha256=${mac}`, "utf8");
  const b = Buffer.from(header.trim(), "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "signature_mismatch" };
  }
  return { ok: true };
}

function hasValidSecret(request: NextRequest): boolean {
  const expected = process.env.DEPLOY_WEBHOOK_SECRET;
  if (!expected) {
    getEvent()?.addWarning("DEPLOY_WEBHOOK_SECRET not configured");
    return false;
  }
  const received = request.headers.get("x-deploy-webhook-secret");
  if (!received) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(received, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Reuse the `maybeAlertAdmins()` pattern from
 * `src/lib/integrations/status.ts` — fan out a SYSTEM_ALERT through the
 * existing dispatcher to every user whose role is ADMIN. The dispatcher
 * silently no-ops when no Telegram channel is configured, so this is
 * safe even on a first-deploy where the maintainer hasn't wired the bot yet.
 */
async function notifyAdminsOfFailure(event: NormalizedEvent): Promise<void> {
  const admins = await prisma.user.findMany({
    where: { role: "ADMIN" },
    select: { id: true },
  });

  if (admins.length === 0) {
    getEvent()?.addWarning(
      "No admin user configured to alert about deploy failure",
    );
    return;
  }

  // v1.4.27 — each admin sees the alert in their own User.locale.
  // The body is composed inside `dispatchLocalisedNotification` from
  // translation keys; the static "Error:" / "Deployment:" / "Logs:"
  // labels are emitted as a single param-substituted body key so all
  // six locale bundles can render them natively. The deployment-uuid
  // and error lines fall back to an empty string when missing so the
  // surrounding template still composes cleanly.
  for (const admin of admins) {
    await dispatchLocalisedNotification({
      userId: admin.id,
      titleKey: "notifications.admin.deployFailedTitle",
      messageKey: "notifications.admin.deployFailedBody",
      params: {
        application: event.applicationName,
        error: event.error ?? "",
        deployment: event.deploymentUuid ?? "",
        // Optional: operators can point this at their deployment
        // dashboard (e.g. the Coolify UI). Falls back to an empty
        // string so the body template still composes cleanly.
        logsUrl: envOr("DEPLOY_LOGS_URL", ""),
      },
      metadata: {
        source: "deploy-webhook",
        url: "/admin/system-status",
        applicationName: event.applicationName,
        applicationUuid: event.applicationUuid,
        deploymentUuid: event.deploymentUuid,
      },
    });
  }
}

/**
 * Rate-limit by client IP. 60 requests / minute is comfortably above
 * Coolify's per-event burst (typically 1-2 per deploy) but well below a
 * hostile actor flooding to fish for a working secret.
 *
 * Both verbs share the bucket, and both run it before the comparison: the
 * reachability GET checks the same secret and answers 200 against 401, so
 * leaving it unlimited would hand back the free guessing channel the POST
 * limit exists to close.
 */
async function applyWebhookRateLimit(
  request: NextRequest,
): Promise<NextResponse | null> {
  const ip = getClientIp(request);
  const rl = await checkRateLimit(
    `deploy-webhook:${ip ?? "unknown"}`,
    60,
    60_000,
  );
  if (rl.allowed) return null;
  return NextResponse.json(
    { status: "rate_limited" },
    { status: 429, headers: rateLimitHeaders(rl) },
  );
}

export const POST = apiHandler(async (request: NextRequest) => {
  annotate({ action: { name: "deploy.webhook" } });

  const limited = await applyWebhookRateLimit(request);
  if (limited) return limited;

  const ip = getClientIp(request);

  if (!isJsonContentType(request.headers.get("content-type"))) {
    return apiError("Content-Type must be application/json", 415);
  }
  // The raw body, because a signature covers the exact bytes sent.
  const read = await readBodyText(request, 64 * 1024).catch(() => null);
  if (!read) return apiError("Invalid request body", 400);
  if (read.tooLarge) return apiError("Request body exceeds 65536 bytes", 413);

  const signed = verifySignature(request, read.text);
  if (signed) {
    if (!signed.ok) {
      annotate({ meta: { deploy_webhook_auth_reason: signed.reason } });
      return NextResponse.json({ status: "unauthorized" }, { status: 401 });
    }
    getEvent()?.setAuth({ auth_method: "webhook_secret" });
    annotate({ meta: { deploy_webhook_auth: "signature" } });
  } else {
    if (
      flagSet("DEPLOY_WEBHOOK_REQUIRE_SIGNATURE") ||
      !hasValidSecret(request)
    ) {
      return NextResponse.json({ status: "unauthorized" }, { status: 401 });
    }
    // Freshness AFTER the secret check: an unauthenticated caller learns
    // nothing about the timestamp policy.
    const freshness = checkTimestampFreshness(request);
    if (!freshness.ok) {
      annotate({
        meta: { deploy_webhook_replay_reason: freshness.reason ?? "unknown" },
      });
      return NextResponse.json({ status: "stale" }, { status: 401 });
    }
    getEvent()?.setAuth({ auth_method: "webhook_secret" });
  }

  let payload: CoolifyDeployPayload;
  try {
    payload = JSON.parse(read.text) as CoolifyDeployPayload;
  } catch {
    return apiError("Invalid JSON body", 400);
  }

  const event = normalizePayload(payload);

  annotate({
    meta: {
      deploy_outcome: event.outcome,
      application_name: event.applicationName,
      application_uuid: event.applicationUuid,
      deployment_uuid: event.deploymentUuid,
    },
  });

  // One audit-log row per webhook call. Action namespace mirrors the
  // existing `system.*` lane (`system.error`, `system.cleanup.*`) for
  // ops-style events that aren't tied to a single user.
  const action =
    event.outcome === "success"
      ? "system.deploy.success"
      : event.outcome === "failure"
        ? "system.deploy.failure"
        : "system.deploy.unknown";

  await auditLog(action, {
    ipAddress: ip ?? null,
    details: {
      applicationName: event.applicationName,
      applicationUuid: event.applicationUuid,
      deploymentUuid: event.deploymentUuid,
      error: event.error,
      // Preserve the full Coolify payload so we can adapt to schema
      // drift without code change.
      raw: event.raw,
    },
  });

  if (event.outcome === "failure") {
    await notifyAdminsOfFailure(event);
  }

  return NextResponse.json(
    { status: "ok", outcome: event.outcome },
    { status: 200 },
  );
});

/**
 * Coolify (and most webhook UIs) ping `GET` for a reachability check
 * before saving the configuration. We respond 200 if the secret is
 * valid, 401 otherwise — same shape as the Withings webhook.
 */
export const GET = apiHandler(async (request: NextRequest) => {
  annotate({ action: { name: "deploy.webhook.verify" } });

  const limited = await applyWebhookRateLimit(request);
  if (limited) return limited;

  if (!hasValidSecret(request)) {
    return NextResponse.json({ status: "unauthorized" }, { status: 401 });
  }
  getEvent()?.setAuth({ auth_method: "webhook_secret" });
  return NextResponse.json({ status: "ok" }, { status: 200 });
});
