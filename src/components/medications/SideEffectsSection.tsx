"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import type {
  MedicationSideEffectCategory,
  MedicationSideEffectEntry,
} from "@/generated/prisma/client";
import {
  SIDE_EFFECT_CATEGORY_ORDER,
  SIDE_EFFECT_SEVERITY_LADDER,
  categoryForEntry,
  entriesByCategory,
  severityLikertLabel,
} from "@/lib/medications/side-effects/taxonomy";

/**
 * v1.4.25 W19d — GLP-1 side-effect section for the medication detail
 * page. Sits below the drug-level chart and above the intake history
 * timeline. Mounted only for `treatmentClass === "GLP1"` rows.
 *
 * UX shape:
 *   - Section header + "Log side effect" CTA opens a modal dialog.
 *   - Inside the dialog: category picker → entry chip-picker (filtered
 *     by category) → 5-Likert severity ladder → optional notes.
 *   - Below the header: timeline of the last 30 days, newest first,
 *     each row showing category badge + entry label + severity chip +
 *     timestamp + delete button + collapsed notes.
 *
 * Component-tests cover: empty state, category → entry filtering,
 * submit-and-refetch flow, severity-label translation lookup.
 */

interface SideEffectRow {
  id: string;
  category: MedicationSideEffectCategory;
  entry: MedicationSideEffectEntry;
  severity: number;
  occurredAt: string;
  notes: string | null;
  createdAt: string;
}

interface SideEffectsSectionProps {
  medicationId: string;
}

const NOTES_MAX = 280;

function categoryI18nKey(category: MedicationSideEffectCategory): string {
  // GI → gi, METABOLIC → metabolic, INJECTION_SITE → injectionSite,
  // COGNITIVE → cognitive, GLP1_SPECIFIC → glp1Specific.
  switch (category) {
    case "GI":
      return "gi";
    case "METABOLIC":
      return "metabolic";
    case "INJECTION_SITE":
      return "injectionSite";
    case "COGNITIVE":
      return "cognitive";
    case "GLP1_SPECIFIC":
      return "glp1Specific";
  }
}

function entryI18nKey(entry: MedicationSideEffectEntry): string {
  // SCREAMING_SNAKE → camelCase.
  return entry
    .toLowerCase()
    .replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

export function SideEffectsSection({ medicationId }: SideEffectsSectionProps) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const queryClient = useQueryClient();

  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<MedicationSideEffectCategory>("GI");
  const [entry, setEntry] = useState<MedicationSideEffectEntry | null>(null);
  const [severity, setSeverity] = useState<1 | 2 | 3 | 4 | 5 | null>(null);
  const [notes, setNotes] = useState<string>("");
  const [formError, setFormError] = useState<string | null>(null);

  const listKey = [
    "medications",
    medicationId,
    "side-effects",
    "list",
  ] as const;

  const { data, isLoading } = useQuery({
    queryKey: listKey,
    queryFn: async () => {
      // Last 30 days, newest-first.
      const to = new Date();
      const from = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
      const url = `/api/medications/${medicationId}/side-effects?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}&limit=100`;
      const res = await fetch(url);
      if (!res.ok) return { items: [] as SideEffectRow[], meta: { total: 0 } };
      const json = (await res.json()) as {
        data: { items: SideEffectRow[]; meta: { total: number } };
      };
      return json.data;
    },
    staleTime: 30 * 1000,
  });

  const createMutation = useMutation({
    mutationFn: async (payload: {
      category: MedicationSideEffectCategory;
      entry: MedicationSideEffectEntry;
      severity: number;
      notes: string | null;
    }) => {
      const res = await fetch(
        `/api/medications/${medicationId}/side-effects`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(body.error ?? "Failed to log side effect");
      }
      return (await res.json()).data as SideEffectRow;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: listKey });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (logId: string) => {
      const res = await fetch(
        `/api/medications/${medicationId}/side-effects/${logId}`,
        { method: "DELETE" },
      );
      if (!res.ok) throw new Error("Failed to delete entry");
      return true;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: listKey });
    },
  });

  const items = data?.items ?? [];

  const filteredEntries = useMemo(
    () => entriesByCategory(category),
    [category],
  );

  function resetForm() {
    setCategory("GI");
    setEntry(null);
    setSeverity(null);
    setNotes("");
    setFormError(null);
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setFormError(null);
    if (!entry) {
      setFormError(t("medications.sideEffects.errorEntry"));
      return;
    }
    if (!severity) {
      setFormError(t("medications.sideEffects.errorSeverity"));
      return;
    }
    createMutation.mutate(
      {
        category: categoryForEntry(entry),
        entry,
        severity,
        notes: notes.trim() ? notes.trim().slice(0, NOTES_MAX) : null,
      },
      {
        onSuccess: () => {
          resetForm();
          setOpen(false);
        },
        onError: (err) => {
          setFormError(err instanceof Error ? err.message : String(err));
        },
      },
    );
  }

  return (
    <section
      className="border-border/60 rounded-md border"
      aria-labelledby="side-effects-heading"
    >
      <header className="flex items-center justify-between px-3 py-2.5">
        <h2
          id="side-effects-heading"
          className="text-foreground/85 text-sm font-medium"
        >
          {t("medications.sideEffects.section")}
          {items.length > 0 && (
            <span className="text-muted-foreground ml-1.5 font-normal">
              ({items.length})
            </span>
          )}
        </h2>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            resetForm();
            setOpen(true);
          }}
        >
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          {t("medications.sideEffects.addCta")}
        </Button>
      </header>

      <div className="border-border/60 border-t px-3 py-2.5 text-xs">
        {isLoading && (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            <span>{t("medications.sideEffects.loading")}</span>
          </div>
        )}

        {!isLoading && items.length === 0 && (
          <p className="text-muted-foreground py-1">
            {t("medications.sideEffects.emptyState")}
          </p>
        )}

        {!isLoading && items.length > 0 && (
          <div className="space-y-2">
            <p className="text-muted-foreground text-[11px] uppercase tracking-wide">
              {t("medications.sideEffects.recentTitle")}
            </p>
            <ul className="space-y-1.5">
              {items.map((row) => (
                <li
                  key={row.id}
                  className="bg-muted/30 flex items-start justify-between gap-2 rounded-md px-2.5 py-2"
                >
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge variant="outline" className="text-[10px]">
                        {t(
                          `medications.sideEffects.categories.${categoryI18nKey(row.category)}`,
                        )}
                      </Badge>
                      <span className="text-foreground font-medium">
                        {t(
                          `medications.sideEffects.entries.${entryI18nKey(row.entry)}`,
                        )}
                      </span>
                      <Badge variant="secondary" className="text-[10px]">
                        {t(
                          `medications.sideEffects.severity.${severityLikertLabel(row.severity as 1 | 2 | 3 | 4 | 5)}`,
                        )}
                      </Badge>
                    </div>
                    <p className="text-muted-foreground text-[11px]">
                      {fmt.dateShort(new Date(row.occurredAt))}
                    </p>
                    {row.notes && (
                      <p className="text-foreground/80 whitespace-pre-wrap break-words">
                        {row.notes}
                      </p>
                    )}
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-muted-foreground hover:text-destructive h-7 w-7 shrink-0"
                    aria-label={t("medications.sideEffects.deleteCta")}
                    onClick={() => {
                      if (
                        typeof window === "undefined" ||
                        window.confirm(
                          t("medications.sideEffects.deleteConfirm"),
                        )
                      ) {
                        deleteMutation.mutate(row.id);
                      }
                    }}
                    disabled={deleteMutation.isPending}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("medications.sideEffects.sheetTitle")}</DialogTitle>
          </DialogHeader>

          <form
            onSubmit={handleSubmit}
            className="space-y-4"
            aria-label={t("medications.sideEffects.sheetTitle")}
          >
            <div className="space-y-1.5">
              <Label htmlFor="side-effect-category">
                {t("medications.sideEffects.categoryLabel")}
              </Label>
              <select
                id="side-effect-category"
                value={category}
                onChange={(e) => {
                  const next = e.target.value as MedicationSideEffectCategory;
                  setCategory(next);
                  // Reset entry — the previously-selected entry probably
                  // doesn't belong to the new category.
                  setEntry(null);
                }}
                className="border-input bg-background text-foreground w-full rounded-md border px-2 py-1.5 text-sm"
              >
                {SIDE_EFFECT_CATEGORY_ORDER.map((c) => (
                  <option key={c} value={c}>
                    {t(
                      `medications.sideEffects.categories.${categoryI18nKey(c)}`,
                    )}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1.5">
              <Label>{t("medications.sideEffects.entryLabel")}</Label>
              <div
                className="flex flex-wrap gap-1.5"
                role="radiogroup"
                aria-label={t("medications.sideEffects.entryLabel")}
              >
                {filteredEntries.map((candidate) => {
                  const selected = candidate === entry;
                  return (
                    <button
                      type="button"
                      key={candidate}
                      role="radio"
                      aria-checked={selected}
                      onClick={() => setEntry(candidate)}
                      className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
                        selected
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-border bg-background text-foreground hover:bg-muted"
                      }`}
                    >
                      {t(
                        `medications.sideEffects.entries.${entryI18nKey(candidate)}`,
                      )}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>{t("medications.sideEffects.severityLabel")}</Label>
              <div
                className="flex flex-wrap gap-1.5"
                role="radiogroup"
                aria-label={t("medications.sideEffects.severityLabel")}
              >
                {SIDE_EFFECT_SEVERITY_LADDER.map((label, idx) => {
                  const value = (idx + 1) as 1 | 2 | 3 | 4 | 5;
                  const selected = severity === value;
                  return (
                    <button
                      type="button"
                      key={label}
                      role="radio"
                      aria-checked={selected}
                      onClick={() => setSeverity(value)}
                      className={`min-w-[2.5rem] rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors ${
                        selected
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-border bg-background text-foreground hover:bg-muted"
                      }`}
                    >
                      <span aria-hidden className="block text-sm">
                        {value}
                      </span>
                      <span className="block text-[10px] opacity-80">
                        {t(`medications.sideEffects.severity.${label}`)}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="side-effect-notes">
                {t("medications.sideEffects.notesLabel")}
              </Label>
              <textarea
                id="side-effect-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value.slice(0, NOTES_MAX))}
                placeholder={t("medications.sideEffects.notesPlaceholder")}
                rows={3}
                maxLength={NOTES_MAX}
                className="border-input bg-background text-foreground w-full rounded-md border px-2 py-1.5 text-sm"
              />
              <p className="text-muted-foreground text-right text-[10px]">
                {notes.length} / {NOTES_MAX}
              </p>
            </div>

            {formError && (
              <p className="text-destructive text-sm" role="alert">
                {formError}
              </p>
            )}

            <DialogFooter className="gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() => setOpen(false)}
              >
                {t("medications.sideEffects.cancelCta")}
              </Button>
              <Button type="submit" disabled={createMutation.isPending}>
                {createMutation.isPending && (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                )}
                {t("medications.sideEffects.submitCta")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}
