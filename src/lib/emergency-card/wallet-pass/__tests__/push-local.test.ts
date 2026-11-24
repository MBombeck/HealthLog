import { beforeEach, describe, expect, it, vi } from "vitest";

const apn = vi.hoisted(() => ({
  options: [] as unknown[],
  notes: [] as Array<{
    topic?: string;
    rawPayload?: unknown;
    pushType?: string;
  }>,
  send: vi.fn(),
}));
vi.mock("@parse/node-apn", () => {
  class Provider {
    constructor(options: unknown) {
      apn.options.push(options);
    }
    send(note: never, recipients: string[]) {
      apn.notes.push(note);
      return apn.send(note, recipients);
    }
    shutdown() {
      return Promise.resolve();
    }
  }
  class Notification {
    topic?: string;
    rawPayload?: unknown;
    pushType?: string;
  }
  return { default: { Provider, Notification } };
});

import {
  resetLocalPassPushForTesting,
  sendLocalPassPushes,
} from "../push-local";
import type { LocalWalletIdentity } from "../local-signer";

const identity = {
  passTypeIdentifier: "pass.org.example.emergency",
  teamIdentifier: "ABCDE12345",
  organization: "Example",
  certNotAfter: new Date("2030-01-01"),
  signer: {
    certificatePem:
      "-----BEGIN CERTIFICATE-----\nAA\n-----END CERTIFICATE-----\n",
    privateKey: "-----BEGIN PRIVATE KEY-----\nAA\n-----END PRIVATE KEY-----\n",
    intermediatePem: "",
  },
} as LocalWalletIdentity;

const items = [
  { ref: "a", token: "aa".repeat(32) },
  { ref: "b", token: "bb".repeat(32) },
  { ref: "c", token: "cc".repeat(32) },
  { ref: "d", token: "dd".repeat(32) },
];

beforeEach(() => {
  resetLocalPassPushForTesting();
  apn.options.length = 0;
  apn.notes.length = 0;
  apn.send.mockReset();
});

describe("local pass pushes", () => {
  it("sends `{}` to the Pass Type ID topic with no push type, production, the pass certificate", async () => {
    apn.send.mockResolvedValue({
      sent: [{ device: items[0].token }],
      failed: [
        {
          device: items[1].token,
          status: 410,
          response: { reason: "Unregistered" },
        },
        {
          device: items[2].token,
          status: 400,
          response: { reason: "BadTopic" },
        },
        {
          device: items[3].token,
          status: 429,
          response: { reason: "TooManyRequests" },
        },
      ],
    });
    const out = await sendLocalPassPushes(identity, items);
    expect(Object.fromEntries(out)).toEqual({
      a: "accepted",
      b: "unregistered",
      c: "rejected",
      d: "token_quota",
    });
    expect(apn.notes[0].topic).toBe(identity.passTypeIdentifier);
    expect(apn.notes[0].rawPayload).toEqual({});
    expect(apn.notes[0].pushType).toBeUndefined();
    expect(apn.options[0]).toMatchObject({
      cert: identity.signer.certificatePem,
      key: identity.signer.privateKey,
      production: true,
    });
    expect(apn.options[0]).not.toHaveProperty("token");
  });

  it("answers unavailable for every item when the provider fails", async () => {
    apn.send.mockRejectedValue(new Error("socket hang up"));
    const out = await sendLocalPassPushes(identity, items.slice(0, 2));
    expect([...out.values()]).toEqual(["unavailable", "unavailable"]);
  });

  it("sends nothing for no items", async () => {
    expect((await sendLocalPassPushes(identity, [])).size).toBe(0);
    expect(apn.send).not.toHaveBeenCalled();
  });
});
