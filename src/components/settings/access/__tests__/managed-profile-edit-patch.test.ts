/**
 * What the managed-record edit form sends, and what it must not.
 *
 * The route reads an absent key as "leave it", so the diff this function
 * computes is the whole of the promise that a save touches only what somebody
 * moved. The case worth pinning is the language: a record with none opens its
 * control on the ACTOR's, so comparing the control against the record's column
 * made every save of such a record carry `locale` — and a guardian who only
 * corrected the timezone wrote their own language into somebody else's record.
 */
import { describe, expect, it } from "vitest";

import { managedProfileEditPatch } from "@/components/settings/access/managed-profile-edit-form";
import type { ManagedProfileView } from "@/lib/queries/use-managed-profiles";

const record: ManagedProfileView = {
  id: "rec_1",
  displayName: "Managed record",
  dateOfBirth: null,
  gender: null,
  locale: null,
  timezone: "Europe/Berlin",
  recordKind: "managed",
};

const draft = {
  displayName: "Managed record",
  dateOfBirth: "",
  locale: "en" as const,
  gender: null,
  timezone: "Europe/Berlin",
};

describe("managedProfileEditPatch", () => {
  it("leaves the language out when a record with none only moves its timezone", () => {
    const patch = managedProfileEditPatch(
      record,
      { ...draft, timezone: "Europe/Madrid" },
      "en",
    );

    expect(patch).toEqual({ timezone: "Europe/Madrid" });
  });

  it("answers null when a record with no language is not touched at all", () => {
    expect(managedProfileEditPatch(record, draft, "en")).toBeNull();
  });

  it("sends the language once somebody picks a different one", () => {
    const patch = managedProfileEditPatch(
      record,
      { ...draft, locale: "de" },
      "en",
    );

    expect(patch).toEqual({ locale: "de" });
  });

  it("sends the language when a record that has one is moved off it", () => {
    const patch = managedProfileEditPatch(
      { ...record, locale: "de" },
      { ...draft, locale: "en" },
      "de",
    );

    expect(patch).toEqual({ locale: "en" });
  });
});
