"use client";

import { Loader2, Plus } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useTranslations } from "@/lib/i18n/context";

import {
  isCategoryLimitError,
  useCreateMedicationCategory,
} from "./use-medication-categories";

/**
 * v1.40 (#1041) — the inline "New category" row: a dashed row (the cycle
 * log's add-symptom pattern) that opens into a label field in place, so
 * creating a category never leaves the wizard or the manage sheet. The
 * caller hears the new key as soon as the category exists.
 */
export function AddMedicationCategoryRow({
  onCreated,
}: {
  onCreated?: (key: string) => void;
}) {
  const { t } = useTranslations();
  const create = useCreateMedicationCategory();
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");

  function close() {
    setOpen(false);
    setLabel("");
    create.reset();
  }

  async function submit() {
    const trimmed = label.trim();
    if (!trimmed) return;
    try {
      const created = await create.mutateAsync({ label: trimmed });
      onCreated?.(created.key);
      close();
    } catch {
      // `create.error` drives the inline message below.
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="border-border text-muted-foreground hover:border-primary hover:text-primary focus-visible:ring-ring/50 flex min-h-11 w-full items-center gap-3 rounded-md border border-dashed p-3 text-sm transition-colors focus-visible:ring-2 focus-visible:outline-none"
        data-slot="wizard-class-add"
      >
        <Plus className="h-5 w-5 shrink-0" aria-hidden="true" />
        {t("medications.category.custom.add")}
      </button>
    );
  }

  return (
    <div
      className="space-y-2 rounded-md border p-3"
      data-slot="wizard-class-add-form"
    >
      <Input
        value={label}
        maxLength={40}
        autoFocus
        aria-label={t("medications.category.custom.label")}
        placeholder={t("medications.category.custom.labelPlaceholder")}
        onChange={(e) => setLabel(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void submit();
          }
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            close();
          }
        }}
      />
      {create.error ? (
        <p className="text-destructive text-sm" role="alert">
          {isCategoryLimitError(create.error)
            ? t("medications.category.custom.limitReached")
            : t("medications.category.custom.saveFailed")}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="min-h-11 sm:min-h-9"
          onClick={close}
        >
          {t("common.cancel")}
        </Button>
        <Button
          type="button"
          size="sm"
          className="min-h-11 sm:min-h-9"
          onClick={() => void submit()}
          disabled={!label.trim() || create.isPending}
        >
          {create.isPending ? (
            <Loader2
              className="size-3.5 animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
          ) : null}
          {t("medications.category.custom.create")}
        </Button>
      </div>
    </div>
  );
}
