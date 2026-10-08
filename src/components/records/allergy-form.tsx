"use client";

import { useId, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { DateField } from "@/components/ui/date-field";
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
import {
  allergyCategoryEnum,
  allergySeverityEnum,
  allergyStatusEnum,
  allergyTypeEnum,
} from "@/lib/validations/allergy";
import { useTranslations } from "@/lib/i18n/context";

import type { AllergyDTO } from "@/lib/records/dto";
import { dateOnlyAtNoonUtc, isCalendarDateKey } from "@/lib/tz/date-only";

const TEXT_MAX_LENGTH = 2000;
/** Select sentinel for the optional "not assessed" severity. */
const SEVERITY_NONE = "NONE";

interface AllergyFormProps {
  /** When set the form edits this record; otherwise it creates a new one. */
  existing?: AllergyDTO;
  onSuccess?: (saved: AllergyDTO) => void;
  onCancel?: () => void;
  /** The sheet footer slot the Cancel / Save row portals into when present. */
  footerSlot?: HTMLElement | null;
}

/**
 * ISO date input (YYYY-MM-DD) → the instant a date-only value is stored at
 * (noon UTC), or undefined. UTC midnight read back as the previous day west
 * of UTC.
 */
function toInstant(value: string): string | undefined {
  if (!isCalendarDateKey(value)) return undefined;
  return dateOnlyAtNoonUtc(value).toISOString();
}

/**
 * v1.25 (W-RECORDS) — create or edit a structured allergy/intolerance record.
 *
 * `substance` is the queryable label; the free-text reaction + note are
 * encrypted server-side. Patient-reported reference data, not a clinical
 * diagnosis.
 */
export function AllergyForm({
  existing,
  onSuccess,
  onCancel,
  footerSlot,
}: AllergyFormProps) {
  const { t } = useTranslations();
  const formId = useId();

  const [substance, setSubstance] = useState(existing?.substance ?? "");
  const [category, setCategory] = useState(existing?.category ?? "OTHER");
  const [type, setType] = useState(existing?.type ?? "ALLERGY");
  const [severity, setSeverity] = useState(existing?.severity ?? SEVERITY_NONE);
  const [status, setStatus] = useState(existing?.status ?? "ACTIVE");
  const [onsetDate, setOnsetDate] = useState(
    existing?.onsetAt ? existing.onsetAt.slice(0, 10) : "",
  );
  const [reaction, setReaction] = useState(existing?.reaction ?? "");
  const [note, setNote] = useState(existing?.note ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!substance.trim()) {
      setError(t("records.allergies.form.requiredError"));
      return;
    }

    const body = {
      substance: substance.trim(),
      category,
      type,
      severity: severity === SEVERITY_NONE ? null : severity,
      status,
      onsetAt: onsetDate ? (toInstant(onsetDate) ?? null) : null,
      reaction: reaction.trim() ? reaction.trim() : null,
      note: note.trim() ? note.trim() : null,
    };

    setSubmitting(true);
    try {
      const saved = existing
        ? await apiPut<AllergyDTO>(`/api/allergies/${existing.id}`, body)
        : await apiPost<AllergyDTO>("/api/allergies", body);
      toast.success(
        existing
          ? t("records.allergies.form.updatedToast")
          : t("records.allergies.form.savedToast"),
      );
      onSuccess?.(saved);
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.message
          : t("records.allergies.form.saveError");
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
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="allergy-substance">
            {t("records.allergies.form.substance")}
          </Label>
          <Input
            id="allergy-substance"
            value={substance}
            onChange={(e) => setSubstance(e.target.value)}
            placeholder={t("records.allergies.form.substancePlaceholder")}
            maxLength={160}
            autoFocus
            required
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="allergy-category">
            {t("records.allergies.form.category")}
          </Label>
          <Select value={category} onValueChange={setCategory}>
            <SelectTrigger id="allergy-category" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {allergyCategoryEnum.options.map((opt) => (
                <SelectItem key={opt} value={opt}>
                  {t(`records.allergies.category.${opt}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="allergy-type">
            {t("records.allergies.form.type")}
          </Label>
          <Select value={type} onValueChange={setType}>
            <SelectTrigger id="allergy-type" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {allergyTypeEnum.options.map((opt) => (
                <SelectItem key={opt} value={opt}>
                  {t(`records.allergies.type.${opt}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="allergy-severity">
            {t("records.allergies.form.severity")}
          </Label>
          <Select value={severity} onValueChange={setSeverity}>
            <SelectTrigger id="allergy-severity" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={SEVERITY_NONE}>
                {t("records.allergies.severity.NONE")}
              </SelectItem>
              {allergySeverityEnum.options.map((opt) => (
                <SelectItem key={opt} value={opt}>
                  {t(`records.allergies.severity.${opt}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="allergy-status">
            {t("records.allergies.form.status")}
          </Label>
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger id="allergy-status" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {allergyStatusEnum.options.map((opt) => (
                <SelectItem key={opt} value={opt}>
                  {t(`records.allergies.status.${opt}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="allergy-onset">
            {t("records.allergies.form.onset")}
          </Label>
          <DateField
            id="allergy-onset"
            value={onsetDate}
            onChange={setOnsetDate}
          />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="allergy-reaction">
            {t("records.allergies.form.reaction")}
          </Label>
          <Textarea
            id="allergy-reaction"
            value={reaction}
            onChange={(e) => setReaction(e.target.value)}
            placeholder={t("records.allergies.form.reactionPlaceholder")}
            maxLength={TEXT_MAX_LENGTH}
            rows={2}
          />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="allergy-note">
            {t("records.allergies.form.note")}
          </Label>
          <Textarea
            id="allergy-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={t("records.allergies.form.notePlaceholder")}
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
