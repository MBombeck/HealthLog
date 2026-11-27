/**
 * The Live Activity fields of `POST /api/devices`, beside the relay fields
 * (`device-registration.ts`):
 *
 * - `liveActivityConsent { textVersion, iat, signature }`: the device's
 *   `hl-la-consent-v1`. Checked here against the device's binding key, this
 *   instance and the device token, then passed on unchanged to the relay
 *   (`POST /v1/bindings/liveactivity`), which records it with the binding.
 *   It counts only once the relay took it: the relay refuses a start or
 *   update without it. The statement's `iat` must be within 300 s, so it is
 *   passed on at once and never kept for later.
 * - `liveActivityWithdraw { iat, signature }`: the device's
 *   `hl-la-withdraw-v1`. Checked the same way; the consent is dropped here
 *   and at the relay (`DELETE /v1/bindings/liveactivity`). The app may also
 *   send the same statement to the relay directly.
 * - `liveActivityStart { token, statement, signature } | null`: the
 *   ActivityKit push-to-start token and the device's `hl-la-start-v1` over
 *   it (`statement.laTokenTag` is the start token's tag). Kept and handed to
 *   the relay only inside a start push.
 *
 * All three need a device that is bound to the relay with the relay consent:
 * the binding key is what signs them.
 */
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { getEvent } from "@/lib/logging/context";
import { endRelayStartedActivities } from "@/lib/push-relay/live-activity";
import { relayConfig } from "@/lib/push-relay/config";
import { tokenTagHex } from "@/lib/push-relay/encoding";
import { loadRegistration, relayCall } from "@/lib/push-relay/registration";
import {
  laConsentText,
  laStartText,
  laWithdrawText,
  verifyEncoded,
} from "@/lib/push-relay/statements";

/** How far a consent or withdrawal `iat` may lie from this server's clock. */
const SKEW_S = 300;
/** The relay accepts a start statement at most 30 days old. */
const START_MAX_AGE_S = 30 * 24 * 3600;

export interface LiveActivityInput {
  apnsToken?: string;
  relayBinding?: { bindingKey: string };
  relayConsent?: { granted: boolean };
  liveActivityConsent?: { textVersion: string; iat: number; signature: string };
  liveActivityWithdraw?: { iat: number; signature: string };
  liveActivityStart?: {
    token: string;
    statement: {
      instanceId: string;
      tokenTag: string;
      laTokenTag: string;
      iat: number;
    };
    signature: string;
  } | null;
}

export type LiveActivityRefusal =
  | "relay_consent_required"
  | "instance_mismatch"
  | "token_mismatch"
  | "bad_signature"
  | "statement_stale";

/**
 * Check the Live Activity statements against the device's binding key, this
 * instance and the device token. Returns the refusal, if any.
 */
export async function checkLiveActivityFields(
  input: LiveActivityInput,
  stored: {
    apnsToken: string | null;
    relayConsentAt?: Date | null;
    relayBindingKey?: string | null;
  } | null,
  nowS: number = Math.floor(Date.now() / 1000),
): Promise<LiveActivityRefusal | null> {
  const consent = input.liveActivityConsent;
  const withdraw = input.liveActivityWithdraw;
  const start = input.liveActivityStart;
  if (!consent && !withdraw && !start) return null;
  const bindingKey = input.relayBinding?.bindingKey ?? stored?.relayBindingKey;
  const relayConsented =
    input.relayConsent?.granted === true ||
    (Boolean(stored?.relayConsentAt) && input.relayConsent?.granted !== false);
  const apnsToken = input.apnsToken ?? stored?.apnsToken;
  if (!bindingKey || !relayConsented || !apnsToken) {
    return "relay_consent_required";
  }
  const config = relayConfig();
  const registration = config.available ? await loadRegistration(config) : null;
  const instanceId = registration?.instanceId;
  if (!instanceId) return "relay_consent_required";
  const tokenTag = tokenTagHex(apnsToken) as string;
  const base = { host: config.host, instanceId, tokenTag };
  if (consent) {
    if (Math.abs(consent.iat - nowS) > SKEW_S) return "statement_stale";
    const text = laConsentText({ ...base, ...consent });
    if (!verifyEncoded(bindingKey, text, consent.signature)) {
      return "bad_signature";
    }
  }
  if (withdraw) {
    if (Math.abs(withdraw.iat - nowS) > SKEW_S) return "statement_stale";
    const text = laWithdrawText({ ...base, iat: withdraw.iat });
    if (!verifyEncoded(bindingKey, text, withdraw.signature)) {
      return "bad_signature";
    }
  }
  if (start) {
    const st = start.statement;
    if (st.instanceId !== instanceId) return "instance_mismatch";
    if (
      st.tokenTag !== tokenTag ||
      st.laTokenTag !== tokenTagHex(start.token.toLowerCase())
    ) {
      return "token_mismatch";
    }
    if (st.iat > nowS + SKEW_S || nowS - st.iat > START_MAX_AGE_S) {
      return "statement_stale";
    }
    const text = laStartText({
      ...base,
      startTokenTag: st.laTokenTag,
      iat: st.iat,
    });
    if (!verifyEncoded(bindingKey, text, start.signature)) {
      return "bad_signature";
    }
  }
  return null;
}

/** The UTC day the relay stores with a consent. */
function utcDay(date: Date): string {
  // eslint-disable-next-line healthlog/no-utc-day-key -- UTC by design: the relay protocol keeps consent days in UTC
  return date.toISOString().slice(0, 10);
}

/** Pass a checked consent on to the relay; true when the relay took it. */
async function forwardConsent(
  device: { apnsToken: string; relayBindingKey: string },
  consent: { textVersion: string; iat: number; signature: string },
): Promise<boolean> {
  const config = relayConfig();
  const registration = config.available ? await loadRegistration(config) : null;
  if (!registration) return false;
  const result = await relayCall(
    registration,
    "POST",
    "/v1/bindings/liveactivity",
    {
      token: device.apnsToken.toLowerCase(),
      bindingKey: device.relayBindingKey,
      consent: {
        textVersion: consent.textVersion,
        day: utcDay(new Date()),
        iat: consent.iat,
      },
      signature: consent.signature,
    },
    config,
  );
  const status = result.kind === "transport" ? 0 : result.status;
  getEvent()?.addMeta("push_relay_la_consent_status", status);
  return status === 200;
}

/** Drop the consent at the relay; the relay answers 204 for any token. */
async function removeConsentAtRelay(apnsToken: string): Promise<void> {
  const config = relayConfig();
  const registration = config.available ? await loadRegistration(config) : null;
  if (!registration) return;
  const result = await relayCall(
    registration,
    "DELETE",
    "/v1/bindings/liveactivity",
    { token: apnsToken.toLowerCase() },
    config,
  );
  getEvent()?.addMeta(
    "push_relay_la_withdraw_status",
    result.kind === "transport" ? 0 : result.status,
  );
}

/** Write the checked Live Activity fields onto the device. */
export async function applyLiveActivityFields(
  deviceId: string,
  input: LiveActivityInput,
): Promise<void> {
  const device = await prisma.device.findUnique({
    where: { id: deviceId },
    select: { apnsToken: true, relayBindingKey: true, relayState: true },
  });
  if (!device?.apnsToken) return;
  if (input.liveActivityWithdraw) {
    // What the relay started ends first, while the relay still holds the
    // consent: nothing updates it once the consent is gone.
    await endRelayStartedActivities(deviceId);
    await prisma.device.update({
      where: { id: deviceId },
      data: { liveActivityConsentAt: null, liveActivityConsentVersion: null },
    });
    await removeConsentAtRelay(device.apnsToken);
  } else if (
    input.liveActivityConsent &&
    device.relayBindingKey &&
    device.relayState === "bound"
  ) {
    const taken = await forwardConsent(
      { apnsToken: device.apnsToken, relayBindingKey: device.relayBindingKey },
      input.liveActivityConsent,
    );
    if (taken) {
      await prisma.device.update({
        where: { id: deviceId },
        data: {
          liveActivityConsentAt: new Date(),
          liveActivityConsentVersion: input.liveActivityConsent.textVersion,
        },
      });
    }
  }
  if (input.liveActivityStart === null) {
    await prisma.device.update({
      where: { id: deviceId },
      data: clearedStartFields(),
    });
  } else if (input.liveActivityStart) {
    await prisma.device.update({
      where: { id: deviceId },
      data: {
        laStartToken: input.liveActivityStart.token.toLowerCase(),
        laStartStatement: input.liveActivityStart.statement,
        laStartSignature: input.liveActivityStart.signature,
      },
    });
  }
}

/** The push-to-start fields of a device, cleared. */
export function clearedStartFields() {
  return {
    laStartToken: null,
    laStartStatement: Prisma.DbNull,
    laStartSignature: null,
  };
}
