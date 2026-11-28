"use client";

/**
 * The medication's leaflet, one line of the overview's plan (#1430).
 *
 *  - "Find leaflet" opens the official registry search of the person's
 *    chosen country in a new tab, with the name (and strength where the
 *    registry takes it) filled in. The link comes ready-built on the detail
 *    and the list read (`leafletSearch`); the server is its one builder.
 *    Nothing is fetched by the server or here.
 *  - "Official leaflet" is the link the person saved: openable, editable and
 *    removable. It renders only as an external link, never embedded.
 *  - Under both, the plain reminder that the leaflet comes from the national
 *    registry and must match the medication's name, strength and form.
 */
import { useState } from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";

import { MedicineRegistrySelect } from "@/components/settings/medicine-registry-card";
import { toastWrittenOutcome } from "@/components/outcome/outcome-toast";
import { Button } from "@/components/ui/button";
import { InlineAction } from "@/components/ui/inline-action";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useAuth } from "@/hooks/use-auth";
import { useRecordCapabilities } from "@/hooks/use-record-capabilities";
import { apiPut } from "@/lib/api/api-fetch";
import { showErrorToast } from "@/lib/errors/error-toast";
import { useTranslations } from "@/lib/i18n/context";
import type { LeafletSearch } from "@/lib/medications/leaflet-registries";
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

/**
 * The leaflet as one line of the plan: "Beipackzettel" on the left; on the
 * right the saved leaflet as a chip, or "Suchen" for the registry search,
 * and "Mehr" for the rest (where the search opens, the registry choice, the
 * registry reminder, saving a link). No filled button: the page's primary
 * actions are the overview cards' button pairs.
 *
 * Rendered as a `<div>` of a description list (`dt` + `dd`), so it sits in
 * the plan card's list like every other row.
 */
export function MedicationLeafletRow({
  medication,
  className,
}: {
  medication: LeafletSectionMedication;
  className?: string;
}) {
  const { t } = useTranslations();
  const { isAuthenticated } = useAuth();
  const { canManageDomain, inSharedRecord } = useRecordCapabilities();
  const canEdit = canManageDomain("medications");
  const search = medication.leafletSearch ?? null;
  const saved = medication.leafletUrl ?? null;

  return (
    <div className={className} data-slot="medication-leaflet">
      <dt className="text-muted-foreground shrink-0">
        {t("medications.leaflet.title")}
      </dt>
      <dd className="flex min-w-0 flex-wrap items-center justify-end gap-x-3 gap-y-1">
        {saved ? (
          <a
            href={saved}
            target="_blank"
            rel="noopener noreferrer"
            className="bg-muted text-foreground focus-visible:ring-ring/50 inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium outline-none focus-visible:ring-[3px]"
            data-slot="medication-leaflet-saved-link"
          >
            <ExternalLink aria-hidden="true" className="size-3.5 shrink-0" />
            <span className="truncate">{hostOf(saved)}</span>
            <span className="sr-only">
              {t("medications.leaflet.saved")},{" "}
              {t("medications.leaflet.newTab")}
            </span>
          </a>
        ) : search ? (
          <InlineAction asChild>
            <a
              href={search.url}
              target="_blank"
              rel="noopener noreferrer"
              data-slot="medication-leaflet-find-link"
              data-registry={search.registry}
              data-prefill={search.prefill}
            >
              {t("medications.leaflet.searchShort")}
              <ExternalLink aria-hidden="true" className="size-3.5" />
              <span className="sr-only">{t("medications.leaflet.newTab")}</span>
            </a>
          </InlineAction>
        ) : null}
        <Popover>
          <PopoverTrigger asChild>
            <InlineAction tone="muted" data-slot="medication-leaflet-more">
              {t("nav.more")}
            </InlineAction>
          </PopoverTrigger>
          <PopoverContent
            align="end"
            className="w-80 space-y-3 text-left"
            data-slot="medication-leaflet-more-content"
          >
            {saved && search && (
              <InlineAction asChild>
                <a
                  href={search.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  data-slot="medication-leaflet-find-link"
                  data-registry={search.registry}
                  data-prefill={search.prefill}
                >
                  {t("medications.leaflet.find")}
                  <ExternalLink aria-hidden="true" className="size-3.5" />
                  <span className="sr-only">
                    {t("medications.leaflet.newTab")}
                  </span>
                </a>
              </InlineAction>
            )}
            {search ? (
              <FindLeaflet
                search={search}
                name={medication.name}
                inSharedRecord={inSharedRecord}
              />
            ) : (
              <div
                className="space-y-2"
                data-slot="medication-leaflet-no-registry"
              >
                <p className="text-sm">{t("medications.leaflet.noRegistry")}</p>
                {/* The registry is the person's own setting: chosen right
                    here, and the search appears in place once it is saved.
                    Inside somebody else's record it stays theirs to choose. */}
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
          </PopoverContent>
        </Popover>
      </dd>
    </div>
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
