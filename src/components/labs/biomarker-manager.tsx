"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, EyeOff, FlaskConical, Pencil, Plus } from "lucide-react";
import { toast } from "sonner";

import { DeleteButton } from "@/components/data-list";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { QueryErrorCard } from "@/components/ui/query-error-card";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { apiDelete, apiGet, apiPut } from "@/lib/api/api-fetch";
import { formatReferenceRange } from "@/lib/labs/reference-range";
import { formatLabValue } from "@/lib/labs/format-value";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";

import { BiomarkerForm } from "./biomarker-form";
import type { BiomarkerDto, BiomarkerListResponse } from "./types";

/**
 * v1.18.1 — the Biomarker catalog manager. v1.22 — compact editable rows.
 *
 * Lives on the Labs page (not Settings) because the catalog IS the Labs
 * feature's primary object. Each marker renders as a single compact row
 * (name + unit inline, reference range / panel on a muted sub-line) with a
 * hide toggle, an edit button (reusing the define/edit sheet), and a delete.
 *
 * Delete removes the marker AND every reading under it, in one transaction —
 * this line used to claim the `onDelete: SetNull` FK left the readings behind
 * as unlinked rows, which stopped being true when delete became a "drop this
 * and its history" action and the confirmation copy was rewritten in all six
 * locales to say so. Hide is the reversible path and is one row above it, so
 * the destructive one is deliberately the destructive one.
 *
 * "Hide" is a soft remove: a marker the user no longer needs leaves the
 * active list and the lab-entry pickers but keeps its readings + canonical
 * unit/range. Hidden markers collect in a separate section where they can be
 * restored or deleted outright.
 */
export function BiomarkerManager() {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<BiomarkerDto | null>(null);
  const [formFooterEl, setFormFooterEl] = useState<HTMLDivElement | null>(null);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: queryKeys.biomarkers(),
    queryFn: () => apiGet<BiomarkerListResponse>("/api/biomarkers"),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiDelete(`/api/biomarkers/${id}`),
    onSuccess: () => {
      toast.success(t("labs.biomarker.deletedToast"));
      queryClient.invalidateQueries({ queryKey: queryKeys.biomarkers() });
      queryClient.invalidateQueries({ queryKey: queryKeys.labResults() });
    },
    onError: () => toast.error(t("labs.biomarker.deleteError")),
  });

  const hiddenMutation = useMutation({
    mutationFn: ({ id, hidden }: { id: string; hidden: boolean }) =>
      apiPut(`/api/biomarkers/${id}`, { hidden }),
    onSuccess: (_data, { hidden }) => {
      toast.success(
        hidden
          ? t("labs.biomarker.hiddenToast")
          : t("labs.biomarker.unhiddenToast"),
      );
      queryClient.invalidateQueries({ queryKey: queryKeys.biomarkers() });
    },
    onError: () => toast.error(t("labs.biomarker.hideError")),
  });

  function openNew() {
    setEditing(null);
    setFormOpen(true);
  }

  function openEdit(marker: BiomarkerDto) {
    setEditing(marker);
    setFormOpen(true);
  }

  function afterSave() {
    setFormOpen(false);
    setEditing(null);
    queryClient.invalidateQueries({ queryKey: queryKeys.biomarkers() });
    queryClient.invalidateQueries({ queryKey: queryKeys.labResults() });
  }

  const markers = data?.biomarkers ?? [];
  const visible = markers.filter((m) => !m.hidden);
  const hidden = markers.filter((m) => m.hidden);

  function renderRow(marker: BiomarkerDto) {
    const range = formatReferenceRange(
      marker.lowerBound,
      marker.upperBound,
      formatLabValue,
    );
    return (
      <li
        key={marker.id}
        data-hidden={marker.hidden ? "true" : undefined}
        className="border-border bg-background/30 flex min-h-12 items-center gap-2 rounded-md border px-3 py-2 data-[hidden=true]:opacity-70"
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="truncate text-sm font-medium">{marker.name}</span>
            <span className="text-muted-foreground text-xs">{marker.unit}</span>
          </div>
          <p className="text-muted-foreground text-xs">
            {range
              ? `${t("labs.referenceLabel")} ${range} ${marker.unit}`
              : t("labs.biomarker.noRange")}
            {marker.panel ? ` · ${marker.panel}` : ""}
          </p>
        </div>
        <Button
          size="icon"
          variant="ghost"
          className="size-11 sm:size-9"
          onClick={() =>
            hiddenMutation.mutate({ id: marker.id, hidden: !marker.hidden })
          }
          disabled={hiddenMutation.isPending}
          aria-label={
            marker.hidden
              ? t("labs.biomarker.unhide")
              : t("labs.biomarker.hide")
          }
        >
          {marker.hidden ? (
            <Eye className="h-4 w-4" />
          ) : (
            <EyeOff className="h-4 w-4" />
          )}
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="size-11 sm:size-9"
          onClick={() => openEdit(marker)}
          aria-label={t("labs.biomarker.edit")}
        >
          <Pencil className="h-4 w-4" />
        </Button>
        <DeleteButton
          domain="labs"
          onConfirm={() => deleteMutation.mutate(marker.id)}
          title={t("labs.biomarker.deleteConfirmTitle")}
          description={t("labs.biomarker.deleteConfirmDescription")}
          confirmLabel={t("labs.biomarker.delete")}
          className="size-11 sm:size-9"
          iconClassName="h-4 w-4"
        />
      </li>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-muted-foreground text-sm">
          {t("labs.biomarker.managerDescription")}
        </p>
        <Button size="sm" onClick={openNew} className="shrink-0">
          <Plus className="h-4 w-4" />
          {t("labs.biomarker.define")}
        </Button>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : isError ? (
        <QueryErrorCard
          title={t("labs.biomarker.loadError")}
          onRetry={() => void refetch()}
        />
      ) : markers.length === 0 ? (
        <EmptyState
          icon={<FlaskConical className="size-6" />}
          title={t("labs.biomarker.emptyTitle")}
          description={t("labs.biomarker.emptyDescription")}
          action={
            <Button onClick={openNew}>{t("labs.biomarker.defineFirst")}</Button>
          }
        />
      ) : (
        <div className="space-y-4">
          {visible.length > 0 ? (
            <ul className="space-y-2">{visible.map(renderRow)}</ul>
          ) : (
            <p className="text-muted-foreground py-2 text-sm">
              {t("labs.biomarker.allHidden")}
            </p>
          )}

          {hidden.length > 0 ? (
            <div className="space-y-2">
              <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                {t("labs.biomarker.hiddenSection")}
              </p>
              <ul className="space-y-2">{hidden.map(renderRow)}</ul>
            </div>
          ) : null}
        </div>
      )}

      <ResponsiveSheet
        open={formOpen}
        onOpenChange={setFormOpen}
        title={
          editing
            ? t("labs.biomarker.editTitle")
            : t("labs.biomarker.defineTitle")
        }
        description={t("labs.biomarker.defineDescription")}
        footer={
          <div
            ref={setFormFooterEl}
            className="flex w-full justify-end gap-2"
          />
        }
      >
        <BiomarkerForm
          existing={editing ?? undefined}
          footerSlot={formFooterEl}
          onSuccess={afterSave}
          onCancel={() => setFormOpen(false)}
        />
      </ResponsiveSheet>
    </div>
  );
}
