"use client";

/**
 * v1.42 (#1005) — define, edit or remove one of the record's own vaccines.
 *
 * A definition is a product the shipped catalogue does not list: a name, the
 * diseases it protects against (the catalogue's own antigen list, because the
 * series and the booster match key on it), and optionally the series length
 * and the booster interval. A dose logged against it then counts like a
 * catalogue pick (`resolve-vaccine-entry.ts`).
 *
 * Save needs a name and at least one disease; nothing else is required.
 * Removing asks first and says what happens to the doses: they stay, under
 * the definition's name.
 *
 * Capability note: the same posture as the dose sheet. Create needs WRITE on
 * `profile`, edit and remove need MANAGE; the mounts ask before opening it.
 */
import { useState } from "react";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { FieldGroup } from "@/components/ui/field-group";
import { Input } from "@/components/ui/input";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { toastWrittenOutcome } from "@/components/outcome/outcome-toast";
import { ApiError } from "@/lib/api/api-fetch";
import { useTranslations } from "@/lib/i18n/context";
import { ANTIGEN_SLUGS } from "@/lib/vaccinations/vaccine-catalog";
import {
  useCustomVaccineMutations,
  type CustomVaccine,
  type CustomVaccineWriteBody,
} from "./use-vaccinations";

export interface CustomVaccineDraft {
  name: string;
  components: string[];
  typicalSeriesDoses: string;
  boosterIntervalMonths: string;
}

export function customVaccineDraft(
  row: CustomVaccine | null,
): CustomVaccineDraft {
  return {
    name: row?.name ?? "",
    components: row ? [...row.components] : [],
    typicalSeriesDoses: row?.typicalSeriesDoses?.toString() ?? "",
    boosterIntervalMonths: row?.boosterIntervalMonths?.toString() ?? "",
  };
}

function toInt(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const n = Number.parseInt(trimmed, 10);
  return Number.isNaN(n) ? null : n;
}

/** The body a draft becomes; null while it cannot be saved. */
export function customVaccineBody(
  draft: CustomVaccineDraft,
): CustomVaccineWriteBody | null {
  const name = draft.name.trim();
  if (!name || draft.components.length === 0) return null;
  return {
    name,
    // Catalogue order, so the same choice always reads the same way.
    components: ANTIGEN_SLUGS.filter((slug) => draft.components.includes(slug)),
    typicalSeriesDoses: toInt(draft.typicalSeriesDoses),
    boosterIntervalMonths: toInt(draft.boosterIntervalMonths),
  };
}

export function CustomVaccineSheet({
  open,
  onOpenChange,
  customVaccine,
  canRemove = false,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** `null` creates a definition; a row edits it. */
  customVaccine: CustomVaccine | null;
  /** Offer the removal; the caller asks for MANAGE first. */
  canRemove?: boolean;
  /** Raised with the saved definition, e.g. to pick it in the dose form. */
  onSaved?: (saved: CustomVaccine) => void;
}) {
  const { t } = useTranslations();
  const { create, update, remove } = useCustomVaccineMutations();
  // Seeded once at mount; the caller remounts on every open by varying `key`.
  const [draft, setDraft] = useState<CustomVaccineDraft>(() =>
    customVaccineDraft(customVaccine),
  );
  const [error, setError] = useState<string | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  // The diseases an edit opens with lead the list, so what the definition
  // covers is visible without scrolling; the order is fixed at mount so a
  // box never jumps away from the pointer that ticked it.
  const [antigenOrder] = useState<readonly string[]>(() => {
    const chosen = new Set(customVaccine?.components ?? []);
    return [
      ...ANTIGEN_SLUGS.filter((slug) => chosen.has(slug)),
      ...ANTIGEN_SLUGS.filter((slug) => !chosen.has(slug)),
    ];
  });

  const isEdit = customVaccine !== null;
  const pending = create.isPending || update.isPending;
  const body = customVaccineBody(draft);
  const patch = (part: Partial<CustomVaccineDraft>) =>
    setDraft((current) => ({ ...current, ...part }));

  const toggle = (antigen: string, on: boolean) =>
    setDraft((current) => ({
      ...current,
      components: on
        ? [...current.components.filter((a) => a !== antigen), antigen]
        : current.components.filter((a) => a !== antigen),
    }));

  const submit = async () => {
    if (!body) return;
    setError(null);
    try {
      const saved = isEdit
        ? await update.mutateAsync({ id: customVaccine.id, body })
        : await create.mutateAsync(body);
      toastWrittenOutcome("success", t("vaccinations.custom.saved"));
      onOpenChange(false);
      onSaved?.(saved);
    } catch (err) {
      const message =
        err instanceof ApiError &&
        err.meta?.errorCode === "vaccination.custom.name-taken"
          ? t("vaccinations.custom.nameTaken")
          : t("vaccinations.custom.saveFailed");
      setError(message);
      toast.error(message);
    }
  };

  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={onOpenChange}
      title={t(
        isEdit ? "vaccinations.custom.editTitle" : "vaccinations.custom.add",
      )}
      description={t("vaccinations.custom.description")}
      footer={
        <>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            {t("common.cancel")}
          </Button>
          <Button
            type="button"
            className="min-h-11"
            data-slot="custom-vaccine-save"
            disabled={!body || pending}
            onClick={() => void submit()}
          >
            {t("common.save")}
          </Button>
        </>
      }
    >
      <div className="space-y-4" data-slot="custom-vaccine-form">
        <FieldGroup
          htmlFor="custom-vaccine-name"
          label={t("vaccinations.custom.name")}
        >
          <Input
            id="custom-vaccine-name"
            value={draft.name}
            maxLength={100}
            onChange={(event) => patch({ name: event.target.value })}
            data-slot="custom-vaccine-name"
          />
        </FieldGroup>

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">
            {t("vaccinations.custom.components")}
          </legend>
          <p className="text-muted-foreground text-xs">
            {t("vaccinations.custom.componentsHint")}
          </p>
          <div
            className="grid max-h-56 grid-cols-1 gap-x-3 overflow-y-auto overscroll-contain rounded-md border p-2 sm:grid-cols-2"
            data-slot="custom-vaccine-components"
          >
            {antigenOrder.map((antigen) => {
              const id = `custom-vaccine-antigen-${antigen}`;
              const checked = draft.components.includes(antigen);
              return (
                <label
                  key={antigen}
                  htmlFor={id}
                  className="hover:bg-muted/60 flex min-h-11 cursor-pointer items-center gap-2 rounded-md px-2 text-sm"
                >
                  <Checkbox
                    id={id}
                    checked={checked}
                    data-antigen={antigen}
                    onCheckedChange={(next) => toggle(antigen, next === true)}
                  />
                  <span className="text-foreground min-w-0 flex-1">
                    {t(`vaccinations.catalog.${antigen}`)}
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>

        <div className="grid gap-4 sm:grid-cols-2">
          <FieldGroup
            htmlFor="custom-vaccine-series"
            label={t("vaccinations.custom.seriesDoses")}
          >
            <Input
              id="custom-vaccine-series"
              type="number"
              inputMode="numeric"
              min={1}
              max={10}
              value={draft.typicalSeriesDoses}
              onChange={(event) =>
                patch({ typicalSeriesDoses: event.target.value })
              }
            />
          </FieldGroup>
          <FieldGroup
            htmlFor="custom-vaccine-booster"
            label={t("vaccinations.custom.boosterMonths")}
            hint={t("vaccinations.custom.boosterHint")}
          >
            <Input
              id="custom-vaccine-booster"
              type="number"
              inputMode="numeric"
              min={1}
              max={600}
              value={draft.boosterIntervalMonths}
              onChange={(event) =>
                patch({ boosterIntervalMonths: event.target.value })
              }
            />
          </FieldGroup>
        </div>

        {error ? (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        ) : null}

        {isEdit && canRemove ? (
          <AlertDialog
            open={confirmingRemove}
            onOpenChange={setConfirmingRemove}
          >
            <AlertDialogTrigger asChild>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                className="min-h-11"
                data-slot="custom-vaccine-delete"
              >
                <Trash2 className="size-4" aria-hidden />
                {t("common.delete")}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {t("vaccinations.custom.deleteTitle")}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {t("vaccinations.custom.deleteConfirm")}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                <AlertDialogAction
                  variant="destructive"
                  onClick={() => {
                    remove.mutate(customVaccine.id, {
                      onSuccess: () => {
                        toastWrittenOutcome(
                          "success",
                          t("vaccinations.custom.deleted"),
                        );
                        onOpenChange(false);
                      },
                      onError: () =>
                        toast.error(t("vaccinations.custom.saveFailed")),
                    });
                  }}
                >
                  {t("common.delete")}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        ) : null}
      </div>
    </ResponsiveSheet>
  );
}
