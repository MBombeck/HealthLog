/**
 * The onboarding baseline step used to submit the profile and throw the
 * server's answer away. A height the server declined vanished between
 * the input and the next screen, and the person walked off believing it
 * was stored.
 *
 * These tests run the real assembly end to end — build the body, PUT it
 * over a stubbed `fetch`, read the reply — because the gap was never in
 * either end on its own. They use the real English and German bundles,
 * so a sentence that reads as a key or leaks validator prose fails here.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { getCachedMessages } from "@/lib/i18n/load-locale";
import { resolveKey } from "@/lib/i18n/resolve-key";
import {
  baselineFieldLabelKeys,
  buildBaselineProfileBody,
  describeBaselineSaveOutcome,
  putBaselineProfile,
} from "../baseline-form-utils";

/** A `t` backed by the shipped bundle — no stand-in strings. */
function translator(locale: "en" | "de") {
  const bundle = getCachedMessages(locale);
  if (!bundle) throw new Error(`No cached bundle for ${locale}`);
  return (key: string, params?: Record<string, string | number>) => {
    const raw = resolveKey(bundle as Record<string, unknown>, key);
    if (raw === undefined) return key;
    return Object.entries(params ?? {}).reduce(
      (acc, [name, value]) => acc.replaceAll(`{${name}}`, String(value)),
      raw,
    );
  };
}

const FILLED_FORM = {
  displayName: "Robin",
  dateOfBirth: "1988-04-02",
  gender: "OTHER",
};

/** Stub `fetch` with one canned response and capture what was sent. */
function stubProfilePut(status: number, body: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    );
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("onboarding baseline profile save", () => {
  it("names the rejected field, keeps the accepted ones, and holds the step", async () => {
    const calls = stubProfilePut(200, {
      data: {
        id: "u1",
        displayName: "Robin",
        rejectedFields: [{ path: "heightCm", code: "too_big" }],
      },
      error: null,
    });

    const body = buildBaselineProfileBody(FILLED_FORM, 940);
    const outcome = describeBaselineSaveOutcome(
      await putBaselineProfile(body),
      translator("en"),
      baselineFieldLabelKeys(false),
    );

    // Everything the person filled in travelled to the server; nothing
    // was withheld because one sibling was going to be refused.
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/api/auth/profile");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      displayName: "Robin",
      heightCm: 940,
      dateOfBirth: "1988-04-02",
      gender: "OTHER",
    });

    // The accepted fields are saved, and the declined one is said out
    // loud by the name this screen put next to the input.
    expect(outcome.notice).toEqual({
      tone: "warning",
      message: "Profile saved, but Height (cm) could not be updated.",
    });
    // This assertion was `true` until the rejection reached the input
    // it belongs to. Advancing here posted `step: 4`, stamped the
    // account as set up and replaced the only screen that could show
    // the refused value — a toast on the way out was the whole notice
    // the person got. The step now waits for a correction.
    expect(outcome.advance).toBe(false);
    expect(outcome.fieldErrors.heightCm).toBe(
      "That value is above the range this field accepts.",
    );
  });

  it("says nothing when every field was accepted", async () => {
    stubProfilePut(200, { data: { id: "u1" }, error: null });

    const outcome = describeBaselineSaveOutcome(
      await putBaselineProfile(buildBaselineProfileBody(FILLED_FORM, 178)),
      translator("en"),
      baselineFieldLabelKeys(false),
    );

    expect(outcome).toEqual({ advance: true, notice: null, fieldErrors: {} });
  });

  it("names the blocking field and holds the step when nothing was saved", async () => {
    stubProfilePut(422, {
      data: null,
      error: 'Nothing was saved. Fix the "dateOfBirth" field and try again.',
      meta: { errorCode: "profile.update.nothingSaved" },
      details: { issues: [{ path: "dateOfBirth", code: "invalid_value" }] },
    });

    const outcome = describeBaselineSaveOutcome(
      await putBaselineProfile(buildBaselineProfileBody(FILLED_FORM, null)),
      translator("en"),
      baselineFieldLabelKeys(false),
    );

    expect(outcome.advance).toBe(false);
    expect(outcome.notice?.tone).toBe("error");
    expect(outcome.notice?.message).toBe(
      "Nothing was saved. Fix Date of birth and try again.",
    );
    // The server's own sentence carries a schema key in quotes; it must
    // not be what the person reads.
    expect(outcome.notice?.message).not.toContain("dateOfBirth");
  });

  it("speaks the person's language, not the validator's", async () => {
    stubProfilePut(200, {
      data: { rejectedFields: [{ path: "gender", code: "invalid_value" }] },
      error: null,
    });

    const outcome = describeBaselineSaveOutcome(
      await putBaselineProfile(buildBaselineProfileBody(FILLED_FORM, 178)),
      translator("de"),
      baselineFieldLabelKeys(false),
    );

    const de = translator("de");
    expect(outcome.notice?.message).toBe(
      de("settings.profilePartiallySaved", {
        field: de("onboarding.baseline.genderLabel"),
      }),
    );
    expect(outcome.notice?.message).not.toContain("settings.");
    expect(outcome.notice?.message).not.toContain("invalid_value");
  });

  it("uses the feet-and-inches label when that is what the person read", () => {
    const outcome = describeBaselineSaveOutcome(
      {
        ok: true,
        body: { data: { rejectedFields: [{ path: "heightCm", code: "x" }] } },
      },
      translator("en"),
      baselineFieldLabelKeys(true),
    );
    expect(outcome.notice?.message).toContain("Height (ft, in)");
  });

  it("falls back to the step's own sentence for a failure with no field detail", async () => {
    stubProfilePut(500, { data: null, error: "boom" });

    const outcome = describeBaselineSaveOutcome(
      await putBaselineProfile(buildBaselineProfileBody(FILLED_FORM, 178)),
      translator("en"),
      baselineFieldLabelKeys(false),
    );

    expect(outcome.advance).toBe(false);
    expect(outcome.notice?.message).toBe(
      "Something went wrong while finishing setup. Please try again.",
    );
    expect(outcome.notice?.message).not.toContain("boom");
  });
});
