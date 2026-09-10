/**
 * A rejection the server names has to reach the input it belongs to.
 *
 * `PUT /api/auth/profile` writes field by field and reports the fields
 * it refused. The onboarding step read that report only far enough to
 * flash a toast and then walked the person to the next screen, so an
 * out-of-range height was gone by the time anyone could act on it and
 * the wizard counted the account as set up regardless.
 *
 * This runs the whole strip — build the body, PUT it over a stubbed
 * `fetch`, read the answer, render the real inputs with what came back
 * — because the gap was in the join, not in either end. The English
 * bundle is the shipped one, so a sentence that reads as a key or
 * leaks validator prose fails here.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import { getCachedMessages } from "@/lib/i18n/load-locale";
import { resolveKey } from "@/lib/i18n/resolve-key";
import {
  EMPTY_HEIGHT_DRAFT,
  resolveHeightUnitAdapter,
} from "@/lib/profile/height-unit-display";
import { BaselineFields } from "../baseline-fields";
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

function stubProfilePut(status: number, body: unknown) {
  vi.stubGlobal("fetch", () =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );
}

/** Render the step's inputs exactly as the step renders them. */
function renderFields(errors: Record<string, string>) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <BaselineFields
        value={{
          displayName: FILLED_FORM.displayName,
          height: { ...EMPTY_HEIGHT_DRAFT, cm: "940" },
          dateOfBirth: FILLED_FORM.dateOfBirth,
          gender: FILLED_FORM.gender,
        }}
        onChange={vi.fn()}
        heightAdapter={resolveHeightUnitAdapter("metric")}
        errors={errors}
      />
    </I18nProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a refused baseline field reaches its own input", () => {
  it("paints the reason in the height field's slot and holds the step", async () => {
    stubProfilePut(200, {
      data: {
        id: "u1",
        displayName: "Robin",
        rejectedFields: [{ path: "heightCm", code: "too_big" }],
      },
      error: null,
    });

    const en = translator("en");
    const outcome = describeBaselineSaveOutcome(
      await putBaselineProfile(buildBaselineProfileBody(FILLED_FORM, 940)),
      en,
      baselineFieldLabelKeys(false),
    );

    // A field was refused: the wizard stays put and does not stamp the
    // account as finished behind the person's back.
    expect(outcome.advance).toBe(false);
    expect(outcome.fieldErrors).toEqual({
      heightCm: en("settings.profileRejection.tooBig"),
    });

    // What the outcome produced is what the input renders — no second
    // mapping in between for a rename to fall through.
    const html = renderFields(outcome.fieldErrors);
    expect(html).toContain(en("settings.profileRejection.tooBig"));
    // Neither a bare key nor the validator's own vocabulary.
    expect(html).not.toContain("settings.profileRejection");
    expect(html).not.toContain("too_big");
    // Announced with the input, not merely painted beside it.
    expect(html).toContain('id="ob-baseline-height-error"');
    expect(html).toContain('aria-describedby="ob-baseline-height-error"');
    expect(html).toContain('aria-invalid="true"');
  });

  it("leaves every accepted field's slot empty", async () => {
    stubProfilePut(200, { data: { id: "u1" }, error: null });

    const outcome = describeBaselineSaveOutcome(
      await putBaselineProfile(buildBaselineProfileBody(FILLED_FORM, 178)),
      translator("en"),
      baselineFieldLabelKeys(false),
    );

    expect(outcome.advance).toBe(true);
    expect(outcome.fieldErrors).toEqual({});
    // (`aria-invalid:` also appears inside the primitives' Tailwind
    // class strings, so the assertion is on the rendered attribute.)
    const html = renderFields({});
    expect(html).not.toContain('aria-invalid="true"');
    expect(html).not.toContain('role="alert"');
  });

  it("names every refused field, not only the first", async () => {
    stubProfilePut(422, {
      data: null,
      error: 'Nothing was saved. Fix the "dateOfBirth" field and try again.',
      meta: { errorCode: "profile.update.nothingSaved" },
      details: {
        issues: [
          { path: "dateOfBirth", code: "invalid_value" },
          { path: "gender", code: "invalid_value" },
        ],
      },
    });

    const outcome = describeBaselineSaveOutcome(
      await putBaselineProfile(buildBaselineProfileBody(FILLED_FORM, null)),
      translator("de"),
      baselineFieldLabelKeys(false),
    );

    expect(outcome.advance).toBe(false);
    expect(Object.keys(outcome.fieldErrors).sort()).toEqual([
      "dateOfBirth",
      "gender",
    ]);
    // The person's language, not the validator's.
    const de = translator("de");
    expect(outcome.fieldErrors.gender).toBe(
      de("settings.profileRejection.invalidValue"),
    );
    expect(outcome.fieldErrors.gender).not.toContain("invalid_value");
  });
});
