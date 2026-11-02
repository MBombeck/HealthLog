"use client";

/**
 * v1.43 — merge markers that are one analyte written two ways.
 *
 * Three steps in one sheet: pick the markers, pick the one that stays, read
 * the preview, then confirm. The preview is the server's own dry run
 * (`POST /api/biomarkers/{id}/merge` with `dryRun: true`): how many readings
 * move, which are converted into the kept marker's unit, which names become
 * its aliases, and any marker whose unit cannot be converted, which blocks the
 * merge. A merge cannot be undone, and the sheet says so before the button.
 * Nothing is computed here; every number is the server's.
 */
import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { showErrorToast } from "@/lib/errors/error-toast";
import { Loader2 } from "lucide-react";

import { toastWrittenOutcome } from "@/components/outcome/outcome-toast";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { TagChip } from "@/components/ui/tag-chip";
import { apiPost } from "@/lib/api/api-fetch";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";

import type { BiomarkerDto, BiomarkerMergeResultDto } from "./types";
import { labUnitLabel } from "@/lib/labs/dimensionless";

/** The most sources one merge takes, matching the server. */
const MAX_SOURCES = 10;

export function BiomarkerMergeSheet({
  open,
  onOpenChange,
  markers,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  markers: readonly BiomarkerDto[];
}) {
  const { t, tCount } = useTranslations();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<string[]>([]);
  const [targetId, setTargetId] = useState<string | null>(null);
  const [preview, setPreview] = useState<BiomarkerMergeResultDto | null>(null);

  const target = targetId && selected.includes(targetId) ? targetId : null;
  const keepId = target ?? selected[0] ?? null;
  const sourceIds = useMemo(
    () => selected.filter((id) => id !== keepId),
    [selected, keepId],
  );
  const byId = useMemo(() => new Map(markers.map((m) => [m.id, m])), [markers]);

  const reset = () => {
    setSelected([]);
    setTargetId(null);
    setPreview(null);
  };

  const run = useMutation({
    mutationFn: (dryRun: boolean) =>
      apiPost<BiomarkerMergeResultDto>(`/api/biomarkers/${keepId}/merge`, {
        sourceIds,
        dryRun,
      }),
    onSuccess: (result) => {
      if (result.dryRun) {
        setPreview(result);
        return;
      }
      toastWrittenOutcome(
        "success",
        tCount("labs.merge.doneToast", result.movedReadings, {
          name: result.target.name,
        }),
      );
      queryClient.invalidateQueries({ queryKey: queryKeys.biomarkers() });
      queryClient.invalidateQueries({ queryKey: queryKeys.labResults() });
      reset();
      onOpenChange(false);
    },
    onError: (err) => showErrorToast(t("labs.merge.error"), { cause: err }),
  });

  const toggle = (id: string, checked: boolean) => {
    setPreview(null);
    setSelected((prev) =>
      checked
        ? prev.length > MAX_SOURCES
          ? prev
          : [...prev, id]
        : prev.filter((x) => x !== id),
    );
  };

  const refused = preview?.sources.filter((s) => s.conversion === "refused");
  const canPreview = keepId !== null && sourceIds.length > 0;

  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
      title={t("labs.merge.title")}
      description={t("labs.merge.description")}
      footer={
        <div className="flex w-full flex-wrap justify-end gap-2">
          {preview ? (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="min-h-11 sm:min-h-9"
                onClick={() => setPreview(null)}
                disabled={run.isPending}
              >
                {t("labs.merge.back")}
              </Button>
              <Button
                type="button"
                size="sm"
                className="min-h-11 sm:min-h-9"
                data-slot="biomarker-merge-confirm"
                onClick={() => run.mutate(false)}
                disabled={run.isPending || (refused?.length ?? 0) > 0}
              >
                {run.isPending ? (
                  <Loader2
                    className="size-4 animate-spin motion-reduce:animate-none"
                    aria-hidden
                  />
                ) : null}
                {t("labs.merge.confirm")}
              </Button>
            </>
          ) : (
            <Button
              type="button"
              size="sm"
              className="min-h-11 sm:min-h-9"
              data-slot="biomarker-merge-preview"
              onClick={() => run.mutate(true)}
              disabled={!canPreview || run.isPending}
            >
              {run.isPending ? (
                <Loader2
                  className="size-4 animate-spin motion-reduce:animate-none"
                  aria-hidden
                />
              ) : null}
              {t("labs.merge.showPreview")}
            </Button>
          )}
        </div>
      }
    >
      {preview ? (
        <div className="space-y-4" data-slot="biomarker-merge-preview-body">
          <p className="text-sm">
            {tCount("labs.merge.previewSummary", preview.movedReadings, {
              name: preview.target.name,
              unit: labUnitLabel(preview.target.unit, t),
            })}
          </p>
          <ul className="space-y-2">
            {preview.sources.map((source) => (
              <li
                key={source.id}
                className="border-border space-y-0.5 rounded-lg border p-3"
              >
                <p className="text-sm font-medium break-words">
                  {source.name}{" "}
                  <span className="text-muted-foreground text-xs font-normal">
                    {labUnitLabel(source.unit, t)}
                  </span>
                </p>
                <p
                  className={
                    source.conversion === "refused"
                      ? "text-destructive text-xs"
                      : "text-muted-foreground text-xs"
                  }
                >
                  {source.conversion === "refused"
                    ? t("labs.merge.refused", {
                        unit: labUnitLabel(source.unit, t),
                        targetUnit: labUnitLabel(preview.target.unit, t),
                      })
                    : source.conversion === "converted"
                      ? tCount("labs.merge.converted", source.readingCount, {
                          unit: source.unit,
                          targetUnit: preview.target.unit,
                        })
                      : tCount("labs.merge.moves", source.readingCount)}
                </p>
              </li>
            ))}
          </ul>
          {preview.aliasesAdded.length > 0 ? (
            <div className="space-y-1.5">
              <p className="text-muted-foreground text-xs">
                {t("labs.merge.aliasesAdded")}
              </p>
              <div className="flex flex-wrap gap-1.5">
                {preview.aliasesAdded.map((alias) => (
                  <TagChip key={alias}>{alias}</TagChip>
                ))}
              </div>
            </div>
          ) : null}
          {(refused?.length ?? 0) > 0 ? (
            <p role="alert" className="text-destructive text-sm">
              {t("labs.merge.blocked")}
            </p>
          ) : (
            <p className="text-sm font-medium">{t("labs.merge.noUndo")}</p>
          )}
        </div>
      ) : (
        <div className="space-y-4" data-slot="biomarker-merge-select">
          <ul className="space-y-1">
            {markers.map((marker) => {
              const id = `merge-pick-${marker.id}`;
              const checked = selected.includes(marker.id);
              return (
                <li key={marker.id}>
                  <label
                    htmlFor={id}
                    className="hover:bg-muted/50 flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-2 py-1.5"
                  >
                    <Checkbox
                      id={id}
                      checked={checked}
                      onCheckedChange={(state) =>
                        toggle(marker.id, state === true)
                      }
                      disabled={!checked && selected.length > MAX_SOURCES}
                    />
                    <span className="min-w-0 flex-1 truncate text-sm">
                      {marker.name}
                    </span>
                    <span className="text-muted-foreground shrink-0 text-xs">
                      {labUnitLabel(marker.unit, t)}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
          {selected.length >= 2 ? (
            <div className="space-y-1.5">
              <Label htmlFor="merge-keep">{t("labs.merge.keepLabel")}</Label>
              <NativeSelect
                id="merge-keep"
                value={keepId ?? ""}
                onChange={(event) => setTargetId(event.target.value)}
              >
                {selected.map((id) => (
                  <option key={id} value={id}>
                    {byId.get(id)?.name ?? id}
                  </option>
                ))}
              </NativeSelect>
              <p className="text-muted-foreground text-xs">
                {t("labs.merge.keepHint")}
              </p>
            </div>
          ) : (
            <p className="text-muted-foreground text-xs">
              {t("labs.merge.pickHint")}
            </p>
          )}
        </div>
      )}
    </ResponsiveSheet>
  );
}
