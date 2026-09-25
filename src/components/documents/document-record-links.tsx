"use client";

/**
 * "What is this page filed against?" — the document side of the visit and
 * vaccination links, on the vault's detail sheet.
 *
 * Both links already existed as tables, but only one end could write them:
 * a visit's form picked its documents, a dose's form picked its pages, and
 * the document itself could show its visits read-only and its doses not at
 * all. A childhood record covering a dozen doses had to be attached dose by
 * dose, from twelve forms. Here the page lists what it is filed against and,
 * for someone who may manage the vault, links and unlinks it in one place.
 * Both ends write the SAME table through the link service, so the dose's
 * form and this sheet cannot disagree about what is filed where.
 *
 * Every name and date comes from the server: the visit kind as its enum
 * constant for the reader's bundle, the dose as its catalogue slug or the
 * person's own wording. The pick lists come from the visit and vaccination
 * list routes, with the records dated near the document on top under the
 * same seven-day window the upload suggestion uses.
 *
 * A module that is off leaves no block behind, and a grant that does not
 * reach the doses (`vaccinationLinks: null`) shows no dose block rather than
 * an empty one that would claim the page records none.
 */
import { useState } from "react";
import Link from "next/link";
import { CalendarDays, Syringe } from "lucide-react";

import { EntityLinkPicker } from "@/components/links/entity-link-picker";
import type { EntityLinkOption } from "@/components/links/entity-link-picker";
import { isNearAnchor } from "@/components/links/vault-document-options";
import { encounterKindText } from "@/components/encounters/encounter-labels";
import { useVaccinations } from "@/components/vaccinations/use-vaccinations";
import { useEncounters } from "@/hooks/use-encounters";
import { useAuth } from "@/hooks/use-auth";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import type { EncounterKind } from "@/generated/prisma/client";
import type { InboundDocumentDetailDto } from "@/lib/validations/inbound-documents";

type Translate = ReturnType<typeof useTranslations>["t"];

/** Records near the document first, then the rest by year, newest first. */
export function recordOptions(
  records: ReadonlyArray<{
    id: string;
    label: string;
    meta?: string | null;
    occurredAt: string;
    href?: string | null;
  }>,
  anchor: string | null,
  labels: { suggested: string; date: (iso: string) => string },
): EntityLinkOption[] {
  const near: EntityLinkOption[] = [];
  const rest: EntityLinkOption[] = [];
  for (const record of records) {
    const option = {
      id: record.id,
      label: record.label,
      meta: record.meta ?? null,
      dateLabel: labels.date(record.occurredAt),
      href: record.href ?? null,
    };
    if (isNearAnchor(record.occurredAt, anchor)) {
      near.push({
        ...option,
        group: { key: "suggested", label: labels.suggested },
      });
    } else {
      const year = record.occurredAt.slice(0, 4);
      rest.push({ ...option, group: { key: year, label: year } });
    }
  }
  return [...near, ...rest];
}

/** Where a visit opens: its sheet on the checkups page. */
function visitHref(encounterId: string): string {
  return `/checkups?visit=${encodeURIComponent(encounterId)}`;
}

/** Where a dose opens: its sheet on the vaccinations page. */
function doseHref(vaccinationId: string): string {
  return `/vaccinations?dose=${encodeURIComponent(vaccinationId)}`;
}

/** A dose named the way the vaccination page names it. */
function doseName(
  t: Translate,
  catalogSlug: string | null,
  vaccineName: string | null,
): string {
  if (catalogSlug) return t(`vaccinations.catalog.${catalogSlug}`);
  return vaccineName ?? t("vaccinations.suggestion.unnamed");
}

/**
 * The caller mounts this keyed on the document and on its write-failure
 * count, so the local selection below starts over from the server's answer
 * whenever the sheet moves to another document or a write fails.
 */
export function DocumentRecordLinks({
  doc,
  canManage,
  seedFresh,
  seedError = false,
  onRetrySeed,
  onChange,
}: {
  doc: InboundDocumentDetailDto;
  canManage: boolean;
  /**
   * Whether `doc` was read from the server since the sheet opened. Every
   * change is a replace-set write seeded from `doc`'s links, so a seed from a
   * cached copy that predates a link made on the dose's or the visit's own
   * form would delete that link on the first tap. The pickers wait for a
   * fresh read instead.
   */
  seedFresh: boolean;
  /** That fresh read failed; the pickers show the retry row instead. */
  seedError?: boolean;
  onRetrySeed?: () => void;
  onChange: (part: {
    encounterIds?: string[];
    vaccinationIds?: string[];
  }) => void;
}) {
  const { t } = useTranslations();
  const format = useFormatters();
  const { user } = useAuth();
  const vaccinationsOn = user?.modules?.vaccinations !== false;
  const anchor = doc.documentDate ?? doc.reportDate;

  const encounters = useEncounters(canManage);
  const vaccinations = useVaccinations(
    null,
    canManage && vaccinationsOn && doc.vaccinationLinks !== null,
  );

  // The selection the person is editing, ahead of the server. Each change is
  // sent as the whole set (a replace-set PATCH), so a quick second tap never
  // computes from a list the first tap has not refreshed yet.
  const [visitIds, setVisitIds] = useState<string[] | null>(null);
  const [doseIds, setDoseIds] = useState<string[] | null>(null);

  const labels = {
    suggested: t("links.picker.suggested"),
    date: (iso: string) => format.date(iso),
  };

  const visitOptions = recordOptions(
    [
      ...(encounters.data?.upcoming ?? []),
      ...(encounters.data?.past ?? []),
    ].map((visit) => ({
      id: visit.id,
      label: encounterKindText(t, visit.kind as EncounterKind),
      meta: visit.practitioner?.name ?? null,
      occurredAt: visit.occurredAt,
      href: visitHref(visit.id),
    })),
    anchor,
    labels,
  );
  const doseOptions = recordOptions(
    (vaccinations.data?.vaccinations ?? []).map((dose) => ({
      id: dose.id,
      label: doseName(t, dose.catalogEntry?.slug ?? null, dose.vaccineName),
      occurredAt: dose.occurredAt,
      href: doseHref(dose.id),
    })),
    anchor,
    labels,
  );

  const showDoses = vaccinationsOn && doc.vaccinationLinks !== null;

  return (
    <>
      {canManage ? (
        <EntityLinkPicker
          icon={CalendarDays}
          title={t("documents.detail.visitsLabel")}
          slot="document-visit-links"
          pending={encounters.isPending || !seedFresh}
          error={encounters.isError || seedError}
          errorLabel={t("links.picker.loadError")}
          onRetry={() => {
            if (encounters.isError) void encounters.refetch();
            if (seedError) onRetrySeed?.();
          }}
          selected={visitIds ?? doc.encounterLinks.map((l) => l.encounterId)}
          onChange={(ids) => {
            setVisitIds(ids);
            onChange({ encounterIds: ids });
          }}
          options={visitOptions}
          searchPlaceholder={t("links.picker.searchPlaceholder")}
          emptyLabel={t("documents.detail.noVisitsToLink")}
        />
      ) : doc.encounterLinks.length > 0 ? (
        <div className="space-y-1.5" data-slot="document-visit-links">
          <p className="text-sm leading-none font-medium">
            {t("documents.detail.visitsLabel")}
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            {doc.encounterLinks.map((link) => (
              <Link
                key={link.encounterId}
                href={visitHref(link.encounterId)}
                className="bg-muted text-foreground hover:bg-muted/70 focus-visible:ring-ring/50 inline-flex max-w-64 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs focus-visible:ring-[3px] focus-visible:outline-none"
              >
                <span className="truncate">
                  {encounterKindText(t, link.kind as EncounterKind)}
                </span>
                {link.occurredAt ? (
                  <span className="text-muted-foreground shrink-0">
                    {format.date(link.occurredAt)}
                  </span>
                ) : null}
              </Link>
            ))}
          </div>
        </div>
      ) : null}

      {showDoses && canManage ? (
        <EntityLinkPicker
          icon={Syringe}
          title={t("documents.detail.vaccinationsLabel")}
          slot="document-vaccination-links"
          pending={vaccinations.isPending || !seedFresh}
          error={vaccinations.isError || seedError}
          errorLabel={t("links.picker.loadError")}
          onRetry={() => {
            if (vaccinations.isError) void vaccinations.refetch();
            if (seedError) onRetrySeed?.();
          }}
          selected={
            doseIds ??
            (doc.vaccinationLinks ?? []).map((link) => link.vaccinationId)
          }
          onChange={(ids) => {
            setDoseIds(ids);
            onChange({ vaccinationIds: ids });
          }}
          options={doseOptions}
          searchPlaceholder={t("links.picker.searchPlaceholder")}
          emptyLabel={t("documents.detail.noVaccinationsToLink")}
        />
      ) : showDoses && (doc.vaccinationLinks?.length ?? 0) > 0 ? (
        <div className="space-y-1.5" data-slot="document-vaccination-links">
          <p className="text-sm leading-none font-medium">
            {t("documents.detail.vaccinationsLabel")}
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            {(doc.vaccinationLinks ?? []).map((link) => (
              <Link
                key={link.vaccinationId}
                href={doseHref(link.vaccinationId)}
                data-slot="document-vaccination-link"
                className="bg-muted text-foreground hover:bg-muted/70 focus-visible:ring-ring/50 inline-flex max-w-64 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs focus-visible:ring-[3px] focus-visible:outline-none"
              >
                <span className="truncate">
                  {doseName(t, link.catalogSlug, link.vaccineName)}
                </span>
                {link.occurredAt ? (
                  <span className="text-muted-foreground shrink-0">
                    {format.date(link.occurredAt)}
                  </span>
                ) : null}
              </Link>
            ))}
          </div>
        </div>
      ) : null}
    </>
  );
}
