/**
 * What the push relay carries is pinned to the consent text that describes
 * it.
 *
 * The admin's switch and the app's card ask for consent to a described set
 * of pushes. In 1.49.0 the relay began to carry medication reminders while
 * both texts still said reminders stay on the device, and the text versions
 * stayed where they were: behaviour moved after the text was frozen, and
 * nothing noticed. This guard fingerprints what decides the relay's traffic
 * (which alert kinds it carries, for whom, how long a push lives, which
 * files hand pushes to it, which Live Activity events it may carry) together
 * with the English consent text, and holds the fingerprint against
 * `RELAY_CONSENT_TEXT_VERSION` and `RELAY_TERMS_VERSION`.
 *
 * When it fails: rewrite the consent texts in every locale and in
 * `docs/integrations/push-relay.md` so they describe the new behaviour, raise
 * both versions in `src/lib/push-relay/config.ts` (operators then confirm the
 * new text once, devices see the card again), and append a `PINS` entry with
 * the new version and the fingerprint the failure prints. An entry cannot
 * reuse a version or a fingerprint, so the pin cannot move without the
 * version moving with it. Tell the app team: their card text has the same
 * version.
 *
 * A tripwire, not a proof: it cannot tell whether the text is right, only
 * that it was looked at when the behaviour changed.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import en from "../../messages/en.json";
import { relayCarries } from "@/lib/push-relay/apns-channel";
import {
  LIVE_ACTIVITY_EVENTS,
  LIVE_ACTIVITY_RELAY_EVENTS,
  RELAY_CONSENT_TEXT_VERSION,
  RELAY_TERMS_VERSION,
} from "@/lib/push-relay/config";
import { RELAY_CLASS_LIFETIME_S } from "@/lib/push-relay/relay-send";
import { EVENT_TYPES } from "@/lib/notifications/types";
import { scanSourceMatches } from "./helpers/source-files";

/** Each consent text version, with the behaviour it describes. */
const PINS: ReadonlyArray<{ version: string; fingerprint: string }> = [
  {
    version: "2026-11-22",
    fingerprint:
      "fe6bc17f59cd82cf7ee0fccd9571455804fe947a5e02c66ce6ab14fb553398b7",
  },
];

/** The calls that hand a push to the relay, directly or through a helper. */
const RELAY_SEND_CALL =
  /\b(sendSealed|sendRelayItems|sendWake|sendSealedIntakeSync|sendSealedIntakeRecorded|sendApnsChannel)\(/g;

function carriedMatrix() {
  const device = { id: "device" };
  return EVENT_TYPES.map((eventType) => {
    const base = { title: "t", message: "m", eventType };
    const own = relayCarries(base, device, new Set(["device"]));
    const ownNotChosen = relayCarries(base, device, new Set());
    const guardian = relayCarries(
      { ...base, recordUserId: "record", recipientUserId: "guardian" },
      device,
      new Set(["device"]),
    );
    return [eventType, own, ownNotChosen, guardian];
  });
}

function senderFiles(): string[] {
  const matches = scanSourceMatches(
    join(process.cwd(), "src", "lib"),
    RELAY_SEND_CALL,
    {
      fileFloor: 500,
      matchFloor: 8,
      stripComments: true,
      include: (rel) => !rel.includes("__tests__"),
    },
  );
  return [...new Set(matches.map((m) => m.file))].sort();
}

function fingerprint(): string {
  const relay = en.admin.pushRelay;
  const material = {
    carried: carriedMatrix(),
    lifetimes: RELAY_CLASS_LIFETIME_S,
    senders: senderFiles(),
    liveActivity: [...LIVE_ACTIVITY_EVENTS, ...LIVE_ACTIVITY_RELAY_EVENTS],
    text: [
      relay.whatItSees,
      relay.seesWhen,
      relay.seesTiming,
      relay.dialogBody,
      relay.disableBody,
    ],
  };
  return createHash("sha256").update(JSON.stringify(material)).digest("hex");
}

describe("relay consent pin", () => {
  it("finds the relay senders it fingerprints", () => {
    // An empty match set would pin nothing and pass forever.
    expect(senderFiles().length).toBeGreaterThanOrEqual(8);
    expect(carriedMatrix().length).toBe(EVENT_TYPES.length);
  });

  it("raises the consent version whenever what the relay carries changes", () => {
    const current = fingerprint();
    const last = PINS[PINS.length - 1]!;
    expect(
      { version: RELAY_CONSENT_TEXT_VERSION, fingerprint: current },
      "What the relay carries, or its consent text, changed. Update the texts and the docs, raise RELAY_CONSENT_TEXT_VERSION and RELAY_TERMS_VERSION, and append a PINS entry (see the file header).",
    ).toEqual(last);
    expect(RELAY_TERMS_VERSION).toBe(RELAY_CONSENT_TEXT_VERSION);
  });

  it("never reuses a version or a fingerprint", () => {
    expect(new Set(PINS.map((p) => p.version)).size).toBe(PINS.length);
    expect(new Set(PINS.map((p) => p.fingerprint)).size).toBe(PINS.length);
  });
});
