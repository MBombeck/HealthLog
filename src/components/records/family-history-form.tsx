"use client";

import { useId, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, apiPost, apiPut } from "@/lib/api/api-fetch";
import { familyRelationshipEnum } from "@/lib/validations/family-history";
import { useTranslations } from "@/lib/i18n/context";

import type { FamilyHistoryEntryDTO } from "@/lib/records/dto";

const TEXT_MAX_LENGTH = 2000;

interface FamilyHistoryFormProps {
  /** When set the form edits this entry; otherwise it creates a new one. */
  existing?: FamilyHistoryEntryDTO;
  onSuccess?: (saved: FamilyHistoryEntryDTO) => void;
  onCancel?: () => void;
  /** The sheet footer slot the Cancel / Save row portals into when present. */
  footerSlot?: HTMLElement | null;
}

/**
 * v1.25 (W-RECORDS) — create or edit a structured family-history entry (one
 * condition for one relative). `condition` is the queryable label; the
 * free-text note is encrypted server-side. Patient-reported.
 */
export function FamilyHistoryForm({
  existing,
  onSuccess,
  onCancel,
  footerSlot,
}: FamilyHistoryFormProps) {
  const { t } = useTranslations();
  const formId = useId();

  const [relationship, setRelationship] = useState(
    existing?.relationship ?? "MOTHER",
  );
  const [condition, setCondition] = useState(existing?.condition ?? "");
  const [ageAtOnset, setAgeAtOnset] = useState(
    existing?.ageAtOnset != null ? String(existing.ageAtOnset) : "",
  );
  const [note, setNote] = useState(existing?.note ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!condition.trim()) {
      setError(t("records.family.form.requiredError"));
      return;
    }

    let age: number | null = null;
    if (ageAtOnset.trim() !== "") {
      const parsed = Number(ageAtOnset.trim());
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 120) {
        setError(t("records.family.form.ageError"));
        return;
      }
      age = parsed;
    }

    const body = {
      relationship,
      condition: condition.trim(),
      ageAtOnset: age,
      note: note.trim() ? note.trim() : null,
    };

    setSubmitting(true);
    try {
      const saved = existing
        ? await apiPut<FamilyHistoryEntryDTO>(
            `/api/family-history/${existing.id}`,
            body,
          )
        : await apiPost<FamilyHistoryEntryDTO>("/api/family-history", body);
      toast.success(
        existing
          ? t("records.family.form.updatedToast")
          : t("records.family.form.savedToast"),
      );
      onSuccess?.(saved);
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.message
          : t("records.family.form.saveError");
      setError(message);
    } finally {
      setSubmitting(false);
    }
  }

  const footerNode = (
    <>
      {onCancel ? (
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          disabled={submitting}
        >
          {t("common.cancel")}
        </Button>
      ) : null}
      <Button type="submit" form={formId} disabled={submitting}>
        {submitting ? (
          <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
        ) : null}
        {t("common.save")}
      </Button>
    </>
  );

  return (
    <form id={formId} onSubmit={handleSubmit} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="family-relationship">
            {t("records.family.form.relationship")}
          </Label>
          <Select value={relationship} onValueChange={setRelationship}>
            <SelectTrigger id="family-relationship" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {familyRelationshipEnum.options.map((opt) => (
                <SelectItem key={opt} value={opt}>
                  {t(`records.family.relationship.${opt}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="family-age">
            {t("records.family.form.ageAtOnset")}
          </Label>
          <Input
            id="family-age"
            inputMode="numeric"
            value={ageAtOnset}
            onChange={(e) => setAgeAtOnset(e.target.value)}
            placeholder={t("records.family.form.ageAtOnsetPlaceholder")}
          />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="family-condition">
            {t("records.family.form.condition")}
          </Label>
          <Input
            id="family-condition"
            value={condition}
            onChange={(e) => setCondition(e.target.value)}
            placeholder={t("records.family.form.conditionPlaceholder")}
            maxLength={160}
            autoFocus
            required
          />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="family-note">{t("records.family.form.note")}</Label>
          <Textarea
            id="family-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={t("records.family.form.notePlaceholder")}
            maxLength={TEXT_MAX_LENGTH}
            rows={2}
          />
        </div>
      </div>

      {error ? (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      ) : null}

      {footerSlot ? (
        createPortal(footerNode, footerSlot)
      ) : (
        <div className="flex justify-end gap-2">{footerNode}</div>
      )}
    </form>
  );
}
