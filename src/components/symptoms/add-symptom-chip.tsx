"use client";

/**
 * The dashed ghost chip at the end of the symptom row that opens a compact
 * name + icon popover to define a new symptom. The cycle log sheet's
 * `AddSymptomChip`, the same shape and the same popover, so defining a symptom
 * reads the same wherever it happens.
 */
import { useState } from "react";
import { Loader2, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ApiError } from "@/lib/api/api-fetch";
import { useTranslations } from "@/lib/i18n/context";
import { MAX_ACTIVE_SYMPTOM_DEFINITIONS } from "@/lib/symptoms/shared";

import { SymptomIconPicker } from "./symptom-icon-picker";
import { useCreateSymptomDefinition } from "./use-symptoms";

export function AddSymptomChip({
  onCreated,
}: {
  onCreated: (id: string) => void;
}) {
  const { t } = useTranslations();
  const create = useCreateSymptomDefinition();
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [icon, setIcon] = useState<string>("Tag");

  function reset() {
    setLabel("");
    setIcon("Tag");
    create.reset();
  }

  async function handleCreate() {
    const trimmed = label.trim();
    if (!trimmed) return;
    try {
      const created = await create.mutateAsync({ label: trimmed, icon });
      // Selected straight away: defining one is almost always followed by
      // logging it.
      onCreated(created.id);
      reset();
      setOpen(false);
    } catch {
      // `create.error` drives the inline message below.
    }
  }

  const limitReached =
    create.error instanceof ApiError &&
    create.error.meta?.errorCode === "symptoms.definition.limitReached";
  // The server names its cap on the refusal; the constant is the same number.
  const refusedLimit =
    create.error instanceof ApiError ? create.error.meta?.limit : undefined;
  const refusedAt =
    typeof refusedLimit === "number"
      ? refusedLimit
      : MAX_ACTIVE_SYMPTOM_DEFINITIONS;

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="symptom-add-chip"
          className="border-border text-muted-foreground hover:border-primary hover:text-primary focus-visible:ring-ring/50 inline-flex min-h-11 items-center gap-2 rounded-full border border-dashed px-3 py-1.5 text-sm transition-colors focus-visible:ring-2 focus-visible:outline-none sm:min-h-8"
        >
          <Plus className="size-3.5" aria-hidden="true" />
          {t("symptoms.add")}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="new-symptom-label" className="text-xs font-medium">
            {t("symptoms.nameLabel")}
          </Label>
          <Input
            id="new-symptom-label"
            value={label}
            maxLength={40}
            autoFocus
            placeholder={t("symptoms.namePlaceholder")}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void handleCreate();
              }
            }}
          />
        </div>
        <div className="space-y-1.5">
          <p className="text-xs font-medium">{t("symptoms.iconLabel")}</p>
          <SymptomIconPicker
            value={icon}
            onChange={setIcon}
            label={t("symptoms.iconLabel")}
          />
        </div>
        {create.isError ? (
          <p className="text-destructive text-sm" role="alert">
            {limitReached
              ? t("symptoms.limitReached", { limit: refusedAt })
              : t("symptoms.saveError")}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              reset();
              setOpen(false);
            }}
          >
            {t("common.cancel")}
          </Button>
          <Button
            size="sm"
            onClick={handleCreate}
            disabled={!label.trim() || create.isPending}
          >
            {create.isPending ? (
              <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />
            ) : null}
            {t("symptoms.add")}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
