"use client";

/**
 * The medication's "Leaflet" section on the overview tab (#1430, step 1).
 *
 *  - "Find leaflet" opens the official registry search of the person's
 *    chosen country in a new tab, with the name (and strength where the
 *    registry takes it) filled in. The link comes ready-built on the detail
 *    read (`leafletSearch`); a detail seeded from the list read, which does
 *    not carry it, builds the same link with the same pure function from the
 *    account's `medicineRegistry`. Nothing is fetched by the server or here.
 *  - "Official leaflet" is the link the person saved: openable, editable and
 *    removable. It renders only as an external link, never embedded.
 *  - Under both, the plain reminder that the leaflet comes from the national
 *    registry and must match the medication's name, strength and form.
 */
import { useState } from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";

import { MedicationDetailSection } from "@/components/medications/medication-detail-section";
import { MedicineRegistrySelect } from "@/components/settings/medicine-registry-card";
import { toastWrittenOutcome } from "@/components/outcome/outcome-toast";
import { Button } from "@/components/ui/button";
import { InlineAction } from "@/components/ui/inline-action";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/hooks/use-auth";
import { useRecordCapabilities } from "@/hooks/use-record-capabilities";
import { apiPut } from "@/lib/api/api-fetch";
import { showErrorToast } from "@/lib/errors/error-toast";
import { useTranslations } from "@/lib/i18n/context";
import {
  buildLeafletSearch,
  type LeafletSearch,
} from "@/lib/medications/leaflet-registries";
import {
  LEAFLET_URL_MAX_CHARS,
  isAcceptableLeafletUrl,
} from "@/lib/medications/leaflet-url";
import { invalidateMedicationReads } from "@/lib/query-keys";

export interface LeafletSectionMedication {
  id: string;
  name: string;
  dose: string;
  /** #1430 — the saved leaflet link; null = none. */
  leafletUrl?: string | null;
  /** #1430 — the registry search, as the detail read built it. */
  leafletSearch?: LeafletSearch | null;
}

/** The host of a saved link, for its label; the link itself when unparsable. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function MedicationLeafletSection({
  medication,
}: {
  medication: LeafletSectionMedication;
}) {
  const { t } = useTranslations();
  const { user, isAuthenticated } = useAuth();
  const { canManageDomain, inSharedRecord } = useRecordCapabilities();
  const canEdit = canManageDomain("medications");
  const search =
    medication.leafletSearch !== undefined
      ? medication.leafletSearch
      : buildLeafletSearch(user?.medicineRegistry, medication);
  const saved = medication.leafletUrl ?? null;

  return (
    <MedicationDetailSection
      titleId="medication-uebersicht-leaflet-heading"
      title={t("medications.leaflet.title")}
      dataSlot="medication-leaflet"
    >
      <div className="space-y-4">
        {saved && (
          <div
            className="flex items-start justify-between gap-3"
            data-slot="medication-leaflet-saved"
          >
            <div className="min-w-0 flex-1 space-y-0.5">
              <p className="text-sm font-medium">
                {t("medications.leaflet.saved")}
              </p>
              <p className="text-muted-foreground truncate text-xs">
                {hostOf(saved)}
              </p>
            </div>
            <Button variant="outline" size="sm" className="min-h-11" asChild>
              <a
                href={saved}
                target="_blank"
                rel="noopener noreferrer"
                data-slot="medication-leaflet-saved-link"
              >
                <ExternalLink aria-hidden="true" />
                {t("medications.leaflet.open")}
                <span className="sr-only">
                  {t("medications.leaflet.newTab")}
                </span>
              </a>
            </Button>
          </div>
        )}

        {search ? (
          <FindLeaflet
            search={search}
            name={medication.name}
            inSharedRecord={inSharedRecord}
          />
        ) : (
          <div className="space-y-2" data-slot="medication-leaflet-no-registry">
            <p className="text-sm">{t("medications.leaflet.noRegistry")}</p>
            {/* The registry is the person's own setting: chosen right here,
                and the search appears in place once it is saved. Inside
                somebody else's record it stays theirs to choose. */}
            {inSharedRecord ? null : (
              <MedicineRegistrySelect
                isAuthenticated={isAuthenticated}
                id={`medication-leaflet-registry-${medication.id}`}
                labelKey="medications.leaflet.chooseRegistry"
              />
            )}
          </div>
        )}

        <p className="text-sm" data-slot="medication-leaflet-disclaimer">
          {t("medications.leaflet.disclaimer")}
        </p>

        {canEdit && (
          <SavedLeafletEditor medicationId={medication.id} saved={saved} />
        )}
      </div>
    </MedicationDetailSection>
  );
}

function FindLeaflet({
  search,
  name,
  inSharedRecord,
}: {
  search: LeafletSearch;
  name: string;
  inSharedRecord: boolean;
}) {
  const { t } = useTranslations();
  return (
    <div className="space-y-2" data-slot="medication-leaflet-find">
      <Button size="sm" className="min-h-11" asChild>
        <a
          href={search.url}
          target="_blank"
          rel="noopener noreferrer"
          data-slot="medication-leaflet-find-link"
          data-registry={search.registry}
          data-prefill={search.prefill}
        >
          <ExternalLink aria-hidden="true" />
          {t("medications.leaflet.find")}
          <span className="sr-only">{t("medications.leaflet.newTab")}</span>
        </a>
      </Button>
      {search.prefill === "none" ? (
        <p className="text-sm" data-slot="medication-leaflet-search-hint">
          {t("medications.leaflet.searchThere", {
            name,
            authority: search.authority,
          })}
        </p>
      ) : (
        <p className="text-muted-foreground text-xs">
          {t("medications.leaflet.opensIn", { authority: search.authority })}
        </p>
      )}
      {/* The registry is the person's own setting, chosen under Settings >
          Modules > Medications, which a switched session does not open. */}
      {!inSharedRecord && (
        <InlineAction tone="muted" asChild>
          <Link href="/settings/modules/medications#medicine-registry">
            {t("medications.leaflet.changeRegistry")}
          </Link>
        </InlineAction>
      )}
    </div>
  );
}

function SavedLeafletEditor({
  medicationId,
  saved,
}: {
  medicationId: string;
  saved: string | null;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(saved ?? "");
  const [busy, setBusy] = useState(false);
  const trimmed = value.trim();
  const invalid = trimmed !== "" && !isAcceptableLeafletUrl(trimmed);

  async function save(next: string | null) {
    if (busy) return;
    setBusy(true);
    try {
      await apiPut(`/api/medications/${encodeURIComponent(medicationId)}`, {
        leafletUrl: next,
      });
      await invalidateMedicationReads(queryClient);
      toastWrittenOutcome(
        "success",
        next
          ? t("medications.leaflet.savedToast")
          : t("medications.leaflet.removedToast"),
      );
      setEditing(false);
    } catch (failure) {
      showErrorToast(t("medications.leaflet.saveError"), { cause: failure });
    } finally {
      setBusy(false);
    }
  }

  if (!editing) {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <InlineAction
          tone="muted"
          onClick={() => {
            setValue(saved ?? "");
            setEditing(true);
          }}
          data-slot="medication-leaflet-edit"
        >
          {saved ? t("medications.leaflet.edit") : t("medications.leaflet.add")}
        </InlineAction>
        {saved && (
          <InlineAction
            tone="muted"
            disabled={busy}
            onClick={() => void save(null)}
            data-slot="medication-leaflet-remove"
          >
            {t("medications.leaflet.remove")}
          </InlineAction>
        )}
      </div>
    );
  }

  return (
    <form
      className="space-y-2"
      data-slot="medication-leaflet-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!invalid) void save(trimmed === "" ? null : trimmed);
      }}
    >
      <Label htmlFor="medication-leaflet-url" className="text-sm font-medium">
        {t("medications.leaflet.urlLabel")}
      </Label>
      <Input
        id="medication-leaflet-url"
        type="url"
        inputMode="url"
        autoComplete="off"
        spellCheck={false}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="https://"
        maxLength={LEAFLET_URL_MAX_CHARS}
        aria-invalid={invalid || undefined}
        aria-describedby="medication-leaflet-url-helper"
        data-slot="medication-leaflet-url-input"
      />
      <p
        id="medication-leaflet-url-helper"
        role={invalid ? "alert" : undefined}
        className={
          invalid ? "text-destructive text-xs" : "text-muted-foreground text-xs"
        }
      >
        {invalid
          ? t("medications.leaflet.urlInvalid")
          : t("medications.leaflet.urlHelper")}
      </p>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="min-h-11"
          onClick={() => setEditing(false)}
          disabled={busy}
        >
          {t("common.cancel")}
        </Button>
        <Button
          type="submit"
          size="sm"
          className="min-h-11"
          disabled={busy || invalid}
          data-slot="medication-leaflet-save"
        >
          {t("common.save")}
        </Button>
      </div>
    </form>
  );
}
