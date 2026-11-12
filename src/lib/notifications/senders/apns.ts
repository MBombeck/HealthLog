/**
 * APNs sender — joins the dispatcher cascade alongside Telegram, ntfy,
 * and Web Push (v1.4.23 Wave 3 / F4).
 *
 * Mirrors the `web-push.ts` shape so the dispatcher can call it through
 * the same `SendOutcome`-returning contract:
 *  - `ok: true`              if at least one device received the push.
 *  - `hardReject: true`      when EVERY device returned a permanent
 *    APNs reason (`Unregistered`, `BadDeviceToken`, `DeviceTokenNotForTopic`).
 *    The dead device rows are deleted from the DB regardless, so a
 *    hard channel reject means the user has zero iOS devices left for
 *    the dispatcher to try.
 *  - `hardReject: false`     for any other failure (transient APNs
 *    5xx, throttling, network, certificate-invalid). The channel-state
 *    machine then schedules the next retry per the backoff schedule.
 *
 * Provider lifecycle: `@parse/node-apn` keeps the HTTP/2 connection
 * pool + the JWT bearer (regenerated every ~50 minutes per Apple's spec)
 * inside its `Provider` instance. We lazy-init one Provider per gateway
 * (`sandbox` vs `production`) at module scope. **Do not** cache the JWT
 * separately — that's what the library is for, and pinning a single
 * token to the process lifetime would expire ~50 minutes after boot.
 */
import { createHash, createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";

import apn from "@parse/node-apn";

import { prisma } from "@/lib/db";
import { getEvent } from "@/lib/logging/context";
import type { SendOutcome } from "@/lib/notifications/retry-policy";
import { recordPushAttemptForPayload } from "@/lib/notifications/senders/push-attempt-record";
import { plainPushText } from "@/lib/notifications/strip-emoji";
import { stripHtml } from "@/lib/notifications/strip-html";
import { isManagedGuardianDelivery } from "@/lib/notifications/managed-delivery";
import { NEUTRAL_TAP_PATH } from "@/lib/notifications/tap-target";
import type { NotificationTap } from "@/lib/notifications/types";

export interface ApnsPayload {
  /** APNs `aps.alert.title` + `aps.alert.body`. */
  alert: { title: string; body: string };
  /** APNs `aps.badge`. Omit to leave the existing badge unchanged. */
  badge?: number;
  /** APNs `aps.sound`. Omit for `default`. */
  sound?: string;
  /** Custom keys; surfaces in `Notification.userInfo` on iOS. */
  data?: Record<string, unknown>;
  /** APNs `aps.thread-id` — groups related alerts in Notification Center. */
  threadId?: string;
  /**
   * APNs `aps.category` — names a `UNNotificationCategory` registered by
   * the iOS app at launch. The category drives the action-button row on
   * the lock-screen / Notification Center entry. iOS HealthLog v0.5.3
   * registers `MEDICATION_REMINDER` (Take / Snooze 15 / Skip) and
   * `MOOD_REMINDER` (Log mood). Omit the field for plain alerts without
   * actions.
   */
  category?: string;
  /**
   * Sets `aps.mutable-content = 1`. iOS routes the payload through the
   * app's Notification Service Extension before the system renders it,
   * giving the extension a chance to enrich the alert (e.g. download a
   * thumbnail, decrypt a body). HealthLog doesn't ship an NSE yet, but
   * the flag is cheap to set and a no-op without one — wiring it now
   * means the iOS team can drop in an NSE later without a server-side
   * roundtrip.
   */
  mutableContent?: boolean;
  /**
   * APNs `aps.interruption-level` (iOS 15+). Controls whether the alert
   * bypasses Focus modes:
   *  - `passive`        — silent, no banner; lives in Notification Center.
   *  - `active`         — default; banner + sound; honours Focus.
   *  - `time-sensitive` — breaks through Focus modes (per-app opt-in by
   *    the user on iOS); used for things the user explicitly asked to be
   *    interrupted for. **Restricted to MEDICATION_REMINDER** in the
   *    dispatcher; other categories must NOT bypass Focus.
   *  - `critical`       — entitlement-gated, ignores DND completely; not
   *    used by HealthLog.
   * Omit for the iOS default (`active`).
   */
  interruptionLevel?: "passive" | "active" | "time-sensitive" | "critical";
  /**
   * APNs `apns-priority` header. `10` = immediate delivery (required for
   * time-sensitive interruption-level per Apple's push best-practices),
   * `5` = power-conserving. Omit to let node-apn default to `10`.
   */
  priority?: 5 | 10;
}

export interface ApnsSendInput {
  deviceToken: string;
  environment: "sandbox" | "production";
  payload: ApnsPayload;
  /** Defaults to `APNS_BUNDLE_ID`. */
  topic?: string;
  /** Replaces an earlier alert of the same kind in Notification Center. */
  collapseId?: string;
}

export interface ApnsSendResult {
  ok: boolean;
  /** APNs HTTP status, when the call reached Apple. */
  status?: number;
  /** Apple's error code, e.g. "BadDeviceToken", "Unregistered". */
  reason?: string;
  /**
   * True on permanent failures (`Unregistered`, `BadDeviceToken`,
   * `DeviceTokenNotForTopic`). The caller should remove the device row
   * — sending again will only burn quota.
   */
  shouldDisable?: boolean;
  /** Human-readable error fragment for logs. */
  message?: string;
}

interface ApnsConfig {
  keyId: string;
  teamId: string;
  bundleId: string;
  /** PEM-encoded .p8 contents (multi-line OK). */
  signingKey: string;
  /**
   * If set, force every send through the production gateway regardless of
   * the per-device `apnsEnvironment`. Useful for staging environments
   * that have to talk to a TestFlight build.
   */
  forceProduction: boolean;
}

/**
 * Permanent APNs error reasons. Anything in this set means "delete the
 * device row, do not retry". Sourced from Apple's
 * `Sending Notification Requests to APNs` reference table.
 *
 * `DeviceTokenNotForTopic` lands here (rather than as a transient blip)
 * because it indicates a configuration mismatch between the iOS bundle
 * and the server-side topic — re-sending will fail forever.
 */
const PERMANENT_APNS_REASONS = new Set<string>([
  "Unregistered",
  "BadDeviceToken",
  "DeviceTokenNotForTopic",
]);

/**
 * Apple's documented ceiling for the `apns-collapse-id` header. A longer
 * value is rejected with `BadCollapseId`, i.e. the push is lost.
 */
const APNS_COLLAPSE_ID_MAX_BYTES = 64;

/**
 * node-apn owns an HTTP/2 connection pool but exposes no AbortSignal on
 * Provider.send(). Bound the promise at this boundary so a stuck Apple
 * connection cannot prevent the dispatcher's later fallback channels.
 */
const APNS_PROVIDER_SEND_TIMEOUT_MS = 5_000;

class ApnsProviderTimeoutError extends Error {
  constructor() {
    super(
      `APNs provider send timed out after ${APNS_PROVIDER_SEND_TIMEOUT_MS}ms`,
    );
    this.name = "ApnsProviderTimeoutError";
  }
}

/**
 * Observe both branches of the provider promise even after the timeout wins.
 * That prevents a late rejection from becoming an unhandled rejection while
 * retaining a hard upper bound for the dispatcher.
 */
function awaitBoundedApnsProviderSend<T>(operation: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new ApnsProviderTimeoutError());
    }, APNS_PROVIDER_SEND_TIMEOUT_MS);

    operation.then(
      (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(result);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

let cachedConfig: ApnsConfig | null | undefined;
const providers = new Map<"sandbox" | "production", apn.Provider>();

/**
 * Read the APNS_* env vars once per process. Returns null if any one of
 * the required values is missing — that disables the channel cleanly
 * rather than throwing on every dispatch.
 *
 * Validation rule: APNS_KEY_ID, APNS_TEAM_ID, APNS_BUNDLE_ID, and ONE OF
 * (APNS_KEY_B64 | APNS_KEY | APNS_KEY_FILE) must all be set together.
 * Setting some but not others is treated as "intentionally disabled" and
 * emits a warning the first time a send is attempted, so a half-finished
 * Coolify env surfaces in the logs the moment it matters.
 *
 * Key-source precedence: APNS_KEY_B64 > APNS_KEY > APNS_KEY_FILE. The B64
 * variant lets operators sidestep `\n`-escape gymnastics that some
 * docker-compose `env_file` round-trips mangle (v1.4.47.4).
 */
export function loadApnsConfig(): ApnsConfig | null {
  if (cachedConfig !== undefined) return cachedConfig;

  const keyId = process.env.APNS_KEY_ID?.trim() || "";
  const teamId = process.env.APNS_TEAM_ID?.trim() || "";
  const bundleId = process.env.APNS_BUNDLE_ID?.trim() || "";
  const inlineKey = process.env.APNS_KEY?.trim() || "";
  // v1.4.47.4 — `APNS_KEY_B64` is an escape-free alternative when the
  // `\n`-escaped inline form is mangled by a `docker-compose env_file`
  // round-trip. Operator base64-encodes the .p8 PEM file as-is and
  // stores the result; we decode it back to a real PEM string here.
  // Takes precedence over `APNS_KEY` and `APNS_KEY_FILE` when set.
  const inlineKeyB64 = process.env.APNS_KEY_B64?.trim() || "";
  const keyFile = process.env.APNS_KEY_FILE?.trim() || "";
  const forceProduction = process.env.APNS_PRODUCTION === "true";

  // All-or-none guard: if zero of the four core values are set, APNs is
  // simply disabled — no warning. If some are set, the operator started
  // configuring and stopped — surface that as a warning so the
  // half-finished state is visible in logs.
  const anySet = Boolean(
    keyId || teamId || bundleId || inlineKey || inlineKeyB64 || keyFile,
  );
  const allSet = Boolean(
    keyId && teamId && bundleId && (inlineKey || inlineKeyB64 || keyFile),
  );

  if (!anySet) {
    cachedConfig = null;
    return null;
  }

  if (!allSet) {
    getEvent()?.addWarning(
      "APNs config incomplete — set APNS_KEY_ID, APNS_TEAM_ID, " +
        "APNS_BUNDLE_ID, and one of APNS_KEY / APNS_KEY_B64 / APNS_KEY_FILE " +
        "together. APNs sender is disabled until all four are present.",
    );
    cachedConfig = null;
    return null;
  }

  let signingKey: string;
  if (inlineKeyB64) {
    // v1.4.47.4 — base64-encoded PEM. The operator base64s the raw .p8
    // file contents (with real newlines intact) and stores that result
    // in `APNS_KEY_B64`. We decode back to UTF-8 PEM string here. This
    // sidesteps every `\n`-escape gymnastics needed for the legacy
    // `APNS_KEY` inline path — base64 chars are env-var-pipeline safe.
    try {
      signingKey = Buffer.from(inlineKeyB64, "base64").toString("utf-8");
    } catch (err) {
      const message = err instanceof Error ? err.message : "decode_failed";
      getEvent()?.addWarning(`APNS_KEY_B64 did not decode: ${message}`);
      cachedConfig = null;
      return null;
    }
    try {
      const keyObject = createPrivateKey({ key: signingKey, format: "pem" });
      if (keyObject.asymmetricKeyType !== "ec") {
        getEvent()?.addWarning(
          `APNS_KEY_B64 parsed as ${keyObject.asymmetricKeyType ?? "unknown"}; expected "ec" for ES256`,
        );
        cachedConfig = null;
        return null;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "parse_failed";
      getEvent()?.addWarning(
        `APNS_KEY_B64 did not parse as PEM after base64 decode: ${message}`,
      );
      cachedConfig = null;
      return null;
    }
  } else if (inlineKey) {
    // Multi-line PEM with literal `\n` escapes is the 12-factor norm
    // when the env block is a single line. Convert them back here so
    // node-apn sees a real PEM. No-op for already-multiline values.
    signingKey = inlineKey.replace(/\\n/g, "\n");

    // v1.4.47.2 — defensive PEM normalisation.
    //
    // jsonwebtoken@9 (used by @parse/node-apn) throws
    // `secretOrPrivateKey must be an asymmetric key when using ES256`
    // when the PEM body has no newlines between BEGIN/END markers and
    // the base64 payload — even though openssl can still parse it.
    // Coolify + docker-compose `env_file` round-trips have at least
    // three known failure modes that drop newlines: the env value
    // arriving without `\n` escapes, an editor stripping the trailing
    // newline at the marker boundary, or a copy-paste from the Apple
    // Developer portal that lost line breaks. Force-rewrap the
    // base64 body at 64-char lines if we cannot parse the key as-is.
    signingKey = normaliseApnsPem(signingKey);

    // Belt-and-suspenders: verify the key actually parses as an
    // asymmetric EC key before we hand it to node-apn. A single
    // warning per process beats hundreds of `sender_threw` retries
    // every time the worker tries to dispatch a push.
    try {
      const keyObject = createPrivateKey({ key: signingKey, format: "pem" });
      if (keyObject.asymmetricKeyType !== "ec") {
        getEvent()?.addWarning(
          `APNs key parsed as ${keyObject.asymmetricKeyType ?? "unknown"}; expected "ec" for ES256`,
        );
        cachedConfig = null;
        return null;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "parse_failed";
      // v1.4.47.3 — diagnostic dump on parse failure so operators can
      // tell whether the env-var arrived in the expected shape.
      // Logs nothing sensitive: only lengths, character-class counts,
      // and a SHA-256 prefix of the normalised body. Never the key bytes.
      const sha256 = createHash("sha256").update(signingKey).digest("hex");
      const escapedNewlineCount = (inlineKey.match(/\\n/g) || []).length;
      const realNewlineCount = (signingKey.match(/\n/g) || []).length;
      const beginCount = (signingKey.match(/-----BEGIN/g) || []).length;
      const endCount = (signingKey.match(/-----END/g) || []).length;
      const base64Chars = (signingKey.match(/[A-Za-z0-9+/=]/g) || []).length;
      const otherChars =
        signingKey.length -
        base64Chars -
        realNewlineCount -
        (signingKey.match(/[-\s]/g) || []).length;
      getEvent()?.addWarning(
        `APNs key did not parse as PEM: ${message} ` +
          `[diag raw_len=${inlineKey.length} norm_len=${signingKey.length} ` +
          `escaped_newlines=${escapedNewlineCount} real_newlines=${realNewlineCount} ` +
          `begin_markers=${beginCount} end_markers=${endCount} ` +
          `base64_chars=${base64Chars} other_chars=${otherChars} ` +
          `sha256_prefix=${sha256.slice(0, 16)}]`,
      );
      cachedConfig = null;
      return null;
    }
  } else {
    try {
      signingKey = readFileSync(/* turbopackIgnore: true */ keyFile, "utf8");
    } catch (err) {
      const message = err instanceof Error ? err.message : "read_failed";
      getEvent()?.addWarning(`APNs key file read failed: ${message}`);
      cachedConfig = null;
      return null;
    }
  }

  cachedConfig = { keyId, teamId, bundleId, signingKey, forceProduction };
  return cachedConfig;
}

/**
 * v1.4.47.2 — repair PEM strings that lost newlines along the
 * env-var → docker-compose → process.env pipeline.
 *
 * If the input already has real newlines around the BEGIN/END markers
 * AND the body wraps at <=64 chars per line (Apple's .p8 default),
 * it is returned unchanged. Otherwise we strip everything outside
 * the BEGIN/END markers, rewrap the base64 body at 64-char lines,
 * and rebuild a canonical PEM. Idempotent on already-correct PEMs.
 */
function normaliseApnsPem(raw: string): string {
  const beginMarker = "-----BEGIN PRIVATE KEY-----";
  const endMarker = "-----END PRIVATE KEY-----";
  const beginIdx = raw.indexOf(beginMarker);
  const endIdx = raw.indexOf(endMarker);
  if (beginIdx < 0 || endIdx <= beginIdx) {
    // Bare base64 body without markers — wrap it.
    const body = raw.replace(/\s+/g, "");
    if (!/^[A-Za-z0-9+/=]+$/.test(body)) {
      // Not recognisable; return as-is and let downstream complain.
      return raw;
    }
    const wrapped = body.replace(/(.{64})/g, "$1\n").replace(/\n$/, "");
    return `${beginMarker}\n${wrapped}\n${endMarker}`;
  }
  const body = raw
    .slice(beginIdx + beginMarker.length, endIdx)
    .replace(/\s+/g, "");
  if (!body) return raw;
  const wrapped = body.replace(/(.{64})/g, "$1\n").replace(/\n$/, "");
  return `${beginMarker}\n${wrapped}\n${endMarker}`;
}

/**
 * Reset the cached config + Provider singletons. Tests use this to
 * re-read env vars between cases; production never calls it.
 */
export function resetApnsForTesting(): void {
  cachedConfig = undefined;
  for (const provider of providers.values()) {
    void provider.shutdown();
  }
  providers.clear();
}

function getProvider(
  config: ApnsConfig,
  environment: "sandbox" | "production",
): apn.Provider {
  const useProduction = config.forceProduction || environment === "production";
  const key = useProduction ? "production" : "sandbox";
  const existing = providers.get(key);
  if (existing) return existing;

  const provider = new apn.Provider({
    token: {
      key: config.signingKey,
      keyId: config.keyId,
      teamId: config.teamId,
    },
    production: useProduction,
  });
  providers.set(key, provider);
  return provider;
}

/**
 * Send one APNs alert push to one device. The dispatcher fans out per
 * device because APNs can return per-device failure reasons that map to
 * different cleanup actions.
 */
export async function sendApnsPush(
  input: ApnsSendInput,
): Promise<ApnsSendResult> {
  const config = loadApnsConfig();
  if (!config) {
    return {
      ok: false,
      reason: "apns_not_configured",
      message: "APNs env vars are not set",
    };
  }

  const provider = getProvider(config, input.environment);

  const note = new apn.Notification();
  note.topic = input.topic ?? config.bundleId;
  note.alert = {
    title: input.payload.alert.title,
    body: input.payload.alert.body,
  };
  note.sound = input.payload.sound ?? "default";
  if (typeof input.payload.badge === "number") {
    note.badge = input.payload.badge;
  }
  if (input.payload.threadId) {
    note.threadId = input.payload.threadId;
  }
  if (input.payload.category) {
    // node-apn's `category` setter writes through to `aps.category` —
    // that's the key the iOS notification system reads to look up a
    // `UNNotificationCategory` and render its action-button row. The
    // category name is a plain string that must match an identifier
    // registered by the iOS app at launch (see iOS HealthLog v0.5.3
    // `NotificationCategories`).
    //
    // The cast is because node-apn 8.1's d.ts file omits the public
    // setter (it only documents the matching `aps.category` field on
    // the `Aps` interface), but the runtime setter on
    // `apsProperties.js` writes the value through unchanged. We assign
    // via the `category` setter rather than poking `note.aps.category`
    // directly so we stay forward-compatible with future d.ts fixes.
    (note as unknown as { category: string }).category = input.payload.category;
  }
  if (input.payload.mutableContent) {
    // node-apn writes this through to `aps.mutable-content = 1`, which
    // unlocks the iOS Notification Service Extension hook.
    note.mutableContent = true;
  }
  if (input.payload.interruptionLevel) {
    // node-apn's `interruptionLevel` setter writes through to
    // `aps.interruption-level`. iOS 15+ reads it to decide whether the
    // alert breaks through Focus modes — `time-sensitive` is the level
    // that does so, gated on a per-app toggle the user grants on
    // install. Older iOS versions ignore the key, so this is safe to
    // send unconditionally.
    //
    // The cast mirrors the `category` setter above — node-apn 8.1's
    // d.ts omits the public setter (the runtime setter on
    // `apsProperties.js` writes the value through to
    // `aps.interruption-level` unchanged), so we assign via a typed
    // cast rather than poking `note.aps` directly. Forward-compatible
    // with future d.ts fixes.
    (note as unknown as { interruptionLevel: string }).interruptionLevel =
      input.payload.interruptionLevel;
  }
  if (typeof input.payload.priority === "number") {
    // node-apn writes this through to the `apns-priority` HTTP header.
    // Apple's push best-practices doc requires priority 10 alongside
    // `time-sensitive` interruption-level — otherwise APNs may downgrade
    // delivery and the Focus-bypass intent is lost.
    note.priority = input.payload.priority;
  }
  if (input.collapseId) {
    note.collapseId = input.collapseId;
  }
  if (input.payload.data) {
    note.payload = { ...input.payload.data };
  }

  const start = performance.now();
  let result: Awaited<ReturnType<apn.Provider["send"]>>;
  try {
    result = await awaitBoundedApnsProviderSend(
      provider.send(note, input.deviceToken),
    );
  } catch (err) {
    const timedOut = err instanceof ApnsProviderTimeoutError;
    const message = timedOut
      ? `APNs provider send timed out after ${APNS_PROVIDER_SEND_TIMEOUT_MS}ms`
      : err instanceof Error
        ? err.message
        : "send_failed";
    getEvent()?.addExternalCall({
      service: "apns",
      method: "send",
      duration_ms: Math.round(performance.now() - start),
      error: timedOut ? "timeout" : message,
    });
    return {
      ok: false,
      reason: timedOut ? "apns_timeout" : "apns_network_error",
      shouldDisable: false,
      message,
    };
  }

  const duration = Math.round(performance.now() - start);

  if (result.sent.length > 0) {
    getEvent()?.addExternalCall({
      service: "apns",
      method: "send",
      duration_ms: duration,
      status: 200,
    });
    return { ok: true, status: 200 };
  }

  const failure = result.failed[0];
  const reason = failure?.response?.reason ?? failure?.error?.message;
  const status = failure?.status ? Number(failure.status) : undefined;
  const shouldDisable = reason ? PERMANENT_APNS_REASONS.has(reason) : false;

  getEvent()?.addExternalCall({
    service: "apns",
    method: "send",
    duration_ms: duration,
    status: status ?? undefined,
    error: reason ?? "all_failed",
  });

  return {
    ok: false,
    status,
    reason: reason ?? "apns_unknown_failure",
    shouldDisable,
    message: failure?.error?.message,
  };
}

/**
 * Dispatcher entry point — fans a payload out to every iOS device the
 * user owns and returns a single `SendOutcome` summarising the batch.
 *
 * Mirrors `sendViaWebPush(userId, payload)` so `dispatcher.ts` can route
 * the APNS branch identically to its web-push branch:
 *  - At least one success ⇒ `ok: true`.
 *  - All devices permanently rejected ⇒ `hardReject: true` (channel
 *    auto-disables; user has no iOS device left to retry against).
 *  - Otherwise ⇒ soft failure, channel-state machine schedules backoff.
 */
export async function sendViaApns(
  userId: string,
  payload: {
    title: string;
    message: string;
    eventType: string;
    metadata?: Record<string, unknown>;
    discreet?: boolean;
    urgent?: boolean;
    /** The dispatch offers no completion action — see `NotificationPayload`. */
    suppressActions?: boolean;
    recordUserId?: string;
    recipientUserId?: string;
    tap?: NotificationTap;
  },
): Promise<SendOutcome> {
  const config = loadApnsConfig();
  if (!config) {
    recordPushAttemptForPayload(payload, userId, {
      userId,
      channel: "APNS",
      eventType: payload.eventType,
      result: "skipped",
      reason: "apns_not_configured",
    });
    return {
      ok: false,
      hardReject: false,
      reason: "apns_not_configured",
    };
  }

  const devices = await prisma.device.findMany({
    where: {
      userId,
      apnsToken: { not: null },
    },
    select: {
      id: true,
      apnsToken: true,
      apnsEnvironment: true,
    },
  });

  if (devices.length === 0) {
    // Same rationale as web-push: a user who hasn't paired an iPhone yet
    // shouldn't see the channel auto-disabled. Treat as soft "no recipient".
    recordPushAttemptForPayload(payload, userId, {
      userId,
      channel: "APNS",
      eventType: payload.eventType,
      result: "skipped",
      reason: "apns_no_devices",
    });
    return {
      ok: false,
      hardReject: false,
      reason: "apns_no_devices",
    };
  }

  let anySuccess = false;
  const deadDeviceIds: string[] = [];
  let lastFailureReason: string | undefined;
  let lastFailureStatus: number | undefined;

  for (const device of devices) {
    if (!device.apnsToken) continue;
    const initialEnv: "production" | "sandbox" =
      device.apnsEnvironment === "production" ? "production" : "sandbox";

    // v1.4.47.5 — gateway auto-detect on BadEnvironmentKeyInToken.
    // The iOS client picks the gateway env when it registers, but in
    // practice the client's reported env can mismatch the token's
    // actual environment (e.g. DEBUG build that registered itself as
    // "production" by accident). Apple returns `BadEnvironmentKeyInToken`
    // when the provider gateway env doesn't match the token env. Try
    // the opposite gateway exactly once; if it succeeds, persist the
    // correction so subsequent sends go straight to the right env.
    const envSequence: ReadonlyArray<"production" | "sandbox"> =
      initialEnv === "production"
        ? (["production", "sandbox"] as const)
        : (["sandbox", "production"] as const);

    // v1.4.40 — only MEDICATION_REMINDER opts in to Focus-bypass by
    // default. The user explicitly asked the server to nudge them about a
    // dose; a missed dose is the textbook "time-sensitive" use case Apple
    // sanctions. Every other event-type (mood nudges, anomaly alerts,
    // PRs, system messages) stays on the default `active` level so Focus
    // modes — including Sleep — silence them as the user expects.
    //
    // v1.18.4 — an explicitly urgent payload (e.g. an illness red-flag
    // "seek care" escalation) ALSO opts in to time-sensitive: it is the
    // strongest level the APNs sender can reach without an Apple-approved
    // entitlement, and the channel-agnostic urgency model wants every
    // channel at its highest tier for an urgent event.
    const isTimeSensitive =
      payload.eventType === "MEDICATION_REMINDER" || payload.urgent === true;
    // The `critical` interruption-level ignores DND/Focus completely but
    // is gated behind an Apple-approved entitlement (`com.apple.developer.
    // usernotifications.critical-alerts`). Only emit it when the operator
    // has confirmed the build carries the entitlement — otherwise APNs
    // rejects the push. Default off; time-sensitive is the safe floor.
    const useCritical =
      payload.urgent === true &&
      process.env.APNS_CRITICAL_ENTITLEMENT === "true";

    let result: Awaited<ReturnType<typeof sendApnsPush>> | null = null;
    const managedDelivery = isManagedGuardianDelivery(payload);
    // Discreet mode (cycle privacy): the lock-screen-visible routing
    // metadata must not carry the event name. Collapse the category /
    // threadId / collapseId and the data eventType to a generic value so
    // CYCLE_PERIOD_SOON never surfaces on the lock screen.
    const GENERIC_EVENT = "REMINDER";
    const routingEvent = payload.discreet ? GENERIC_EVENT : payload.eventType;
    // `apns-collapse-id` REPLACES an earlier undelivered push carrying the
    // same id. Keyed on the event type it made every medication reminder
    // replace the last one, so three medications due at 08:00 arrived as a
    // single notification naming a single medication. Key it on the
    // per-slot tag the Web Push sender already coalesces on
    // (`medicationDoseTag`), and keep grouping — `threadId` — on the event.
    // Discreet mode wins: no record-identifying string on the lock screen.
    // Apple caps the header at 64 bytes and rejects anything longer, so an
    // oversized tag falls back rather than costing the send.
    const slotTag =
      typeof payload.metadata?.webPushTag === "string" &&
      Buffer.byteLength(payload.metadata.webPushTag, "utf8") <=
        APNS_COLLAPSE_ID_MAX_BYTES
        ? payload.metadata.webPushTag
        : undefined;
    const collapseId = payload.discreet
      ? routingEvent
      : (slotTag ?? routingEvent);
    let workingEnv: "production" | "sandbox" | null = null;
    for (const attemptEnv of envSequence) {
      result = await sendApnsPush({
        deviceToken: device.apnsToken,
        environment: attemptEnv,
        payload: {
          alert: {
            title: plainPushText(payload.title, payload.eventType),
            body: plainPushText(stripHtml(payload.message), payload.eventType),
          },
          data: {
            eventType: routingEvent,
            // In discreet mode also drop cycle-semantic metadata (e.g. `phase`)
            // so a future cycle push can't name a cycle concept on the wire even
            // though the allowlist permits `phase` (QA LOW).
            // A Guardian may read a managed record but must never receive
            // an iOS action identifier or deep link that can mutate it.
            // Keep the ordinary event envelope so opening the notification
            // follows the normal authorised record-selection flow.
            // `suppressActions` removes the act-on-it keys for the same
            // reason it clears the category below: the affordance the app
            // would build from them resolves to a refusal.
            ...pickIosMetadata(
              managedDelivery
                ? undefined
                : payload.suppressActions
                  ? stripActionMetadata(
                      payload.discreet
                        ? stripCycleMetadata(payload.metadata)
                        : payload.metadata,
                    )
                  : payload.discreet
                    ? stripCycleMetadata(payload.metadata)
                    : payload.metadata,
            ),
            // The resolved tap target (`tap-target.ts`): a same-origin path
            // the app opens on tap. Overrides a producer's `metadata.url`,
            // which the resolver already took into account. A managed
            // delivery and a discreet one carry the app root (the resolver
            // answers `/`); the managed arm is pinned here as well, so a
            // payload that bypassed the resolver still cannot deep-link a
            // Guardian into the record they are only notified about.
            ...(payload.tap?.path
              ? { url: managedDelivery ? NEUTRAL_TAP_PATH : payload.tap.path }
              : {}),
          },
          threadId: routingEvent,
          // The iOS app registers a `UNNotificationCategory` per event-type
          // so the same string doubles as the category identifier. iOS
          // ignores categories it doesn't know about, so adding the key
          // here is safe for event-types that don't have an actionable
          // category registered yet — they fall back to a plain alert.
          // A suppressed-action dispatch drops the category for the same
          // reason a managed delivery does: the category IS the action row,
          // and an appointment nudge has no action the server would accept.
          category:
            managedDelivery || payload.suppressActions
              ? undefined
              : routingEvent,
          // Future-proof for an iOS Notification Service Extension. iOS
          // ignores the flag when no extension is registered, so it's a
          // no-op on today's binary but unblocks NSE work without a
          // server-side change.
          mutableContent: true,
          ...(isTimeSensitive
            ? {
                interruptionLevel: useCritical
                  ? ("critical" as const)
                  : ("time-sensitive" as const),
                priority: 10 as const,
              }
            : {}),
        },
        collapseId,
      });

      if (result.ok) {
        workingEnv = attemptEnv;
        break;
      }
      // Only retry the OTHER gateway on the specific environment-mismatch
      // reason. Other failure reasons (BadDeviceToken, expired, network
      // blips) wouldn't be solved by switching gateways.
      if (result.reason !== "BadEnvironmentKeyInToken") {
        break;
      }
    }

    if (result?.ok) {
      anySuccess = true;
      if (workingEnv && workingEnv !== initialEnv) {
        // Persist the correction so subsequent sends go straight to the
        // right gateway. Log a wide-event warning so the operator sees
        // the iOS client's reported env was wrong.
        await prisma.device
          .update({
            where: { id: device.id },
            data: { apnsEnvironment: workingEnv },
          })
          .catch(() => {
            /* persist is best-effort; the send already succeeded */
          });
        getEvent()?.addWarning(
          `APNs device.apnsEnvironment corrected ${initialEnv} → ${workingEnv} after BadEnvironmentKeyInToken`,
        );
      }
      continue;
    }

    if (result?.shouldDisable) {
      deadDeviceIds.push(device.id);
    }
    lastFailureReason = result?.reason;
    lastFailureStatus = result?.status;
  }

  if (deadDeviceIds.length > 0) {
    await prisma.device.deleteMany({
      where: { id: { in: deadDeviceIds } },
    });
  }

  if (anySuccess) {
    recordPushAttemptForPayload(payload, userId, {
      userId,
      channel: "APNS",
      eventType: payload.eventType,
      result: "ok",
    });
    return { ok: true };
  }

  // Every surviving device returned a permanent reason → channel is dead
  // until the user re-registers from a fresh iOS install.
  if (deadDeviceIds.length === devices.length) {
    const reason = lastFailureReason ?? "apns_all_devices_unregistered";
    recordPushAttemptForPayload(payload, userId, {
      userId,
      channel: "APNS",
      eventType: payload.eventType,
      result: "error",
      reason,
    });
    return {
      ok: false,
      hardReject: true,
      statusCode: lastFailureStatus,
      reason,
    };
  }

  const reason = lastFailureReason ?? "apns_send_failed";
  recordPushAttemptForPayload(payload, userId, {
    userId,
    channel: "APNS",
    eventType: payload.eventType,
    result: "error",
    reason,
  });
  return {
    ok: false,
    hardReject: false,
    statusCode: lastFailureStatus,
    reason,
  };
}

export interface ApnsRawSendInput {
  deviceToken: string;
  environment: "sandbox" | "production";
  /**
   * APNs `apns-push-type` header. `background` for a silent
   * content-available push (no alert); `liveactivity` for an
   * ActivityKit update / end push.
   */
  pushType: "background" | "liveactivity";
  /**
   * Custom JSON payload merged into the notification body. For a
   * `background` push this is the app's userInfo; for a `liveactivity`
   * push it carries the `aps` content-state / event / timestamp the iOS
   * Activity reads. Sent verbatim (no alert / sound / badge enrichment).
   */
  payload: Record<string, unknown>;
  /**
   * APNs topic. The silent-sync push uses the app bundle id (default);
   * the Live Activity push MUST use `<bundle>.push-type.liveactivity`.
   */
  topic?: string;
  /** `apns-priority`. `5` for background (power-conserving) is required. */
  priority?: 5 | 10;
}

/**
 * v1.17.1 (#22) — send one raw APNs push (silent background or Live
 * Activity) to one device. Unlike `sendApnsPush`, this sets NO
 * `aps.alert` / `aps.sound` / `aps.badge`: a `background` push must be
 * content-only or APNs rejects it, and a `liveactivity` push carries its
 * own `aps` content-state in the supplied `payload`. The `rawPayload`
 * escape hatch bypasses node-apn's convenience setters so the caller
 * controls the exact wire body.
 */
export async function sendApnsRawPush(
  input: ApnsRawSendInput,
): Promise<ApnsSendResult> {
  const config = loadApnsConfig();
  if (!config) {
    return {
      ok: false,
      reason: "apns_not_configured",
      message: "APNs env vars are not set",
    };
  }

  const provider = getProvider(config, input.environment);

  const note = new apn.Notification();
  note.topic = input.topic ?? config.bundleId;
  note.pushType = input.pushType;
  if (input.pushType === "background") {
    // A silent push declares `content-available: 1` and carries no
    // alert/sound/badge. Apple rejects a content-available-only push at
    // priority 10, so default to the power-conserving 5.
    note.contentAvailable = true;
    note.priority = input.priority ?? 5;
  } else {
    note.priority = input.priority ?? 10;
  }
  // Bypass the convenience setters entirely so the body is exactly what
  // the silent-sync / Live-Activity contract specifies — no injected
  // `aps.alert` shell.
  note.rawPayload = input.payload;

  const start = performance.now();
  let result: Awaited<ReturnType<apn.Provider["send"]>>;
  try {
    result = await awaitBoundedApnsProviderSend(
      provider.send(note, input.deviceToken),
    );
  } catch (err) {
    const timedOut = err instanceof ApnsProviderTimeoutError;
    const message = timedOut
      ? `APNs provider send timed out after ${APNS_PROVIDER_SEND_TIMEOUT_MS}ms`
      : err instanceof Error
        ? err.message
        : "send_failed";
    getEvent()?.addExternalCall({
      service: "apns",
      method: `send_${input.pushType}`,
      duration_ms: Math.round(performance.now() - start),
      error: timedOut ? "timeout" : message,
    });
    return {
      ok: false,
      reason: timedOut ? "apns_timeout" : "apns_network_error",
      shouldDisable: false,
      message,
    };
  }

  const duration = Math.round(performance.now() - start);

  if (result.sent.length > 0) {
    getEvent()?.addExternalCall({
      service: "apns",
      method: `send_${input.pushType}`,
      duration_ms: duration,
      status: 200,
    });
    return { ok: true, status: 200 };
  }

  const failure = result.failed[0];
  const reason = failure?.response?.reason ?? failure?.error?.message;
  const status = failure?.status ? Number(failure.status) : undefined;
  const shouldDisable = reason ? PERMANENT_APNS_REASONS.has(reason) : false;

  getEvent()?.addExternalCall({
    service: "apns",
    method: `send_${input.pushType}`,
    duration_ms: duration,
    status: status ?? undefined,
    error: reason ?? "all_failed",
  });

  return {
    ok: false,
    status,
    reason: reason ?? "apns_unknown_failure",
    shouldDisable,
    message: failure?.error?.message,
  };
}

/**
 * Whitelist the metadata keys we send through to iOS. The dispatcher
 * payload's `metadata` field is shared across every channel — Telegram
 * stuffs an `replyMarkup` keyboard in there, future channels will add
 * their own extras — and forwarding the lot to APNs leaks
 * channel-specific payload structures into the APNs userInfo Apple
 * sees plus the iOS app's notification handler.
 *
 * Allowed keys are the ones the iOS app actually reads. Add a new key
 * here as iOS gains support for it.
 */
const IOS_METADATA_ALLOWLIST = new Set([
  "scheduledAt",
  "localDate",
  "medicationId",
  "scheduleId",
  "phase",
  "date",
  // v1.16.11 — MEDICATION_LOW_STOCK deep link + context: the in-app
  // path the push should open (`/medications/{id}?tab=supply`) plus
  // the runway / threshold figures the iOS handler can surface.
  "url",
  "runwayDays",
  "thresholdDays",
  // v1.18.7 — MEASUREMENT_REMINDER carries the reminder's id so a
  // foreground / handled notification can POST the completion directly
  // instead of routing through the capture deep link.
  "reminderId",
]);

function pickIosMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!metadata) return {};
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(metadata)) {
    if (IOS_METADATA_ALLOWLIST.has(key)) {
      out[key] = metadata[key];
    }
  }
  return out;
}

/**
 * Metadata keys that exist so the iOS app can ACT on the notification rather
 * than merely read it. Dropped when the producer says the dispatch carries no
 * completion affordance.
 */
const ACTION_METADATA_KEYS = new Set(["reminderId"]);

/**
 * Strip the act-on-it keys from a payload whose actions the server will refuse.
 *
 * An appointment nudge rides the same `MEASUREMENT_REMINDER` event type as a
 * checkup, so the iOS app would offer the registered "Erledigt" action and
 * POST a completion the by-id reminder family answers 404 for. Removing the
 * id is what removes the action: the handler has nothing to complete.
 */
function stripActionMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!metadata) return metadata;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(metadata)) {
    if (!ACTION_METADATA_KEYS.has(key)) out[key] = metadata[key];
  }
  return out;
}

/** Cycle-semantic metadata keys that must never ride a discreet payload. */
const CYCLE_METADATA_KEYS = new Set(["phase"]);

/**
 * Drop cycle-semantic metadata (e.g. `phase`) so a discreet cycle push can't
 * name a cycle concept on the wire even though the allowlist permits the key.
 */
function stripCycleMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!metadata) return metadata;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(metadata)) {
    if (!CYCLE_METADATA_KEYS.has(key)) out[key] = metadata[key];
  }
  return out;
}
