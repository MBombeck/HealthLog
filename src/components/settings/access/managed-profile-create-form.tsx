"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { DateField } from "@/components/ui/date-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { TimezonePicker } from "@/components/settings/timezone-picker";
import { stepUpErrorKey } from "@/components/settings/access/grant-action-error";
import { ApiError } from "@/lib/api/api-fetch";
import { locales, localeLabels, type Locale } from "@/lib/i18n/config";
import { useTranslations } from "@/lib/i18n/context";
import {
  useCreateManagedProfile,
  type ManagedProfileGender,
  type ManagedProfileView,
} from "@/lib/queries/use-managed-profiles";
import {
  DEFAULT_TIMEZONE,
  detectBrowserTimezone,
  isValidTimezone,
} from "@/lib/tz/format";

/**
 * v1.37.0 — creating a record that has no login of its own.
 *
 * ## Why the form is exactly five fields
 *
 * `POST /api/managed-profiles` parses with a `.strict()` schema. A strict
 * schema refuses an extra key outright, so a form that helpfully posted an
 * empty `heightCm` is refused with a validation error about a field the person
 * never filled in. The five fields below are the schema, and the submit
 * handler names them one by one rather than spreading the form state, so a
 * sixth control cannot reach the wire by accident.
 *
 * The fifth is `gender`, and it arrived late for a stated reason (#939). It
 * was left out of v1.37.0 on the argument that a record's identity should ask
 * for as little as possible — and the consequence was that every managed
 * record started with `gender` NULL, which is what the cycle module derives
 * its default from. A guardian creating a record for a child could neither
 * record the answer nor turn the module off from here. Asking once, optionally,
 * is less intrusive than the module surface that had to exist to undo it.
 *
 * ## The date of birth is genuinely optional
 *
 * Not "optional but we will guess". A managed profile is frequently a child,
 * and a child's age changes what the product says about a reading — so the
 * temptation to synthesise a date from a birth year, or from an age, is real
 * and is refused here as it is in the route. An absent date of birth stays
 * absent, and everything downstream reads it as absent rather than as
 * "1 January of some year".
 *
 * ## Whose locale, and whose timezone
 *
 * The profile's locale is a property OF THE RECORD: it decides the language of
 * content generated for it. The chrome around this form stays in the actor's
 * language, which is a decision made elsewhere and is not re-litigated in the
 * copy here. The default is the actor's own language, because a record created
 * by a German speaker for a person in their household is overwhelmingly likely
 * to want German, and the control is right there for the case where it is not.
 *
 * The timezone defaults to the browser's, for the same reason and with less
 * ambiguity: the profile lives where the person creating it lives, until told
 * otherwise.
 *
 * ## The step-up is the expected first answer
 *
 * Every route in this family resolves `requireFreshMfa`. For anybody with a
 * second factor who has not proved it in the last few minutes, the FIRST
 * response to this form is a 401 carrying `auth.stepup.required` — not an
 * error, a gate. It gets its own sentence naming the next step, exactly as the
 * invitation form does, rather than the generic "could not be created", which
 * would send somebody looking for a problem with what they typed.
 */
export function ManagedProfileCreateForm({
  submitLabel,
  onCreated,
}: {
  /** The button's label when the form sits somewhere other than the panel. */
  submitLabel?: string;
  /**
   * v1.39 (C2) — fired after a successful creation, with the record. The
   * setup flow's confirm screen mounts this form and continues from here;
   * the sharing panel leaves it unset and shows the confirmation line.
   */
  onCreated?: (profile: ManagedProfileView) => void;
} = {}) {
  const { t, locale: actorLocale } = useTranslations();
  const create = useCreateManagedProfile();

  const [displayName, setDisplayName] = useState("");
  const [dateOfBirth, setDateOfBirth] = useState("");
  const [locale, setLocale] = useState<Locale>(actorLocale);
  const [gender, setGender] = useState<ManagedProfileGender>(null);
  const [timezone, setTimezone] = useState(() => browserTimezone());
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);

  const trimmedName = displayName.trim();
  const nameIssue = displayNameIssue(displayName);
  const timezoneIssue = isValidTimezone(timezone)
    ? null
    : "recordSharing.managed.timezoneInvalid";
  const blocked = nameIssue !== null || timezoneIssue !== null;

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (blocked || create.isPending) return;
    setError(null);
    setCreated(null);
    create.mutate(
      {
        displayName: trimmedName,
        // Empty means absent. `null` is sent rather than the key being
        // omitted, so "this record has no date of birth" is something the
        // client says out loud.
        dateOfBirth: dateOfBirth.length > 0 ? dateOfBirth : null,
        locale,
        timezone,
        gender,
      },
      {
        onSuccess: (profile) => {
          setDisplayName("");
          setDateOfBirth("");
          setLocale(actorLocale);
          setGender(null);
          setTimezone(browserTimezone());
          setCreated(profile.displayName ?? trimmedName);
          onCreated?.(profile);
        },
        // Nothing is cleared here, on purpose: a refused creation is one the
        // person is being asked to retry, and a form that emptied itself
        // would make them type it all again to find out whether the second
        // attempt fails the same way.
        onError: (err) => setError(t(createManagedProfileErrorKey(err))),
      },
    );
  };

  return (
    <form
      onSubmit={submit}
      data-slot="managed-profile-create-form"
      className="space-y-3"
    >
      <div className="space-y-1.5">
        <Label htmlFor="managed-profile-name">
          {t("recordSharing.managed.nameLabel")}
        </Label>
        <Input
          id="managed-profile-name"
          data-slot="managed-profile-name"
          value={displayName}
          onChange={(e) => {
            setDisplayName(e.target.value);
            setError(null);
          }}
          placeholder={t("recordSharing.managed.namePlaceholder")}
          autoComplete="off"
          maxLength={80}
          aria-invalid={
            displayName.length > 0 && nameIssue !== null ? "true" : undefined
          }
          aria-describedby="managed-profile-name-hint"
        />
        <FieldGuidance
          slot="managed-profile-name"
          hintId="managed-profile-name-hint"
          hint={t("recordSharing.managed.nameHint")}
          // Only once somebody has typed. "Give the record a name" on an empty
          // field they have not reached yet is a telling-off, not guidance.
          error={
            displayName.length > 0 && nameIssue !== null ? t(nameIssue) : null
          }
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="managed-profile-dob">
          {t("recordSharing.managed.dobLabel")}
        </Label>
        <DateField
          id="managed-profile-dob"
          data-slot="managed-profile-dob"
          data-testid="managed-profile-dob-input"
          value={dateOfBirth}
          onChange={setDateOfBirth}
          aria-describedby="managed-profile-dob-hint"
        />
        <p
          id="managed-profile-dob-hint"
          className="text-muted-foreground text-xs"
        >
          {t("recordSharing.managed.dobHint")}
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="managed-profile-locale">
          {t("recordSharing.managed.localeLabel")}
        </Label>
        <NativeSelect
          id="managed-profile-locale"
          data-slot="managed-profile-locale"
          className="w-full"
          value={locale}
          onChange={(e) => setLocale(e.target.value as Locale)}
        >
          {locales.map((option) => (
            <option key={option} value={option}>
              {localeLabels[option]}
            </option>
          ))}
        </NativeSelect>
        <p className="text-muted-foreground text-xs">
          {t("recordSharing.managed.localeHint")}
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="managed-profile-gender">
          {t("recordSharing.managed.genderLabel")}
        </Label>
        <NativeSelect
          id="managed-profile-gender"
          data-slot="managed-profile-gender"
          className="w-full"
          value={gender ?? ""}
          onChange={(e) => setGender(genderFromSelect(e.target.value))}
        >
          {MANAGED_PROFILE_GENDER_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {t(option.labelKey)}
            </option>
          ))}
        </NativeSelect>
        <p className="text-muted-foreground text-xs">
          {t("recordSharing.managed.genderHint")}
        </p>
      </div>

      <div className="space-y-1.5">
        <TimezonePicker
          id="managed-profile-timezone"
          value={timezone}
          onChange={(next) => {
            setTimezone(next);
            setError(null);
          }}
          hint={t("recordSharing.managed.timezoneHint")}
        />
        {/* The picker's own list comes from the engine, so the select branch
            cannot produce an unknown zone. Its free-text fallback (older
            engines without `Intl.supportedValuesOf`) can, and this sentence is
            then the ONLY explanation for a submit button that will not press.
            It rides beside the picker rather than through its `hint` prop,
            because that prop renders muted meta and a refusal rendered as meta
            is a refusal nobody reads. */}
        <FieldGuidance
          slot="managed-profile-timezone"
          error={timezoneIssue === null ? null : t(timezoneIssue)}
        />
      </div>

      <Button
        type="submit"
        data-slot="managed-profile-create-submit"
        disabled={create.isPending || blocked}
      >
        {create.isPending
          ? t("recordSharing.managed.creating")
          : (submitLabel ?? t("recordSharing.managed.create"))}
      </Button>

      {error && (
        <p
          role="alert"
          data-slot="managed-profile-create-error"
          className="text-destructive text-sm"
        >
          {error}
        </p>
      )}
      {created && (
        <p
          role="status"
          data-slot="managed-profile-created"
          className="text-sm"
        >
          {t("recordSharing.managed.created", { name: created })}
        </p>
      )}
    </form>
  );
}

/**
 * A field's standing hint, and its refusal when there is one.
 *
 * Two nodes, never one that swaps. The form used to render a single muted
 * `<p>` whose TEXT changed from hint to error, which is wrong twice over:
 *
 *   * a refusal is content somebody has to act on, and UI-STANDARDS §3
 *     reserves `text-muted-foreground` for meta. The same reasoning is written
 *     out at `grant-action-error.tsx` — a refusal rendered as meta is a
 *     refusal nobody reads;
 *   * a node whose text changes in place is not announced. `role="alert"` is
 *     reliable when the node MOUNTS, which is why the panel's own alert is a
 *     separate element rather than a class on an existing one. Somebody who
 *     cannot see the screen pressed a button and got nothing, again.
 *
 * The hint stays where it was, muted, and keeps the id `aria-describedby`
 * points at. `hint` is optional for the one caller whose control renders its
 * own (the timezone picker), which needs only the error half.
 *
 * Exported and pure because the form's error states are not reachable from a
 * static render — there is no click, so no field is ever invalid — and a
 * rendering nobody can test is a rendering that drifts back to muted.
 */
export function FieldGuidance({
  slot,
  hintId,
  hint,
  error,
}: {
  /** `data-slot` stem: `<slot>-hint` and `<slot>-error`. */
  slot: string;
  hintId?: string;
  hint?: string;
  error: string | null;
}) {
  return (
    <>
      {hint !== undefined && (
        <p
          id={hintId}
          data-slot={`${slot}-hint`}
          className="text-muted-foreground text-xs"
        >
          {hint}
        </p>
      )}
      {error !== null && (
        <p
          data-slot={`${slot}-error`}
          role="alert"
          className="text-destructive text-sm"
        >
          {error}
        </p>
      )}
    </>
  );
}

/**
 * The sex control's options, in the order the record's own settings offer them.
 *
 * Shared with the edit form rather than written twice: the empty value is the
 * NULL the column really stores, and a second copy of this list is how one
 * surface ends up offering four options and the other three.
 */
export const MANAGED_PROFILE_GENDER_OPTIONS: ReadonlyArray<{
  value: string;
  labelKey: string;
}> = [
  { value: "", labelKey: "recordSharing.managed.genderNone" },
  { value: "MALE", labelKey: "recordSharing.managed.genderMale" },
  { value: "FEMALE", labelKey: "recordSharing.managed.genderFemale" },
  { value: "OTHER", labelKey: "recordSharing.managed.genderOther" },
];

/**
 * The select's string, as the route's enum.
 *
 * Exported and pure because the empty option is the one that matters: it means
 * NULL — "not recorded" — and a form that sent `""` would be refused by the
 * enum for a choice the person deliberately made.
 */
export function genderFromSelect(value: string): ManagedProfileGender {
  return value === "MALE" || value === "FEMALE" || value === "OTHER"
    ? value
    : null;
}

/** The browser's zone, or the app default when the engine will not say. */
function browserTimezone(): string {
  const detected = detectBrowserTimezone();
  return isValidTimezone(detected) ? detected : DEFAULT_TIMEZONE;
}

/**
 * The route's own bound on the display name, checked before sending.
 *
 * Exported and pure so the bound can be pinned without a click. The route
 * trims and then requires 1..80, so the client trims first too: a name of
 * three spaces is empty to the server and must read as empty here, rather
 * than as a valid entry that comes back refused.
 */
export function displayNameIssue(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "recordSharing.managed.nameRequired";
  if (trimmed.length > 80) return "recordSharing.managed.nameTooLong";
  return null;
}

/**
 * The message for a refused creation.
 *
 * Four arms and each names a different next step. The step-up arm is the one
 * that matters: it is not a failure, it is the gate every route in this family
 * carries, and it is the answer most people will get the first time they use
 * this form in a session.
 *
 * A 422 gets its own sentence rather than the field-level list the server
 * actually sends. The multi-issue envelope rides `details.issues`, and the
 * client's fetch wrapper keeps only `meta` — so the issues do not reach the
 * browser at all. The form validates the same bounds the route does before it
 * sends anything, which makes a 422 a disagreement between the two rather than
 * something the person typed; saying so is more honest than inventing a
 * field-level message the server did not send. Recorded as a finding in
 * `02-13.1-CONTRACT-FINDINGS.md`.
 */
export function createManagedProfileErrorKey(err: unknown): string {
  if (!(err instanceof ApiError)) return "recordSharing.managed.errorOffline";
  // The step-up gate. `requireFreshMfa` throws `StepUpRequiredError`, which is
  // a 401 carrying a stable code, and the request was authenticated enough to
  // reach it — so this is never a lapsed session.
  if (err.status === 401) return stepUpErrorKey(err);
  if (err.status === 422) return "recordSharing.managed.errorInvalid";
  // Ten an hour, the same ceiling the guardian invitation carries. Waiting is
  // the whole recovery, so it must not read as a failure — and it carries no
  // `errorCode`, like every other rate-limit refusal in this family.
  if (err.status === 429) return "recordSharing.managed.errorRateLimit";
  return "recordSharing.managed.errorFailed";
}
