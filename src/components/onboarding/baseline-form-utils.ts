import { apiFetchRaw } from "@/lib/api/api-fetch";
import {
  describeRejectedProfileField,
  describeRejectedProfileFields,
  type RejectedProfileField,
} from "@/lib/profile/rejected-fields";
import { toProfileSex } from "@/lib/profile/sex";

/**
 * Reading the answer to the onboarding baseline step's profile write.
 *
 * `PUT /api/auth/profile` is field-independent: it writes everything
 * that validated and reports the rest back rather than throwing the
 * whole submission away. Until now this step ignored that report, so a
 * height the server declined disappeared between the input and the next
 * screen with nothing said, and the person walked away believing it was
 * stored.
 *
 * The settings account form answers the same question the same way
 * (see `handleSaveProfile` in `src/components/settings/account-section`):
 * name the field in the person's own words, put the reason in that
 * field's own slot, keep validator prose off the screen, and only claim
 * a clean save when there is one. The two screens share the
 * field-naming helper and the sentences, so the same rejection reads
 * the same wherever it happens; only the labels differ, because each
 * screen calls the fields what its own inputs call them.
 *
 * A refused field also stops the wizard. Walking on would stamp
 * `onboardingCompletedAt` over a step the person has not finished, and
 * the only screen that could have shown them the refused value is the
 * one they just left.
 */

/** The parts of the profile response this step reads. */
export interface BaselineProfileResponse {
  ok: boolean;
  /** Parsed envelope, or `null` when the body was absent or unreadable. */
  body: {
    data?: { rejectedFields?: RejectedProfileField[] } | null;
    meta?: { errorCode?: string } | null;
    details?: { issues?: RejectedProfileField[] } | null;
  } | null;
}

export interface BaselineSaveOutcome {
  /** Whether the wizard may move on to the next step. */
  advance: boolean;
  /** A ready-to-show sentence, already localized. Null on a clean save. */
  notice: { tone: "warning" | "error"; message: string } | null;
  /**
   * One localized reason per refused field, keyed by the schema field
   * name so the step can drop each into the slot under its own input.
   * Empty on a clean save and on a failure that named no field.
   */
  fieldErrors: Record<string, string>;
}

/**
 * Collect the fields the person actually filled in. An untouched field
 * is left out entirely rather than sent as an empty value, so skipping
 * the step never clears something already stored. Height arrives
 * already converted to canonical centimetres — the wire stays cm
 * whatever unit the control was showing.
 */
export function buildBaselineProfileBody(
  form: { displayName: string; dateOfBirth: string; gender: string },
  heightCm: number | null,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (form.displayName.trim()) body.displayName = form.displayName.trim();
  if (heightCm !== null) body.heightCm = heightCm;
  if (form.dateOfBirth) body.dateOfBirth = form.dateOfBirth;
  // Every value the profile stores travels; the guard drops only the
  // "prefer not to say" placeholder. It used to list two of the three
  // by hand, so a third-value answer vanished on submit without a word.
  const gender = toProfileSex(form.gender);
  if (gender) body.gender = gender;
  return body;
}

/**
 * Write the collected fields and hand back what the server said.
 *
 * A raw fetch rather than `apiPut`, because the answer this step needs
 * lives in the body on both sides of the `ok` line: `rejectedFields` on
 * a partial success, `details.issues` when nothing landed. The throwing
 * wrapper would collapse both into one opaque failure.
 */
export async function putBaselineProfile(
  body: Record<string, unknown>,
): Promise<BaselineProfileResponse> {
  const res = await apiFetchRaw("/api/auth/profile", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const parsed = (await res.json().catch(() => null)) as
    BaselineProfileResponse["body"] | null;
  return { ok: res.ok, body: parsed };
}

/**
 * The labels the baseline step puts next to its own inputs, keyed by the
 * schema field the server rejects. Height carries two labels because the
 * control follows the unit preference, so the caller passes the one the
 * person actually read.
 */
export function baselineFieldLabelKeys(usesFeetInches: boolean) {
  return {
    displayName: "onboarding.baseline.displayNameLabel",
    heightCm: usesFeetInches
      ? "onboarding.baseline.heightLabelFtIn"
      : "onboarding.baseline.heightLabel",
    dateOfBirth: "onboarding.baseline.dateOfBirthLabel",
    gender: "onboarding.baseline.genderLabel",
  };
}

/**
 * Decide what the person is told and whether the wizard continues.
 *
 * - Some fields declined, the rest written: say which one did not make
 *   it and carry on. The accepted values are already stored; stopping
 *   here would only make the person re-enter what already saved.
 * - Nothing written: name the field that blocked it and stay put, so
 *   there is something specific to fix instead of a shrug.
 * - Any other failure: fall back to the step's own generic sentence.
 *   The server's `error` string is never shown — the stable
 *   `meta.errorCode` is resolved through the locale catalog instead, so
 *   no validator wording can reach the screen.
 */
export function describeBaselineSaveOutcome(
  res: BaselineProfileResponse,
  t: (key: string, params?: Record<string, string | number>) => string,
  labelKeys: Record<string, string>,
): BaselineSaveOutcome {
  if (res.ok) {
    const rejected = res.body?.data?.rejectedFields;
    const field = describeRejectedProfileField(rejected, t, labelKeys);
    if (!field) return { advance: true, notice: null, fieldErrors: {} };
    // Some fields landed, at least one did not. The wizard stops here:
    // the accepted values are stored and stay in the inputs, the
    // refused ones say why under their own control, and the person can
    // correct and press the same button again. Moving on would mark
    // the account set up over a value nobody ever saw refused.
    return {
      advance: false,
      notice: {
        tone: "warning",
        message: t("settings.profilePartiallySaved", { field }),
      },
      fieldErrors: describeRejectedProfileFields(rejected, t),
    };
  }

  const errorCode = res.body?.meta?.errorCode;
  const issues = res.body?.details?.issues;
  const blockingField = describeRejectedProfileField(issues, t, labelKeys);

  if (errorCode === "profile.update.nothingSaved" && blockingField) {
    return {
      advance: false,
      notice: {
        tone: "error",
        message: t("settings.profileNothingSaved", { field: blockingField }),
      },
      fieldErrors: describeRejectedProfileFields(issues, t),
    };
  }

  return {
    advance: false,
    notice: { tone: "error", message: localizedCode(errorCode, t) },
    fieldErrors: {},
  };
}

/** Resolve a stable error code through the catalog, or fall back to the
 * step's own sentence when the code is absent or has no entry. */
function localizedCode(
  errorCode: string | undefined,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  if (errorCode) {
    const key = `apiErrors.${errorCode}`;
    const translated = t(key);
    if (translated !== key) return translated;
  }
  return t("onboarding.errorGeneric");
}
