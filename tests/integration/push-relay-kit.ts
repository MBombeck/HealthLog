/**
 * Shared steps of the push relay integration tests: turn the relay on as an
 * admin, and register a device bound through the fake relay.
 */
import { expect } from "vitest";

import { callRoute } from "../kit/call-route";
import {
  makeAdmin,
  makeSession,
  makeUser,
  type SessionFixture,
} from "../kit/factories";
import { RELAY_HOST } from "./push-relay-fake";
import { RELAY_CONSENT_TEXT_VERSION } from "@/lib/push-relay/config";
import { generateX25519 } from "@/lib/push-relay/hpke";
import { tokenTagHex } from "@/lib/push-relay/encoding";
import {
  bindText,
  generateEd25519,
  signText,
} from "@/lib/push-relay/statements";

export async function enableRelay(): Promise<{
  instanceId: string;
  admin: { id: string };
  adminSession: SessionFixture;
}> {
  const { PUT } = await import("@/app/api/admin/push-relay/route");
  const admin = await makeAdmin();
  const adminSession = await makeSession(admin);
  const res = await callRoute<{ instanceId: string }>(PUT, {
    method: "PUT",
    route: "/api/admin/push-relay",
    auth: adminSession,
    body: { enabled: true, acceptTerms: true, householdOnly: true },
  });
  return { instanceId: res.data.instanceId, admin, adminSession };
}

export function deviceBody(
  instanceId: string,
  token: string,
  extra: Record<string, unknown> = {},
) {
  const binding = generateEd25519();
  const pushKey = generateX25519();
  const statement = {
    instanceId,
    tokenTag: tokenTagHex(token) as string,
    kind: "device" as const,
    seq: 1,
    iat: Math.floor(Date.now() / 1000),
  };
  return {
    body: {
      token: `device-${token.slice(0, 6)}`,
      bundleId: "dev.healthlog.app",
      apnsToken: token,
      apnsEnvironment: "production",
      medicationDelivery: "client",
      pushKey: {
        v: 1,
        suites: [1],
        publicKey: pushKey.publicKey.toString("base64url"),
      },
      relayConsent: { granted: true, textVersion: RELAY_CONSENT_TEXT_VERSION },
      relayBinding: {
        bindingKey: binding.publicKey.toString("base64url"),
        statement,
        signature: signText(
          binding.seed,
          bindText({ host: RELAY_HOST, ...statement }),
        ).toString("base64url"),
      },
      ...extra,
    },
    pushKey,
    binding,
  };
}

export async function registerDevice(
  session: SessionFixture,
  body: Record<string, unknown>,
) {
  const { POST } = await import("@/app/api/devices/route");
  return callRoute<{ id: string; push: Record<string, unknown> }>(POST, {
    method: "POST",
    route: "/api/devices",
    auth: session,
    body,
  });
}

/** A device bound through the relay, for a new account or `session`'s. */
export async function bindDevice(
  instanceId: string,
  token: string,
  session?: SessionFixture,
) {
  const owner = session ?? (await makeSession(await makeUser()));
  const { body, pushKey, binding } = deviceBody(instanceId, token);
  const res = await registerDevice(owner, body);
  expect(res.data.push.relayState).toBe("bound");
  return { session: owner, deviceId: res.data.id, pushKey, binding };
}
