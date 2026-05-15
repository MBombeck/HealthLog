import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { apiHandler } from "@/lib/api-handler";
import { annotate, getEvent } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import { getClientIp, safeJson } from "@/lib/api-response";
import { dispatchLocalisedNotification } from "@/lib/notifications/dispatch-localised";
import { prisma } from "@/lib/db";

/**
 * Deploy-status webhook (phase C2 / v1.4.15).
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

  // v1.4.27 F21 — each admin sees the alert in their own User.locale.
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
        logsUrl: "https://apps-01.bombeck.io",
      },
      metadata: {
        source: "deploy-webhook",
        applicationName: event.applicationName,
        applicationUuid: event.applicationUuid,
        deploymentUuid: event.deploymentUuid,
      },
    });
  }
}

export const POST = apiHandler(async (request: NextRequest) => {
  annotate({ action: { name: "deploy.webhook" } });

  // Rate-limit by client IP. 60 requests / minute is comfortably above
  // Coolify's per-event burst (typically 1-2 per deploy) but well below
  // a hostile actor flooding to fish for a working secret.
  const ip = getClientIp(request);
  const rl = await checkRateLimit(
    `deploy-webhook:${ip ?? "unknown"}`,
    60,
    60_000,
  );
  if (!rl.allowed) {
    return NextResponse.json(
      { status: "rate_limited" },
      { status: 429, headers: rateLimitHeaders(rl) },
    );
  }

  if (!hasValidSecret(request)) {
    return NextResponse.json({ status: "unauthorized" }, { status: 401 });
  }

  getEvent()?.setAuth({ auth_method: "webhook_secret" });

  const { data: payload, error: jsonError } =
    await safeJson<CoolifyDeployPayload>(request);
  if (jsonError) return jsonError;

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
  if (!hasValidSecret(request)) {
    return NextResponse.json({ status: "unauthorized" }, { status: 401 });
  }
  getEvent()?.setAuth({ auth_method: "webhook_secret" });
  return NextResponse.json({ status: "ok" }, { status: 200 });
});
