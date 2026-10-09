"use client";

/**
 * Rung 2, at the point of offer: after a dose whose catalogue entry carries a
 * booster interval, a prefilled — never imposed — prompt to plan the next one.
 *
 * The interval and the label are prefilled from the catalogue and the person's
 * own record, and both are editable before they confirm; declining is one tap
 * and leaves no state behind. Nothing here computes what a person is due: the
 * catalogue's typical interval seeds a reminder the person owns, and that is
 * the whole of the "recommendation". Confirming writes an ordinary Vorsorge
 * reminder that keys on the dose's antigen; the satisfy matcher usually
 * re-anchored one already during the create, so the common path simply confirms
 * the new due date.
 *
 * The prompt never blocks: the create has already completed and the sheet has
 * already closed by the time this appears.
 */
import { useState } from "react";
import { toast } from "sonner";

import { toastWrittenOutcome } from "@/components/outcome/outcome-toast";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { FieldGroup } from "@/components/ui/field-group";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { useTranslations } from "@/lib/i18n/context";
import {
  customLookupOf,
  resolveVaccineEntry,
} from "@/lib/vaccinations/resolve-vaccine-entry";
import { useBoosterMint, type Vaccination } from "./use-vaccinations";

/**
 * Whether a freshly created dose should raise the offer at all. Only an entry
 * that carries a booster interval and an antigen to key it on does — a
 * catalogue pick or the person's own definition alike; a free-text row and a
 * one-off vaccine never prompt.
 */
export function boosterOfferFor(record: Vaccination): {
  intervalMonths: number;
  /** The catalogue slug, or null for the person's own definition. */
  slug: string | null;
  /** The definition's own name, or null for a catalogue entry. */
  name: string | null;
} | null {
  const entry = resolveVaccineEntry(
    record,
    customLookupOf([record.customVaccine]),
  );
  if (
    !entry ||
    entry.boosterIntervalMonths === null ||
    entry.components.length === 0
  ) {
    return null;
  }
  return {
    intervalMonths: entry.boosterIntervalMonths,
    slug: entry.slug,
    name: entry.name,
  };
}

const MONTH_OPTIONS = [6, 12, 24, 36, 60, 120] as const;

export function BoosterMintPrompt({
  record,
  onClose,
}: {
  /** The just-created dose, or null when there is nothing to offer. */
  record: Vaccination | null;
  onClose: () => void;
}) {
  const { t, tCount } = useTranslations();
  const mint = useBoosterMint();
  const offer = record ? boosterOfferFor(record) : null;

  // The default label is the catalogue name plus the booster word, composed in
  // the person's own locale — the server never resolves an i18n key.
  const defaultLabel =
    record && offer
      ? `${offer.slug ? t(`vaccinations.catalog.${offer.slug}`) : offer.name} ${t("vaccinations.booster.labelSuffix")}`
      : "";
  const [label, setLabel] = useState(defaultLabel);
  const [months, setMonths] = useState<number>(offer?.intervalMonths ?? 12);

  // The prompt is only mounted when there is an offer; guard for the type.
  if (!record || !offer) return null;

  const confirm = async () => {
    try {
      await mint.mutateAsync({
        id: record.id,
        body: { intervalMonths: months, label: label.trim() || defaultLabel },
      });
      toastWrittenOutcome("success", t("vaccinations.booster.planned"));
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : t("vaccinations.booster.failed"),
      );
    } finally {
      onClose();
    }
  };

  const intervalOptions = MONTH_OPTIONS.includes(
    offer.intervalMonths as (typeof MONTH_OPTIONS)[number],
  )
    ? MONTH_OPTIONS
    : ([offer.intervalMonths, ...MONTH_OPTIONS] as readonly number[]);

  return (
    <AlertDialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("vaccinations.booster.title")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("vaccinations.booster.body")}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-3">
          <FieldGroup
            htmlFor="booster-interval"
            label={t("vaccinations.booster.interval")}
          >
            <NativeSelect
              id="booster-interval"
              value={String(months)}
              onChange={(event) => setMonths(Number(event.target.value))}
            >
              {intervalOptions.map((value) => (
                <option key={value} value={value}>
                  {value % 12 === 0
                    ? tCount("vaccinations.booster.everyYears", value / 12, {
                        count: value / 12,
                      })
                    : tCount("vaccinations.booster.everyMonths", value, {
                        count: value,
                      })}
                </option>
              ))}
            </NativeSelect>
          </FieldGroup>

          <FieldGroup
            htmlFor="booster-label"
            label={t("vaccinations.booster.label")}
          >
            <Input
              id="booster-label"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
            />
          </FieldGroup>
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel data-slot="vaccination-booster-decline">
            {t("vaccinations.booster.decline")}
          </AlertDialogCancel>
          <AlertDialogAction
            data-slot="vaccination-booster-confirm"
            disabled={mint.isPending}
            onClick={(event) => {
              // Keep the dialog until the write settles, then close it.
              event.preventDefault();
              void confirm();
            }}
          >
            {t("vaccinations.booster.confirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
