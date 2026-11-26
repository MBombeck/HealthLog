/**
 * What the push relay carries is pinned to the consent text that describes
 * it.
 *
 * The admin's switch and the app's card ask for consent to a described set
 * of pushes. In 1.49.0 the relay began to carry medication reminders while
 * both texts still said reminders stay on the device, and the text versions
 * stayed where they were: behaviour moved after the text was frozen, and
 * nothing noticed. This guard fingerprints what decides the relay's traffic
 * together with the English consent text, and holds the fingerprint against
 * `RELAY_CONSENT_TEXT_VERSION` and `RELAY_TERMS_VERSION`:
 *
 * - which alert kinds it carries and for whom, how long a push lives, which
 *   files hand pushes to it, which Live Activity events it may carry;
 * - the push kinds by class (the alert and silent `type`s), and what a dose
 *   confirmation can say (`RECORDED_OUTCOMES`);
 * - the occasions: every file outside the relay's senders that starts a
 *   relay push, with the functions it calls to do so (value imports from
 *   `OCCASION_MODULES`).
 *
 * The first version fingerprinted only the first group, and stayed green
 * while the relay began to send a `reopened` alert on every undo, a silent
 * sync on every dose change beside the confirmation, and one sync when a
 * device binds: none of that changed a kind, a lifetime or a sender file.
 *
 * When it fails, read the consent texts (`admin.pushRelay` in every locale,
 * the app's card) and `docs/integrations/push-relay.md` against the new
 * behaviour. Then one of two:
 *
 * - the text no longer says it truthfully: rewrite it in every locale and in
 *   the docs, raise both versions in `src/lib/push-relay/config.ts`
 *   (operators then confirm the new text once, devices see the card again),
 *   and append a `PINS` entry with the new version and the fingerprint the
 *   failure prints. Tell the app team: their card text has the same version.
 * - the text still covers it (a refactor that moved a call, a new push of a
 *   kind and on an occasion the text already names): append a `PINS` entry
 *   with the same version, the new fingerprint, and `covered`, saying what
 *   changed and which sentence covers it. Update the docs if they name
 *   occasions one by one.
 *
 * An entry never reuses a fingerprint, and a version repeats only with the
 * reason written down, so the pin cannot move unseen.
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
import {
  RECORDED_OUTCOMES,
  SYNC_EVENT,
} from "@/lib/push-relay/medication-pushes";
import { RELAY_CLASS_LIFETIME_S } from "@/lib/push-relay/relay-send";
import { WAKE_KINDS } from "@/lib/push-relay/wakes";
import { INTAKE_RECORDED_EVENT } from "@/lib/notifications/medication-intake-recorded";
import { EVENT_TYPES } from "@/lib/notifications/types";
import {
  readSourceText,
  scanSourceMatches,
  stripComments,
  walkSourceFiles,
} from "./helpers/source-files";

/**
 * Each consent text version, with the behaviour it describes. `covered`
 * marks a behaviour change the text already described (file header).
 */
const PINS: ReadonlyArray<{
  version: string;
  fingerprint: string;
  covered?: string;
}> = [
  {
    version: "2026-11-22",
    fingerprint:
      "fe6bc17f59cd82cf7ee0fccd9571455804fe947a5e02c66ce6ab14fb553398b7",
  },
  {
    version: "2026-11-22",
    fingerprint:
      "8721fda3744b0ef680bf142132dfd1f7754affe1de95236ba914101023281020",
    covered:
      "The pin now also holds the push kinds, the confirmation outcomes and the occasions. Reviewed against what came after the text: the `reopened` alert on an undo, edit, move, delete, bulk delete or purge, the silent sync on every dose change beside the confirmation, the one sync when a device binds, the repeated Live Activity end. Each is an alert or a silent sync to the person's own device at the moment something changed, which the texts name: `seesWhen` (an alert, a silent sync or the end of a Live Activity), `seesTiming` and `dialogBody` (that something happened at that moment, when a dose is due), and the app's card (when your server sends you something, which can show when you take medication). The docs list each occasion and the hourly status request.",
  },
  {
    version: "2026-11-22",
    fingerprint:
      "3743ffff22d5e495365660d02acbef7d0ef14fe6121b3baec8b80eef1c012b80",
    covered:
      "The owed intake sync reads which devices a send spent budget on and which the relay refused (`budgetSpentBy`, `owedBy` from `wakes.ts`). No new kind and no new occasion: a silent push the relay refuses for its budget is no longer retried with the same envelope but owed, and the minute pass sends one fresh sync (or puts a wake's domains back) once the relay's window frees. That is the owed sync the texts already cover: a silent sync to the person's own device after a dose changed (`seesWhen`, `seesTiming`), now never more of them than before and never before the relay said it takes one.",
  },
  {
    version: "2026-11-22",
    fingerprint:
      "9f9fe47a4ef87b86fe16ca06f6360b4e52d41baae0a8cc666c6fcf2749765792",
    covered:
      "A Live Activity start's outbox row keeps the dose it was for (`dose` on the item in `relay-send.ts`), stored on this server and never sent. No new kind, no new occasion, nothing more on the wire: the start the texts already name (`seesWhen`, a Live Activity start or update) now goes at most once per dose, where a start for another dose could make an earlier dose start twice.",
  },
  {
    version: "2026-11-22",
    fingerprint:
      "70ccb2966630eb10b7bf7399b7e0e7b56e9af39e6f34f32573b743b40d0edf80",
    covered:
      "The consent text got shorter, not different, and what the relay carries did not change. The paragraph above the dialog's checkboxes (`dialogBody`) and the card's second sentence (`whatItSees`) are gone; their facts stay where an admin reads them before saying yes: the question and the card say the content is end-to-end encrypted and the relay sees when something is sent (`question.body`, `description`), `seesWhen` and `seesTiming` (when a dose is due) stay word for word under What the relay sees on the card, and the dialog's three lines link the relay terms (household use, not a medical service) and the privacy notice the admin confirms having read. The fingerprint now holds the texts that remain.",
  },
  {
    version: "2026-11-22",
    fingerprint:
      "6206e05a39c88ecf921b603b8959dca0e23ffae865b4626938a0f5a917490db7",
    covered:
      "A new alert kind, `SYNC_STALLED`: the person's own devices are told once that a daily source went quiet, at most once a day and only in their daytime, sealed like every other alert with the source key as its only data. No new class, lifetime, sender file or occasion: it goes through the dispatcher's alert path the texts already name (`seesWhen`, an alert, when and of which kind), and its timing says no more than that the server sent an alert at that moment.",
  },
  {
    version: "2026-11-22",
    fingerprint:
      "2d3a8453cbcecf99101e9f6d372e6f8ebd4900e81e59fbdb3f253319db9164cf",
    covered:
      "A new alert kind, `EMERGENCY_CARD_WALLET_READY`: the person's own iPhone is told once per Wallet pass (at most twice per person) that the emergency card can be added to Wallet, sealed like every other alert with no data beyond its kind. No new class, lifetime, sender file or occasion: it goes through the dispatcher's alert path the texts already name (`seesWhen`, an alert, when and of which kind), and its timing says no more than that the server sent an alert at that moment.",
  },
];

/**
 * The modules whose exports start a relay push from something that happened
 * (a dose recorded or undone, a binding, new readings, a pass of a job).
 * Their senders inside are the first group; their importers are the
 * occasions.
 */
const OCCASION_MODULES = [
  "@/lib/notifications/medication-intake-recorded",
  "@/lib/notifications/medication-intake-sync",
  "@/lib/notifications/live-activity-answered",
  "@/lib/notifications/live-activity-end",
  "@/lib/push-relay/medication-pushes",
  "@/lib/push-relay/live-activity",
  "@/lib/push-relay/data-changed",
  "@/lib/push-relay/healthkit-catch-up",
  "@/lib/push-relay/wakes",
] as const;

/** A named value import: `import { a, b as c, type D } from "<module>"`. */
const NAMED_IMPORT =
  /import\s+(type\s+)?\{([^}]*)\}\s*from\s*"(@\/lib\/[^"]+)"/g;

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

/**
 * Every source file that imports a function from an occasion module, with the
 * functions: `file: a, b`. Types and constants (SCREAMING_CASE) are left out;
 * they start nothing.
 */
function occasions(): string[] {
  const modules = new Set<string>(OCCASION_MODULES);
  const lines: string[] = [];
  for (const rel of walkSourceFiles("src", { floor: 2000 })) {
    if (rel.includes("__tests__") || rel.startsWith("generated/")) continue;
    const source = stripComments(readSourceText(`src/${rel}`));
    const names = new Set<string>();
    for (const m of source.matchAll(NAMED_IMPORT)) {
      if (m[1] || !modules.has(m[3]!)) continue;
      for (const raw of m[2]!.split(",")) {
        const name = raw
          .trim()
          .split(/\s+as\s+/)[0]!
          .trim();
        if (!name || name.startsWith("type ")) continue;
        if (/^[A-Z0-9_]+$/.test(name)) continue;
        names.add(name);
      }
    }
    if (names.size > 0) lines.push(`${rel}: ${[...names].sort().join(", ")}`);
  }
  return lines.sort();
}

function fingerprint(): string {
  const relay = en.admin.pushRelay;
  const material = {
    carried: carriedMatrix(),
    lifetimes: RELAY_CLASS_LIFETIME_S,
    senders: senderFiles(),
    liveActivity: [...LIVE_ACTIVITY_EVENTS, ...LIVE_ACTIVITY_RELAY_EVENTS],
    kinds: {
      alert: [INTAKE_RECORDED_EVENT],
      silent: [SYNC_EVENT, ...WAKE_KINDS],
    },
    outcomes: RECORDED_OUTCOMES,
    occasions: occasions(),
    // What an admin reads before and while consenting: the card's sentence,
    // the question, what the relay sees (with the timing), the three
    // confirmations and what turning it off does.
    text: [
      relay.description,
      relay.question.body,
      relay.seesWhen,
      relay.seesTiming,
      relay.acceptTerms,
      relay.readPrivacy,
      relay.householdOnly,
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

  it("finds the occasions, the late ones included", () => {
    const found = occasions();
    expect(found.length).toBeGreaterThanOrEqual(20);
    // The three that changed after the text froze and that the first pin
    // did not see: the undo writers, the binding sync, the answered end.
    expect(found).toContain(
      "lib/medications/delete-intake-event.ts: reopenedEventOf",
    );
    expect(found).toContain("lib/push-relay/binding.ts: activateRelayBinding");
    expect(
      found.some((l) => l.startsWith("lib/jobs/push-live-activity.ts:")),
    ).toBe(true);
    expect(RECORDED_OUTCOMES).toContain("reopened");
  });

  it("raises the consent version whenever what the relay carries changes", () => {
    const current = fingerprint();
    const last = PINS[PINS.length - 1]!;
    expect(
      { version: RELAY_CONSENT_TEXT_VERSION, fingerprint: current },
      "What the relay carries, when it sends, or its consent text changed. Read the texts and the docs against it, then raise both versions or record why the text covers it, and append a PINS entry (see the file header).",
    ).toEqual({ version: last.version, fingerprint: last.fingerprint });
    expect(RELAY_TERMS_VERSION).toBe(RELAY_CONSENT_TEXT_VERSION);
  });

  it("never reuses a fingerprint, and repeats a version only with its reason", () => {
    expect(new Set(PINS.map((p) => p.fingerprint)).size).toBe(PINS.length);
    PINS.forEach((pin, i) => {
      const repeats = PINS.slice(0, i).some((p) => p.version === pin.version);
      expect(
        repeats ? (pin.covered ?? "").length > 40 : pin.covered === undefined,
        `PINS[${i}] (${pin.version}): a repeated version needs \`covered\`, a new one must not have it`,
      ).toBe(true);
    });
  });
});
