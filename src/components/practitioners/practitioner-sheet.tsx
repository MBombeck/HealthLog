"use client";

/**
 * Add or correct one address-book entry.
 *
 * Six plaintext-ish fields and one encrypted note. `name` is the only required
 * one, for the same reason the visit only requires a date: a person typing a
 * practice into a form after a doctor's appointment should not be stopped by a
 * phone number they do not have to hand.
 *
 * Reachable two ways — from the address-book page and nested inside the visit
 * form's picker — so it owns no navigation of its own and reports what it
 * created back to whoever opened it.
 */
import { useState } from "react";
import { showErrorToast } from "@/lib/errors/error-toast";

import { Button } from "@/components/ui/button";
import { FieldGroup } from "@/components/ui/field-group";
import { Input } from "@/components/ui/input";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { Textarea } from "@/components/ui/textarea";
import { localizedApiError } from "@/lib/api/localized-error";
import { useTranslations } from "@/lib/i18n/context";
import {
  usePractitionerMutations,
  type Practitioner,
  type PractitionerWriteBody,
} from "@/hooks/use-practitioners";

interface Draft {
  name: string;
  specialty: string;
  practice: string;
  location: string;
  phone: string;
  note: string;
}

const EMPTY: Draft = {
  name: "",
  specialty: "",
  practice: "",
  location: "",
  phone: "",
  note: "",
};

function draftFrom(row: Practitioner | null): Draft {
  if (!row) return EMPTY;
  return {
    name: row.name,
    specialty: row.specialty ?? "",
    practice: row.practice ?? "",
    location: row.location ?? "",
    phone: row.phone ?? "",
    note: row.note ?? "",
  };
}

/** An empty field clears the column rather than writing an empty string. */
function orNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function PractitionerSheet({
  open,
  onOpenChange,
  practitioner,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** `null` creates; a row edits it. */
  practitioner: Practitioner | null;
  onSaved?: (row: Practitioner) => void;
}) {
  const { t } = useTranslations();
  const { create, update } = usePractitionerMutations();
  // Seeded once, at mount. The caller varies this component's `key` on every
  // open, so a second edit never shows the first one's values and a create
  // after an edit starts empty — without an effect that copies props into
  // state and briefly renders the stale pair.
  const [seed] = useState<Draft>(() => draftFrom(practitioner));
  const [draft, setDraft] = useState<Draft>(seed);
  const [error, setError] = useState<string | null>(null);

  const pending = create.isPending || update.isPending;
  const nameGiven = draft.name.trim().length > 0;

  const submit = async () => {
    if (!nameGiven) return;
    const body: PractitionerWriteBody = {
      name: draft.name.trim(),
      specialty: orNull(draft.specialty),
      practice: orNull(draft.practice),
      location: orNull(draft.location),
      phone: orNull(draft.phone),
      note: orNull(draft.note),
    };
    try {
      const saved = practitioner
        ? await update.mutateAsync({ id: practitioner.id, body })
        : await create.mutateAsync(body);
      onSaved?.(saved);
      onOpenChange(false);
    } catch (err) {
      const message = localizedApiError(err, t, "practitioners.saveFailed");
      setError(message);
      showErrorToast(message, { cause: err });
    }
  };

  const field = (key: keyof Draft) => ({
    value: draft[key],
    onChange: (
      event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
    ) => setDraft((prev) => ({ ...prev, [key]: event.target.value })),
  });

  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={onOpenChange}
      dirty={JSON.stringify(draft) !== JSON.stringify(seed)}
      title={t(
        practitioner ? "practitioners.editTitle" : "practitioners.createTitle",
      )}
      description={t("practitioners.formDescription")}
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
            disabled={!nameGiven || pending}
            onClick={() => void submit()}
            data-slot="practitioner-save"
            className="min-h-11"
          >
            {t("common.save")}
          </Button>
        </>
      }
    >
      <div className="space-y-4" data-slot="practitioner-form">
        <FieldGroup htmlFor="practitioner-name" label={t("practitioners.name")}>
          <Input
            id="practitioner-name"
            required
            aria-required="true"
            autoComplete="off"
            {...field("name")}
          />
        </FieldGroup>

        <FieldGroup
          htmlFor="practitioner-specialty"
          label={t("practitioners.specialty")}
        >
          <Input id="practitioner-specialty" {...field("specialty")} />
        </FieldGroup>

        <FieldGroup
          htmlFor="practitioner-practice"
          label={t("practitioners.practice")}
        >
          <Input id="practitioner-practice" {...field("practice")} />
        </FieldGroup>

        <FieldGroup
          htmlFor="practitioner-location"
          label={t("practitioners.location")}
        >
          <Input id="practitioner-location" {...field("location")} />
        </FieldGroup>

        <FieldGroup
          htmlFor="practitioner-phone"
          label={t("practitioners.phone")}
        >
          <Input id="practitioner-phone" type="tel" {...field("phone")} />
        </FieldGroup>

        <FieldGroup
          htmlFor="practitioner-note"
          label={t("practitioners.note")}
          hint={t("practitioners.noteHint")}
        >
          <Textarea id="practitioner-note" rows={3} {...field("note")} />
        </FieldGroup>

        {error ? (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        ) : null}
      </div>
    </ResponsiveSheet>
  );
}
