"use client";

/**
 * The symptom row of the entry form: the label, the chips that toggle a
 * symptom in or out, the add chip, the filter that shows up once the row is
 * long, the one muted hint under it, and the "pick one" error.
 *
 * The picked ids and the error live in the form, which needs them to save;
 * the filter text is the row's own, and the form remounts the row (a new
 * `key`) to clear it on a reset.
 */
import { useState } from "react";
import { Search } from "lucide-react";

import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { QueryErrorRow } from "@/components/ui/query-error-row";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";

import { AddSymptomChip } from "./add-symptom-chip";
import {
  filterSymptomChips,
  SYMPTOM_FILTER_THRESHOLD,
} from "./symptom-chip-filter";
import { SymptomIcon } from "./symptom-icons";
import type { useSymptomDefinitions } from "./use-symptoms";

type DefinitionsQuery = ReturnType<typeof useSymptomDefinitions>;

export function SymptomPicker({
  groupId,
  definitions,
  picked,
  onToggle,
  canDefine,
  atLimit,
  limit,
  error,
}: {
  /** Labels the chip group; `<groupId>-error` describes it on an error. */
  groupId: string;
  definitions: DefinitionsQuery;
  picked: string[];
  onToggle: (id: string) => void;
  canDefine: boolean;
  atLimit: boolean;
  limit: number;
  error: string | null;
}) {
  const { t } = useTranslations();
  const [chipFilter, setChipFilter] = useState("");

  const list = definitions.data?.definitions ?? [];
  const filterable = list.length > SYMPTOM_FILTER_THRESHOLD;
  const shown = filterable
    ? filterSymptomChips(list, chipFilter, picked)
    : list;

  return (
    <div className="space-y-2">
      <Label id={groupId}>{t("symptoms.entry.symptom")}</Label>
      {definitions.isError ? (
        // A failed read is not an empty list: the empty hint would invite
        // the person to define a symptom they may already have.
        <QueryErrorRow
          error={definitions.error}
          message={t("symptoms.section.loadError")}
          onRetry={() => void definitions.refetch()}
        />
      ) : (
        <>
          {filterable ? (
            <div className="relative">
              <Search
                className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
                aria-hidden
              />
              <Input
                type="search"
                value={chipFilter}
                onChange={(e) => setChipFilter(e.target.value)}
                placeholder={t("symptoms.entry.filterPlaceholder")}
                aria-label={t("symptoms.entry.filterPlaceholder")}
                data-testid="symptom-chip-filter"
                className="pl-9"
              />
            </div>
          ) : null}
          <div
            role="group"
            aria-labelledby={groupId}
            aria-describedby={error ? `${groupId}-error` : undefined}
            className="flex flex-wrap gap-2"
          >
            {shown.map((definition) => (
              <SymptomChip
                key={definition.id}
                icon={definition.icon}
                label={definition.label ?? t("symptoms.unreadableLabel")}
                selected={picked.includes(definition.id)}
                onToggle={() => onToggle(definition.id)}
              />
            ))}
            {canDefine && !atLimit ? (
              <AddSymptomChip
                onCreated={(id) => {
                  if (!picked.includes(id)) onToggle(id);
                }}
              />
            ) : null}
          </div>
          {shown.length === 0 && list.length > 0 ? (
            <EmptyState
              variant="plain"
              size="compact"
              title={t("symptoms.entry.filterEmpty")}
            />
          ) : null}
          <PickerHint
            count={list.length}
            loading={definitions.isLoading}
            canDefine={canDefine}
            atLimit={atLimit}
            limit={limit}
          />
        </>
      )}
      {error ? (
        <p
          id={`${groupId}-error`}
          role="alert"
          className="text-destructive text-sm"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** One symptom as a toggle chip; several may be picked at once. */
function SymptomChip({
  icon,
  label,
  selected,
  onToggle,
}: {
  icon: string | null;
  label: string;
  selected: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={selected}
      data-testid="symptom-chip"
      onClick={onToggle}
      className={cn(
        "focus-visible:ring-ring/50 inline-flex min-h-11 items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition-colors focus-visible:ring-2 focus-visible:outline-none sm:min-h-8",
        selected
          ? "border-primary bg-primary/10 text-foreground"
          : "border-border text-foreground hover:bg-accent",
      )}
    >
      <SymptomIcon name={icon} className="size-4" />
      {label}
    </button>
  );
}

/** The one muted line under the chips: how to pick, or why none can be added. */
function PickerHint({
  count,
  loading,
  canDefine,
  atLimit,
  limit,
}: {
  count: number;
  loading: boolean;
  canDefine: boolean;
  atLimit: boolean;
  limit: number;
}) {
  const { t } = useTranslations();
  let text: string | null = null;
  if (count === 0 && !loading) {
    text = canDefine
      ? t("symptoms.entry.emptyHint")
      : t("symptoms.entry.emptyHintNoManage");
  } else if (atLimit && canDefine) {
    text = t("symptoms.entry.limitHint", { limit });
  } else if (count > 1) {
    text = t("symptoms.entry.severalHint");
  }
  return text ? <p className="text-muted-foreground text-xs">{text}</p> : null;
}
