"use client";

import { useState, type FormEvent } from "react";
import { Loader2 } from "lucide-react";

import {
  FieldGuidance,
  MANAGED_PROFILE_GENDER_OPTIONS,
  displayNameIssue,
  genderFromSelect,
} from "@/components/settings/access/managed-profile-create-form";
import { stepUpErrorKey } from "@/components/settings/access/grant-action-error";
import { SettingsCardActions } from "@/components/settings/_card-actions";
import { TimezonePicker } from "@/components/settings/timezone-picker";
import { Button } from "@/components/ui/button";
import { DateField } from "@/components/ui/date-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { QueryErrorCard } from "@/components/ui/query-error-card";
import { ApiError } from "@/lib/api/api-fetch";
import { locales, localeLabels, type Locale } from "@/lib/i18n/config";
import { useTranslations } from "@/lib/i18n/context";
import {
  useManagedProfile,
  useUpdateManagedProfile,
  type ManagedProfileGender,
  type ManagedProfileView,
  type UpdateManagedProfileInput,
} from "@/lib/queries/use-managed-profiles";
import { isValidTimezone } from "@/lib/tz/format";

/**
 * v1.38.14 (#939) — changing a record after it exists.
 *
 * ## Why the form loads before it renders
 *
 * The account payload names a managed record and nothing else, so this form
 * cannot be filled from what the card already holds. It reads
 * `GET /api/managed-profiles/{id}` first and paints nothing editable until
 * that answers. The alternative — open the fields blank and send whatever is
 * in them — is how a record loses its timezone to an edit of its name, and it
 * would be invisible: the write would succeed.
 *
 * The read is `enabled` only while the form is open, so a Guardian who looks
 * after four records does not fetch four identities to paint a list that shows
 * none of them.
 *
 * ## Why it sends only what moved
 *
 * `PATCH` reads an absent key as "leave it" and an explicit null on the two
 * nullable fields as "clear it". The diff below is what keeps those two
 * different: a form that always sent five fields would overwrite a timezone
 * somebody changed in the record's own settings while this form sat open, with
 * the value it read minutes earlier. It also makes the audit row honest —
 * `changed` is derived from the body, so "the guardian renamed the record" is
 * what the record's trail says when that is what happened.
 *
 * ## The step-up is the expected first answer
 *
 * Same family, same gate as creating and deleting: `requireFreshMfa`, so the
 * first save in a session is a 401 carrying `auth.stepup.required`. It gets
 * its own sentence naming the next step rather than the generic failure, which
 * would send somebody looking for a problem with what they typed.
 */
export function ManagedProfileEditForm({
  profileId,
  onDone,
}: {
  profileId: string;
  /** Called after a save lands, so the row can close the form. */
  onDone: () => void;
}) {
  const { t } = useTranslations();
  const profile = useManagedProfile(profileId);

  if (profile.isError) {
    return (
      <QueryErrorCard
        title={t("recordSharing.managed.editLoadError")}
        onRetry={() => void profile.refetch()}
      />
    );
  }

  if (!profile.data) {
    return (
      <p
        role="status"
        data-slot="managed-profile-edit-loading"
        className="text-muted-foreground flex items-center gap-2 text-sm"
      >
        <Loader2
          className="h-4 w-4 animate-spin motion-reduce:animate-none"
          aria-hidden="true"
        />
        {t("nav.loadingScreen")}
      </p>
    );
  }

  // Keyed on WHICH record is open, so the field state below is seeded once per
  // record rather than through an effect that re-seeds on every refetch. The
  // key was the query's `dataUpdatedAt`, which did the opposite of what it
  // claimed: any invalidation of the `managed-profiles` prefix — removing a
  // guardian from another row, say — refetches this read, moves the timestamp
  // and remounts the fields, so a half-typed name disappears while somebody is
  // looking at it. The id is stable for as long as the form is about the same
  // record, which is exactly as long as the seeding should hold.
  return (
    <ManagedProfileEditFields
      key={profile.data.id}
      profile={profile.data}
      onDone={onDone}
    />
  );
}

function ManagedProfileEditFields({
  profile,
  onDone,
}: {
  profile: ManagedProfileView;
  onDone: () => void;
}) {
  const { t, locale: actorLocale } = useTranslations();
  const update = useUpdateManagedProfile();

  const [displayName, setDisplayName] = useState(profile.displayName ?? "");
  const [dateOfBirth, setDateOfBirth] = useState(profile.dateOfBirth ?? "");
  // A record with no recorded language opens on the actor's, which is the same
  // default the creation form uses. It is a starting point for a control the
  // person is looking at, not an inference written behind their back — nothing
  // is sent unless they move it, which is why the seed is frozen at mount and
  // handed to the patch builder as what "moved" is measured against.
  const [seededLocale] = useState<Locale>(() =>
    isLocale(profile.locale) ? profile.locale : actorLocale,
  );
  const [locale, setLocale] = useState<Locale>(seededLocale);
  const [gender, setGender] = useState<ManagedProfileGender>(profile.gender);
  const [timezone, setTimezone] = useState(profile.timezone);
  const [error, setError] = useState<string | null>(null);

  const nameIssue = displayNameIssue(displayName);
  const timezoneIssue = isValidTimezone(timezone)
    ? null
    : "recordSharing.managed.timezoneInvalid";
  const patch = managedProfileEditPatch(
    profile,
    {
      displayName,
      dateOfBirth,
      locale,
      gender,
      timezone,
    },
    seededLocale,
  );
  const blocked =
    nameIssue !== null || timezoneIssue !== null || patch === null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    // `blocked` already covers it; narrowed again so the spread below is typed
    // rather than asserted.
    if (blocked || patch === null || update.isPending) return;
    setError(null);
    update.mutate(
      { profileId: profile.id, ...patch },
      {
        onSuccess: onDone,
        // Nothing is reset: a refused save is one somebody is being asked to
        // retry, and a form that restored the server's values would throw the
        // edit away to explain that it did not land.
        onError: (err) => setError(t(editManagedProfileErrorKey(err))),
      },
    );
  };

  return (
    <form
      onSubmit={submit}
      data-slot="managed-profile-edit-form"
      className="space-y-3"
    >
      <div className="space-y-1.5">
        <Label htmlFor={`managed-profile-edit-name-${profile.id}`}>
          {t("recordSharing.managed.nameLabel")}
        </Label>
        <Input
          id={`managed-profile-edit-name-${profile.id}`}
          data-slot="managed-profile-edit-name"
          value={displayName}
          onChange={(e) => {
            setDisplayName(e.target.value);
            setError(null);
          }}
          autoComplete="off"
          maxLength={80}
          aria-invalid={nameIssue !== null ? "true" : undefined}
        />
        <FieldGuidance
          slot="managed-profile-edit-name"
          error={nameIssue === null ? null : t(nameIssue)}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={`managed-profile-edit-dob-${profile.id}`}>
          {t("recordSharing.managed.dobLabel")}
        </Label>
        <DateField
          id={`managed-profile-edit-dob-${profile.id}`}
          data-slot="managed-profile-edit-dob"
          value={dateOfBirth}
          onChange={setDateOfBirth}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={`managed-profile-edit-locale-${profile.id}`}>
          {t("recordSharing.managed.localeLabel")}
        </Label>
        <NativeSelect
          id={`managed-profile-edit-locale-${profile.id}`}
          data-slot="managed-profile-edit-locale"
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
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={`managed-profile-edit-gender-${profile.id}`}>
          {t("recordSharing.managed.genderLabel")}
        </Label>
        <NativeSelect
          id={`managed-profile-edit-gender-${profile.id}`}
          data-slot="managed-profile-edit-gender"
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
          id={`managed-profile-edit-timezone-${profile.id}`}
          value={timezone}
          onChange={(next) => {
            setTimezone(next);
            setError(null);
          }}
          hint={t("recordSharing.managed.timezoneHint")}
        />
        <FieldGuidance
          slot="managed-profile-edit-timezone"
          error={timezoneIssue === null ? null : t(timezoneIssue)}
        />
      </div>

      {/* Above the action row, per UI-STANDARDS §12: nothing follows it. */}
      {error && (
        <p
          role="alert"
          data-slot="managed-profile-edit-error"
          className="text-destructive text-sm"
        >
          {error}
        </p>
      )}

      <SettingsCardActions>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="min-h-11 sm:min-h-9"
          data-slot="managed-profile-edit-cancel"
          onClick={onDone}
        >
          {t("common.cancel")}
        </Button>
        <Button
          type="submit"
          size="sm"
          className="min-h-11 sm:min-h-9"
          data-slot="managed-profile-edit-submit"
          disabled={blocked || update.isPending}
        >
          {update.isPending
            ? t("recordSharing.managed.editSaving")
            : t("recordSharing.managed.editSave")}
        </Button>
      </SettingsCardActions>
    </form>
  );
}

/** Is this the record's language, as the app knows languages. */
function isLocale(value: string | null): value is Locale {
  return value !== null && (locales as readonly string[]).includes(value);
}

/** The form's five controls, as strings, before they become a patch. */
interface ManagedProfileEditDraft {
  displayName: string;
  dateOfBirth: string;
  locale: Locale;
  gender: ManagedProfileGender;
  timezone: string;
}

/**
 * What actually changed, or `null` when nothing did.
 *
 * Exported and pure because it is the decision this form makes: the route
 * refuses an empty body, so "nothing changed" has to be answered here rather
 * than discovered as a 422, and a field the person did not touch must not ride
 * along and overwrite a concurrent edit made in the record's own settings.
 * The empty date field is `null` — "clear it" — and not the empty string,
 * which the route's date format would refuse.
 */
export function managedProfileEditPatch(
  profile: ManagedProfileView,
  draft: ManagedProfileEditDraft,
  /**
   * The language the control opened on, which is the record's own or — for a
   * record that has none — the actor's. Compared against instead of
   * `profile.locale` because those two differ exactly when the record has no
   * language: comparing against the column made every save of a record like
   * that carry `locale`, so moving only the timezone wrote the actor's
   * language into somebody else's record.
   */
  seededLocale: Locale,
): Omit<UpdateManagedProfileInput, "profileId"> | null {
  const displayName = draft.displayName.trim();
  const dateOfBirth = draft.dateOfBirth.length > 0 ? draft.dateOfBirth : null;
  const patch: Omit<UpdateManagedProfileInput, "profileId"> = {
    ...(displayName !== (profile.displayName ?? "") ? { displayName } : {}),
    ...(dateOfBirth !== profile.dateOfBirth ? { dateOfBirth } : {}),
    ...(draft.locale !== seededLocale ? { locale: draft.locale } : {}),
    ...(draft.gender !== profile.gender ? { gender: draft.gender } : {}),
    ...(draft.timezone !== profile.timezone
      ? { timezone: draft.timezone }
      : {}),
  };
  return Object.keys(patch).length > 0 ? patch : null;
}

/**
 * The message for a refused edit.
 *
 * The same four arms creation carries, minus the rate limit it does not have,
 * and with the same reasoning: the step-up arm is a gate rather than a failure
 * and must not read as one, and a 422 is a disagreement between this form's
 * bounds and the route's rather than something the person typed — the
 * multi-issue envelope's `details.issues` never reach the browser.
 */
export function editManagedProfileErrorKey(err: unknown): string {
  if (!(err instanceof ApiError)) return "recordSharing.managed.errorOffline";
  if (err.status === 401) return stepUpErrorKey(err);
  if (err.status === 422) return "recordSharing.managed.errorInvalid";
  if (err.status === 404) return "recordSharing.managed.editErrorGone";
  return "recordSharing.managed.editErrorFailed";
}
