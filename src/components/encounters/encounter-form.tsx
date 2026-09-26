"use client";

/**
 * The visit form.
 *
 * **A visit saves with a date and nothing else.** No required practitioner, no
 * required kind, no required link, and no Save button disabled until something
 * is picked. That is the whole product constraint this feature exists to hold:
 * a required field on a form somebody fills after a doctor's appointment is the
 * bureaucracy it was built to avoid. The only thing that can block Save is a
 * missing or unparseable date, because a visit with no instant is not a record
 * of anything.
 *
 * Status is DERIVED from the date on a new visit, never asked: a future instant
 * means PLANNED and a past one means DONE. A person booking an appointment
 * should not have to also tell the app that it is in the future. On an existing
 * visit the status becomes editable, because moving a planned visit to done,
 * cancelled or a no-show is the transition that closes a checkup.
 *
 * The three link pickers are gated by the modules that own what they point at,
 * and the gate BLANKS the block rather than post-filtering it — an empty
 * picker for a module the account turned off advertises a feature that is not
 * there.
 */
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { DateTimeField } from "@/components/ui/date-time-field";
import { FieldGroup } from "@/components/ui/field-group";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/hooks/use-auth";
import { useTranslations } from "@/lib/i18n/context";
import type { Encounter, EncounterWriteBody } from "@/hooks/use-encounters";
import type { Practitioner } from "@/hooks/use-practitioners";
import {
  ENCOUNTER_KINDS,
  ENCOUNTER_STATUSES,
  encounterKindText,
  encounterStatusText,
} from "./encounter-labels";
import { BodySiteFields } from "@/components/body-sites/body-site-fields";
import { PractitionerCombobox } from "./practitioner-combobox";
import { EncounterLinkPickers } from "./encounter-link-pickers";

export interface EncounterDraft {
  /** Local `yyyy-MM-ddTHH:mm`, the `DateTimeField` contract. */
  occurredAt: string;
  status: "PLANNED" | "DONE" | "CANCELLED" | "NO_SHOW";
  kind: string;
  practitioner: Practitioner | null;
  reason: string;
  outcome: string;
  /** Where on the body; free text, empty when not stated. */
  bodySite: string;
  laterality: "LEFT" | "RIGHT" | "BOTH" | null;
  documentIds: string[];
  labResultIds: string[];
  episodeIds: string[];
}

function localValue(instant: Date): string {
  const offset = instant.getTimezoneOffset();
  return new Date(instant.getTime() - offset * 60_000)
    .toISOString()
    .slice(0, 16);
}

export function nowLocalValue(): string {
  return localValue(new Date());
}

/** A local `yyyy-MM-ddTHH:mm` back to the wire's ISO-8601 instant, or null. */
export function draftInstant(value: string): string | null {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function emptyDraft(
  overrides?: Partial<EncounterDraft>,
): EncounterDraft {
  return {
    occurredAt: nowLocalValue(),
    status: "DONE",
    kind: "OTHER",
    practitioner: null,
    reason: "",
    outcome: "",
    bodySite: "",
    laterality: null,
    documentIds: [],
    labResultIds: [],
    episodeIds: [],
    ...overrides,
  };
}

export function draftFromEncounter(row: Encounter): EncounterDraft {
  return {
    occurredAt: localValue(new Date(row.occurredAt)),
    status: row.status,
    kind: row.kind,
    practitioner: row.practitioner,
    reason: row.reason ?? "",
    outcome: row.outcome ?? "",
    bodySite: row.bodySite ?? "",
    laterality: row.laterality,
    documentIds: row.links?.documents.map((link) => link.id) ?? [],
    labResultIds: row.links?.labResults.map((link) => link.id) ?? [],
    episodeIds: row.links?.conditions.map((link) => link.id) ?? [],
  };
}

/**
 * The status a NEW visit carries, read off its own date.
 *
 * Exported so the sheet and its tests agree on the derivation rather than each
 * spelling out the comparison.
 */
export function derivedStatus(
  occurredAt: string,
  now = Date.now(),
): "PLANNED" | "DONE" {
  const parsed = new Date(occurredAt).getTime();
  return Number.isFinite(parsed) && parsed > now ? "PLANNED" : "DONE";
}

/** The body a draft becomes, with the empty strings turned into absences. */
export function draftToBody(
  draft: EncounterDraft,
  options: { isEdit: boolean; reminderId?: string | null },
): EncounterWriteBody | null {
  const occurredAt = draftInstant(draft.occurredAt);
  if (!occurredAt) return null;
  return {
    occurredAt,
    status: options.isEdit ? draft.status : derivedStatus(draft.occurredAt),
    kind: draft.kind,
    practitionerId: draft.practitioner?.id ?? null,
    reason: draft.reason.trim() || null,
    outcome: draft.outcome.trim() || null,
    bodySite: draft.bodySite.trim() || null,
    laterality: draft.laterality,
    ...(options.reminderId ? { reminderId: options.reminderId } : {}),
    documentIds: draft.documentIds,
    labResultIds: draft.labResultIds,
    episodeIds: draft.episodeIds,
  };
}

export function EncounterForm({
  draft,
  onChange,
  isEdit,
}: {
  draft: EncounterDraft;
  onChange: (next: EncounterDraft) => void;
  isEdit: boolean;
}) {
  const { t } = useTranslations();
  const { user } = useAuth();
  const patch = (part: Partial<EncounterDraft>) =>
    onChange({ ...draft, ...part });

  const planned = useMemo(
    () =>
      isEdit
        ? draft.status === "PLANNED"
        : derivedStatus(draft.occurredAt) === "PLANNED",
    [isEdit, draft.status, draft.occurredAt],
  );

  // The outcome field starts collapsed on a planned visit: there is nothing to
  // write about a thing that has not happened. Derived rather than
  // synchronised — a visit that already carries an outcome is never collapsed
  // over it, and expressing that as an effect would be a second source of
  // truth for something the draft already knows.
  const [revealed, setRevealed] = useState(false);
  const outcomeOpen = revealed || !planned || draft.outcome.length > 0;

  // The body site belongs to a procedure, so that is where it is offered. A
  // visit that already carries one keeps the fields in view whatever its kind:
  // switching the kind away must not hide text the person typed, and the
  // server keeps it either way.
  const showBodySite =
    draft.kind === "PROCEDURE" ||
    draft.bodySite.trim().length > 0 ||
    draft.laterality !== null;

  return (
    <div className="space-y-4" data-slot="encounter-form">
      <FieldGroup
        htmlFor="encounter-occurred-at"
        label={t("encounters.form.date")}
        hint={isEdit ? undefined : t("encounters.form.dateDerivesStatusHint")}
      >
        <DateTimeField
          id="encounter-occurred-at"
          value={draft.occurredAt}
          onChange={(value) => patch({ occurredAt: value })}
          required
          aria-required="true"
          data-testid="encounter-occurred-at"
        />
      </FieldGroup>

      {isEdit ? (
        <FieldGroup
          htmlFor="encounter-status"
          label={t("encounters.form.status")}
        >
          <NativeSelect
            id="encounter-status"
            value={draft.status}
            onChange={(event) =>
              patch({
                status: event.target.value as EncounterDraft["status"],
              })
            }
          >
            {ENCOUNTER_STATUSES.map((status) => (
              <option key={status} value={status}>
                {encounterStatusText(t, status)}
              </option>
            ))}
          </NativeSelect>
        </FieldGroup>
      ) : null}

      <FieldGroup
        htmlFor="encounter-practitioner"
        label={t("encounters.form.practitioner")}
        hint={t("encounters.form.practitionerHint")}
      >
        <PractitionerCombobox
          value={draft.practitioner?.id ?? null}
          selected={draft.practitioner}
          onChange={(next) => patch({ practitioner: next })}
        />
      </FieldGroup>

      <FieldGroup htmlFor="encounter-kind" label={t("encounters.form.kind")}>
        <NativeSelect
          id="encounter-kind"
          value={draft.kind}
          onChange={(event) => patch({ kind: event.target.value })}
        >
          {ENCOUNTER_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {encounterKindText(t, kind)}
            </option>
          ))}
        </NativeSelect>
      </FieldGroup>

      {showBodySite ? (
        <BodySiteFields
          idPrefix="encounter"
          bodySite={draft.bodySite}
          laterality={draft.laterality}
          onBodySiteChange={(bodySite) => patch({ bodySite })}
          onLateralityChange={(laterality) => patch({ laterality })}
        />
      ) : null}

      <FieldGroup
        htmlFor="encounter-reason"
        label={t("encounters.form.reason")}
      >
        <Textarea
          id="encounter-reason"
          rows={2}
          value={draft.reason}
          onChange={(event) => patch({ reason: event.target.value })}
        />
      </FieldGroup>

      {outcomeOpen ? (
        <FieldGroup
          htmlFor="encounter-outcome"
          label={t("encounters.form.outcome")}
        >
          <Textarea
            id="encounter-outcome"
            rows={3}
            value={draft.outcome}
            onChange={(event) => patch({ outcome: event.target.value })}
          />
        </FieldGroup>
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="min-h-11"
          data-slot="encounter-outcome-reveal"
          onClick={() => setRevealed(true)}
        >
          {t("encounters.form.outcomeReveal")}
        </Button>
      )}

      <EncounterLinkPickers
        modules={user?.modules}
        anchor={draft.occurredAt || null}
        documentIds={draft.documentIds}
        labResultIds={draft.labResultIds}
        episodeIds={draft.episodeIds}
        onChange={patch}
      />
    </div>
  );
}
