/**
 * The delete confirmation says when a sync will bring the row back.
 *
 * The integrations below clear `deletedAt` when they read a row again, so a
 * deletion of one of their rows lasts until the next sync. The dialog used to
 * say only "This measurement will be deleted" for every source.
 */
import { describe, expect, it } from "vitest";

import { deleteConfirmDescription } from "@/components/measurements/list/row-actions";

const t = ((key: string) => key) as Parameters<
  typeof deleteConfirmDescription
>[1];

describe("deleteConfirmDescription", () => {
  it.each(["WITHINGS", "NIGHTSCOUT", "GOOGLE_HEALTH", "OURA", "GARMIN"])(
    "warns that a %s row comes back with the next sync",
    (source) => {
      expect(deleteConfirmDescription({ source } as never, t)).toBe(
        "measurements.deleteConfirmDescriptionSynced",
      );
    },
  );

  it.each(["MANUAL", "APPLE_HEALTH", "IMPORT"])(
    "keeps the plain text for a %s row",
    (source) => {
      expect(deleteConfirmDescription({ source } as never, t)).toBe(
        "measurements.deleteConfirmDescription",
      );
    },
  );
});
