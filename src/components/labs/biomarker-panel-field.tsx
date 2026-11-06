"use client";

/**
 * The marker form's panel field: free text with suggestions. The catalog
 * panels come from the bundle in the page language; the person's own panels
 * come from `customPanels` on `GET /api/biomarkers`, the same read the
 * pickers around the form already hold. A catalog panel typed in any
 * language lands in the same category, so the suggestions only spare typing.
 */
import { useId } from "react";
import { useQuery } from "@tanstack/react-query";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiGet } from "@/lib/api/api-fetch";
import { useTranslations } from "@/lib/i18n/context";
import { BIOMARKER_PANELS } from "@/lib/labs/biomarker-catalog";
import { queryKeys } from "@/lib/query-keys";

import type { BiomarkerListResponse } from "./types";

export function BiomarkerPanelField({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslations();
  const listId = `${useId()}-panels`;
  const hintId = `${listId}-hint`;
  const { data } = useQuery({
    queryKey: queryKeys.biomarkers(),
    queryFn: () => apiGet<BiomarkerListResponse>("/api/biomarkers"),
  });
  const suggestions = [
    ...new Set([
      ...BIOMARKER_PANELS.map((key) => t(`labs.catalog.panel.${key}`)),
      ...(data?.customPanels ?? []),
    ]),
  ];
  return (
    <div className="space-y-1.5">
      <Label htmlFor="biomarker-panel">{t("labs.biomarker.form.panel")}</Label>
      <Input
        id="biomarker-panel"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={t("labs.biomarker.form.panelPlaceholder")}
        maxLength={120}
        list={listId}
        aria-describedby={hintId}
        autoComplete="off"
      />
      <datalist id={listId} data-slot="biomarker-panel-suggestions">
        {suggestions.map((panel) => (
          <option key={panel} value={panel} />
        ))}
      </datalist>
      <p id={hintId} className="text-muted-foreground text-xs">
        {t("labs.biomarker.form.panelHint")}
      </p>
    </div>
  );
}
