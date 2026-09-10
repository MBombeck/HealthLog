import { NextRequest } from "next/server";
import { z } from "zod/v4";

import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import {
  apiError,
  apiSuccess,
  apiValidationError,
  safeJson,
  sanitiseZodIssues,
} from "@/lib/api-response";
import { annotate, getEvent } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { encrypt } from "@/lib/crypto";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import { markReconnected } from "@/lib/integrations/status";
import { NIGHTSCOUT_SYNC_QUEUE } from "@/lib/jobs/integration-poll-queues";
import { getGlobalBoss } from "@/lib/jobs/boss-instance";
import {
  fetchSgvEntries,
  NightscoutApiError,
  NightscoutPolicyError,
} from "@/lib/nightscout/client";
import {
  configuredNightscoutPrivateOrigins,
  evaluateNightscoutOrigin,
  nightscoutConnectSchema,
  NightscoutOriginConfigError,
} from "@/lib/validations/nightscout";

/**
 * Connect (or update) the user's Nightscout instance (v1.17.0).
 *
 * Validates the URL + token by a live TEST FETCH of one SGV entry before
 * storing anything — a wrong token (401/403), an unreachable instance, or a
 * private host the user didn't opt into all surface as a clear error here
 * rather than silently parking the integration on its first cron tick.
 *
 * On success the URL + token are encrypted at rest on `User` and the
 * `nightscout` integration ledger is reset to connected. Per-user rate-limited
 * (a test fetch is an outbound call; throttle the connect surface so a tight
 * retry loop can't be used to probe arbitrary hosts).
 */
export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "nightscout.connect" } });

  const rl = await checkRateLimit(`nightscout-connect:${user.id}`, 10, 60_000);
  if (!rl.allowed) {
    return apiError("Too many connection attempts", 429, {
      headers: rateLimitHeaders(rl),
    });
  }

  const { data: body, error: jsonError } = await safeJson(request, {
    maxBytes: 16 * 1024,
  });
  if (jsonError) return jsonError;

  const result = z.safeParse(nightscoutConnectSchema, body);
  if (!result.success) {
    return apiValidationError(
      "A valid Nightscout URL is required",
      sanitiseZodIssues(result.error.issues),
      422,
    );
  }

  const { url, token } = result.data;
  // An operator list that holds a non-grant is an operator problem, not a
  // user one: say which entry and why, rather than a 500 with no words.
  let privateOrigins: ReadonlySet<string>;
  try {
    privateOrigins = configuredNightscoutPrivateOrigins();
  } catch (err) {
    if (err instanceof NightscoutOriginConfigError) {
      annotate({
        action: { name: "nightscout.connect" },
        meta: { refused: "operator_origin_list_invalid" },
      });
      return apiError(err.message, 422);
    }
    throw err;
  }
  const policy = evaluateNightscoutOrigin(url, privateOrigins);

  // SSRF floor at INPUT time, not merely as a side effect of the live probe
  // below. `fetchSgvEntries` does route through `safeFetch` with the same
  // public-host pin, so today both paths refuse the same URLs — but that
  // makes the guard on the value we PERSIST contingent on the probe staying
  // exactly where it is. Reorder it, make it best-effort, or add a "save
  // without testing" affordance and the stored URL is suddenly unchecked.
  // Assert it here so the thing that gets encrypted onto the row is the
  // thing that was validated.
  //
  // The legacy request boolean is intentionally ignored. Only the server-owned
  // exact canonical origin set may authorize private egress.
  if (!policy.allowed || !policy.canonicalOrigin) {
    return apiError(
      "Private network Nightscout access requires server operator approval",
      422,
      { errorCode: "private_origin_not_approved" },
    );
  }

  // Live validation: pull a single SGV entry. A connection that can't even
  // fetch one row is not worth storing.
  try {
    await fetchSgvEntries({
      baseUrl: url,
      token,
      count: 1,
      // Compatibility shape for older callers/tests. The client deliberately
      // ignores this field and re-evaluates server policy on every fetch.
      allowPrivateHost: false,
    });
  } catch (err) {
    if (err instanceof NightscoutPolicyError) {
      return apiError(
        "Private network Nightscout access requires server operator approval",
        422,
        { errorCode: err.reasonCode },
      );
    }
    if (err instanceof NightscoutApiError) {
      if (err.status === 401 || err.status === 403) {
        return apiError(
          "Nightscout rejected the token. Check the API token and try again.",
          422,
        );
      }
      return apiError(
        "Could not reach the Nightscout instance. Check the URL and that it is online.",
        422,
      );
    }
    return apiError(
      "Could not reach the Nightscout instance. Check the URL and that it is online.",
      422,
    );
  }

  await prisma.user.update({
    where: { id: user.id },
    data: {
      // Build the data object field-by-field — never spread the parsed body.
      nightscoutUrlEncrypted: encrypt(url),
      nightscoutTokenEncrypted: token ? encrypt(token) : null,
      // Compatibility/display metadata only. Server policy is rechecked from
      // NIGHTSCOUT_PRIVATE_ORIGINS before every request.
      nightscoutAllowPrivateHost: policy.privateOriginApproved,
    },
  });

  await markReconnected(user.id, "nightscout");
  await auditLog("nightscout.connect", { userId: user.id });

  // Pull the first glucose window now instead of leaving the user staring at an
  // empty card until the next hourly tick. Best-effort by design: the hourly
  // cron remains the safety net, so a missing boss instance must never fail the
  // connect response the user just earned.
  const boss = getGlobalBoss();
  if (boss) {
    await boss
      .send(NIGHTSCOUT_SYNC_QUEUE, { userId: user.id })
      .catch((err) =>
        getEvent()?.addWarning(
          `nightscout-sync connect enqueue failed: ${err}`,
        ),
      );
  }

  return apiSuccess({ connected: true });
});
