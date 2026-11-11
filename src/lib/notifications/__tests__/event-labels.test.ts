/**
 * Every event type the /notifications matrix renders has words to render.
 *
 * The matrix builds its rows from the event list the preferences read serves
 * (`eventTypesForRole`) and derives each row's label
 * and description key from the event name, so a new event type silently gets a
 * row whether or not anybody wrote the two strings for it. That is not a
 * theory: `SECURITY_ALERT` shipped in v1.23 and rendered the raw key
 * `notifications.eventSecurityAlert` in the matrix until v1.36.x, because
 * nothing anywhere asserted the pairing — the forward i18n coverage test only
 * sees literal `t("…")` call sites, and this key is assembled from a runtime
 * value.
 *
 * So this test walks the event list the page walks, computes the keys the page
 * computes, and asserts both resolve in every locale bundle.
 *
 * Mutation check: remove `notifications.eventSharedRecordIntakeDesc` from
 * `messages/pl.json` and this file reports
 * `pl is missing notifications.eventSharedRecordIntakeDesc`.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  UNSENT_EVENT_TYPES,
  eventTypesForRole,
} from "@/lib/notifications/types";
import {
  eventDescriptionTranslationKey,
  eventTranslationKey,
} from "@/lib/notifications/event-labels";

const MESSAGES_DIR = join(__dirname, "../../../../messages");

function bundle(locale: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(MESSAGES_DIR, `${locale}.json`), "utf8"),
  ) as Record<string, unknown>;
}

function resolve(root: Record<string, unknown>, key: string): unknown {
  return key
    .split(".")
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === "object"
          ? (node as Record<string, unknown>)[part]
          : undefined,
      root,
    );
}

const LOCALES = readdirSync(MESSAGES_DIR)
  .filter((f) => f.endsWith(".json"))
  .map((f) => f.replace(/\.json$/, ""));

describe("notification event labels", () => {
  it("derives the key the matrix renders under", () => {
    expect(eventTranslationKey("MEDICATION_REMINDER")).toBe(
      "notifications.eventMedicationReminder",
    );
    expect(eventDescriptionTranslationKey("SHARED_RECORD_INTAKE")).toBe(
      "notifications.eventSharedRecordIntakeDesc",
    );
  });

  it("has a label and a description for every listed event type, in every locale", () => {
    expect(LOCALES.length).toBeGreaterThanOrEqual(6);
    // ADMIN sees the widest list: every event that has a switch at all.
    const listed = eventTypesForRole("ADMIN");
    expect(listed.length).toBeGreaterThan(10);

    const missing: string[] = [];
    for (const locale of LOCALES) {
      const root = bundle(locale);
      for (const eventType of listed) {
        for (const key of [
          eventTranslationKey(eventType),
          eventDescriptionTranslationKey(eventType),
        ]) {
          const value = resolve(root, key);
          if (typeof value !== "string" || value.trim().length === 0) {
            missing.push(`${locale} is missing ${key}`);
          }
        }
      }
    }

    expect(missing).toEqual([]);
  });

  it("keeps no label for an event nothing sends", () => {
    const leftover: string[] = [];
    for (const locale of LOCALES) {
      const root = bundle(locale);
      for (const eventType of UNSENT_EVENT_TYPES) {
        for (const key of [
          eventTranslationKey(eventType),
          eventDescriptionTranslationKey(eventType),
        ]) {
          if (resolve(root, key) !== undefined) {
            leftover.push(`${locale} still has ${key}`);
          }
        }
      }
    }
    expect(leftover).toEqual([]);
  });
});

describe("the delegated-dose push copy", () => {
  it("interpolates the same names in every locale", () => {
    const keys = [
      "notifications.sharedRecordIntake.title",
      "notifications.sharedRecordIntake.bodyTaken",
      "notifications.sharedRecordIntake.bodySkipped",
    ];
    const placeholders: Record<string, string[]> = {
      "notifications.sharedRecordIntake.title": ["{name}"],
      "notifications.sharedRecordIntake.bodyTaken": ["{name}", "{medication}"],
      "notifications.sharedRecordIntake.bodySkipped": [
        "{name}",
        "{medication}",
      ],
    };

    for (const locale of LOCALES) {
      const root = bundle(locale);
      for (const key of keys) {
        const value = resolve(root, key);
        expect(typeof value, `${locale} ${key}`).toBe("string");
        for (const token of placeholders[key]) {
          expect(value as string, `${locale} ${key}`).toContain(token);
        }
      }
    }
  });
});
