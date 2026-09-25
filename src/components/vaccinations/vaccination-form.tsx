"use client";

/**
 * The dose capture and edit form.
 *
 * **A dose saves with a date and ONE identity arm — a catalogue pick OR the
 * person's own wording — and nothing else.** No required dose number, no
 * required batch code, no required practice. A required catalogue pick would
 * make a 1987 Impfpass line unloggable, which is the whole population this
 * feature exists for. The only thing that can block Save is a missing date or
 * neither identity arm.
 *
 * The two identity arms are independent: picking a catalogue entry never
 * overwrites what the person typed, and typing never clears a pick. Either is
 * sufficient; both are allowed.
 *
 * Follows the encounter form's controlled-draft shape rather than a
 * react-hook-form instance — the sibling surface this plan cites as its
 * precedent uses a draft, and the server's Zod schema is the validation
 * authority either way. The client guard is for the two properties a person
 * feels immediately: a date is present, and the vaccine is named somehow.
 */
import { useState } from "react";

import { DateField } from "@/components/ui/date-field";
import { FieldGroup } from "@/components/ui/field-group";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { PractitionerCombobox } from "@/components/encounters/practitioner-combobox";
import { EncounterSuggestionField } from "@/components/encounters/encounter-suggestion-field";
import { useAuth } from "@/hooks/use-auth";
import { useTranslations } from "@/lib/i18n/context";
import type { Practitioner } from "@/hooks/use-practitioners";
import type { Vaccination, VaccinationWriteBody } from "./use-vaccinations";
import { CatalogPicker } from "./catalog-picker";
import { VaccinationDocumentPicker } from "./vaccination-document-picker";

/** The seven anatomical sites, mirroring the Prisma `VaccinationSite` enum. */
export const VACCINATION_SITES = [
  "LEFT_ARM",
  "RIGHT_ARM",
  "LEFT_THIGH",
  "RIGHT_THIGH",
  "ORAL",
  "NASAL",
  "OTHER",
] as const;

export interface VaccinationDraft {
  /** `YYYY-MM-DD`, the `DateField` contract. */
  occurredAt: string;
  antigenSlug: string | null;
  vaccineName: string;
  doseNumber: string;
  seriesDoses: string;
  lotNumber: string;
  site: string;
  practitioner: Practitioner | null;
  encounterId: string | null;
  note: string;
  /**
   * The documents the person has chosen, or `null` for "untouched: whatever
   * the dose is filed against now". A dose opened from the list arrives
   * without its links (only the detail read carries them), and an empty array
   * here is sent as "unlink everything" — which is how editing a lot number
   * used to strip every page filed against the dose.
   */
  documentIds: string[] | null;
}

/** Today as a local `YYYY-MM-DD`, the DateField default and max. */
export function todayLocal(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function emptyDraft(
  overrides?: Partial<VaccinationDraft>,
): VaccinationDraft {
  return {
    occurredAt: todayLocal(),
    antigenSlug: null,
    vaccineName: "",
    doseNumber: "",
    seriesDoses: "",
    lotNumber: "",
    site: "",
    practitioner: null,
    encounterId: null,
    note: "",
    documentIds: [],
    ...overrides,
  };
}

export function draftFromVaccination(row: Vaccination): VaccinationDraft {
  return {
    occurredAt: row.occurredAt.slice(0, 10),
    antigenSlug: row.antigenSlug,
    vaccineName: row.vaccineName ?? "",
    doseNumber: row.doseNumber?.toString() ?? "",
    seriesDoses: row.seriesDoses?.toString() ?? "",
    lotNumber: row.lotNumber ?? "",
    site: row.site ?? "",
    practitioner: row.practitioner,
    encounterId: row.encounter?.id ?? null,
    note: row.note ?? "",
    documentIds: row.documents ? row.documents.map((doc) => doc.id) : null,
  };
}

/** The day, at UTC midnight — an Impfpass carries dates, never times. */
export function draftInstant(day: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const parsed = new Date(`${day}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** Does the draft carry at least one identity arm? */
export function draftHasIdentity(draft: VaccinationDraft): boolean {
  return draft.antigenSlug !== null || draft.vaccineName.trim().length > 0;
}

function toInt(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const n = Number.parseInt(trimmed, 10);
  return Number.isNaN(n) ? null : n;
}

/** The body a draft becomes, empties turned into absences. Null when unsavable. */
export function draftToBody(
  draft: VaccinationDraft,
): VaccinationWriteBody | null {
  const occurredAt = draftInstant(draft.occurredAt);
  if (!occurredAt) return null;
  if (!draftHasIdentity(draft)) return null;
  return {
    occurredAt,
    antigenSlug: draft.antigenSlug,
    vaccineName: draft.vaccineName.trim() || null,
    doseNumber: toInt(draft.doseNumber),
    seriesDoses: toInt(draft.seriesDoses),
    lotNumber: draft.lotNumber.trim() || null,
    site: draft.site || null,
    practitionerId: draft.practitioner?.id ?? null,
    encounterId: draft.encounterId,
    note: draft.note.trim() || null,
    // Absent unless the person changed the links: the route reads a present
    // array as the whole new set.
    ...(draft.documentIds !== null ? { documentIds: draft.documentIds } : {}),
  };
}

export function VaccinationForm({
  draft,
  onChange,
  savedDocuments,
}: {
  draft: VaccinationDraft;
  onChange: (next: VaccinationDraft) => void;
  /**
   * What the dose is filed against on the server, for an edit: the ids, or
   * `pending` while the detail read runs, or `error` when it failed. A create
   * passes nothing and starts from an empty set.
   */
  savedDocuments?: {
    ids: string[] | null;
    pending: boolean;
    error: boolean;
    retry: () => void;
  };
}) {
  const { t } = useTranslations();
  const { user } = useAuth();
  const patch = (part: Partial<VaccinationDraft>) =>
    onChange({ ...draft, ...part });

  const [seriesOpen, setSeriesOpen] = useState(
    draft.doseNumber.length > 0 || draft.seriesDoses.length > 0,
  );

  const anchor = draftInstant(draft.occurredAt);

  return (
    <div className="space-y-4" data-slot="vaccination-form">
      <FieldGroup
        htmlFor="vaccination-occurred-at"
        label={t("vaccinations.form.date")}
      >
        <DateField
          id="vaccination-occurred-at"
          value={draft.occurredAt}
          onChange={(value) => patch({ occurredAt: value })}
          max={todayLocal()}
          required
          data-testid="vaccination-occurred-at"
        />
      </FieldGroup>

      <FieldGroup
        htmlFor="vaccination-catalog-trigger"
        label={t("vaccinations.form.catalogLabel")}
        hint={t("vaccinations.form.identityHint")}
      >
        <CatalogPicker
          value={draft.antigenSlug}
          onChange={(slug) => patch({ antigenSlug: slug })}
        />
      </FieldGroup>

      <FieldGroup
        htmlFor="vaccination-free-text"
        label={t("vaccinations.form.freeTextLabel")}
      >
        <Input
          id="vaccination-free-text"
          value={draft.vaccineName}
          onChange={(event) => patch({ vaccineName: event.target.value })}
          placeholder={t("vaccinations.form.freeTextPlaceholder")}
          data-slot="vaccination-free-text"
        />
      </FieldGroup>

      {seriesOpen ? (
        <div className="grid grid-cols-2 gap-3">
          <FieldGroup
            htmlFor="vaccination-dose-number"
            label={t("vaccinations.form.doseNumber")}
          >
            <Input
              id="vaccination-dose-number"
              type="number"
              inputMode="numeric"
              min={1}
              max={20}
              value={draft.doseNumber}
              onChange={(event) => patch({ doseNumber: event.target.value })}
            />
          </FieldGroup>
          <FieldGroup
            htmlFor="vaccination-series-doses"
            label={t("vaccinations.form.seriesDoses")}
          >
            <Input
              id="vaccination-series-doses"
              type="number"
              inputMode="numeric"
              min={1}
              max={10}
              value={draft.seriesDoses}
              onChange={(event) => patch({ seriesDoses: event.target.value })}
            />
          </FieldGroup>
        </div>
      ) : (
        <button
          type="button"
          data-slot="vaccination-series-reveal"
          className="text-muted-foreground hover:text-foreground text-sm underline-offset-2 hover:underline"
          onClick={() => setSeriesOpen(true)}
        >
          {t("vaccinations.form.seriesToggle")}
        </button>
      )}

      <FieldGroup htmlFor="vaccination-lot" label={t("vaccinations.form.lot")}>
        <Input
          id="vaccination-lot"
          value={draft.lotNumber}
          onChange={(event) => patch({ lotNumber: event.target.value })}
        />
      </FieldGroup>

      <FieldGroup
        htmlFor="vaccination-site"
        label={t("vaccinations.form.site")}
      >
        <NativeSelect
          id="vaccination-site"
          value={draft.site}
          onChange={(event) => patch({ site: event.target.value })}
        >
          <option value="">{t("vaccinations.form.siteNone")}</option>
          {VACCINATION_SITES.map((site) => (
            <option key={site} value={site}>
              {t(`vaccinations.site.${site}`)}
            </option>
          ))}
        </NativeSelect>
      </FieldGroup>

      <FieldGroup
        htmlFor="vaccination-practitioner"
        label={t("vaccinations.form.practitioner")}
      >
        <PractitionerCombobox
          value={draft.practitioner?.id ?? null}
          selected={draft.practitioner}
          onChange={(next) => patch({ practitioner: next })}
        />
      </FieldGroup>

      <EncounterSuggestionField
        anchor={anchor}
        value={draft.encounterId}
        onChange={(id) => patch({ encounterId: id })}
        slot="vaccination-encounter-suggestion"
      />

      <FieldGroup
        htmlFor="vaccination-note"
        label={t("vaccinations.form.note")}
      >
        <Textarea
          id="vaccination-note"
          rows={2}
          value={draft.note}
          onChange={(event) => patch({ note: event.target.value })}
        />
      </FieldGroup>

      <VaccinationDocumentPicker
        enabled={user?.modules?.inboundDocuments === true}
        anchor={anchor}
        documentIds={draft.documentIds ?? savedDocuments?.ids ?? []}
        seedPending={
          draft.documentIds === null && (savedDocuments?.pending ?? false)
        }
        seedError={
          draft.documentIds === null && (savedDocuments?.error ?? false)
        }
        onRetrySeed={savedDocuments?.retry}
        onChange={(documentIds) => patch({ documentIds })}
      />
    </div>
  );
}
