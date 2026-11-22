"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { showErrorToast } from "@/lib/errors/error-toast";

import { Button } from "@/components/ui/button";
import { SettingsCardActions } from "@/components/settings/_card-actions";
import { Label } from "@/components/ui/label";
import { QueryErrorCard } from "@/components/ui/query-error-card";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toastWrittenOutcome } from "@/components/outcome/outcome-toast";
import { apiGet, apiPatch } from "@/lib/api/api-fetch";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import {
  ADVANCE_DIRECTIVE_STATUS_VALUES,
  EMERGENCY_BLOOD_TYPE_VALUES,
  EMERGENCY_CONTACTS_MAX,
  EMERGENCY_IMPLANTS_MAX,
  EMERGENCY_NOTE_MAX,
  ORGAN_DONOR_STATUS_VALUES,
  type EmergencyProfileDto,
} from "@/lib/validations/emergency-profile";

export interface Draft {
  bloodType: string;
  organDonor: string;
  advanceDirective: string;
  contacts: string;
  implants: string;
  note: string;
}

/**
 * The select value that stands for "not recorded". Radix refuses an empty
 * string as an item value, so the cleared state needs a sentinel of its own;
 * the draft keeps "" and only the select sees this.
 */
const NOT_RECORDED = "__none__";

type EnumKey = "bloodType" | "organDonor" | "advanceDirective";
const ENUM_KEYS: readonly EnumKey[] = [
  "bloodType",
  "organDonor",
  "advanceDirective",
];

/**
 * The PATCH body for a save. A select rides only when it changed, so a save
 * leaves a column it did not touch alone; a changed select that is now empty
 * rides as `null`, which is what clears it. The free-text fields always ride,
 * an emptied one clearing its column server-side.
 *
 * An empty select used to be omitted always, and the select had no empty
 * option to begin with: a blood type, once chosen, could be changed to
 * another one but never taken back to "not recorded".
 */
export function emergencyPatchBody(
  draft: Draft,
  stored: EmergencyProfileDto,
): Record<string, string | null> {
  const body: Record<string, string | null> = {};
  for (const key of ENUM_KEYS) {
    const next = draft[key] || null;
    if (next !== (stored[key] ?? null)) body[key] = next;
  }
  body.contacts = draft.contacts;
  body.implants = draft.implants;
  body.note = draft.note;
  return body;
}

function draftFromDto(dto: EmergencyProfileDto): Draft {
  return {
    bloodType: dto.bloodType ?? "",
    organDonor: dto.organDonor ?? "",
    advanceDirective: dto.advanceDirective ?? "",
    contacts: dto.contacts ?? "",
    implants: dto.implants ?? "",
    note: dto.note ?? "",
  };
}

export function EmergencyProfileManager() {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft | null>(null);

  const query = useQuery({
    queryKey: queryKeys.emergencyProfile(),
    queryFn: () => apiGet<EmergencyProfileDto>("/api/anamnesis/emergency"),
  });

  const current = draft ?? (query.data ? draftFromDto(query.data) : null);

  const save = useMutation({
    mutationKey: queryKeys.emergencyProfile(),
    mutationFn: (input: Draft) =>
      apiPatch<EmergencyProfileDto>(
        "/api/anamnesis/emergency",
        emergencyPatchBody(input, query.data!),
      ),
    onSuccess: (data) => {
      setDraft(draftFromDto(data));
      queryClient.setQueryData(queryKeys.emergencyProfile(), data);
      toastWrittenOutcome("success", t("records.emergency.savedToast"));
    },
    onError: (failure) =>
      showErrorToast(t("records.emergency.saveError"), { cause: failure }),
  });

  if (query.isError) {
    return (
      <QueryErrorCard
        error={query.error}
        title={t("records.emergency.loadError")}
        onRetry={() => void query.refetch()}
      />
    );
  }

  const disabled = query.isLoading || save.isPending || current === null;
  // Save stays off until a field differs from the stored profile, like every
  // other Save on this page; a fresh draft that matches the record is not a
  // change.
  const dirty =
    draft !== null &&
    query.data != null &&
    JSON.stringify(draft) !== JSON.stringify(draftFromDto(query.data));
  const set = (patch: Partial<Draft>) =>
    setDraft((prev) => ({ ...(prev ?? draftFromDto(query.data!)), ...patch }));

  const enumField = (
    key: EnumKey,
    values: readonly string[],
    valuePrefix: string,
  ) => (
    <div className="space-y-2">
      <Label htmlFor={`emergency-${key}`}>
        {t(`records.emergency.${key}`)}
      </Label>
      <Select
        value={current?.[key] || NOT_RECORDED}
        disabled={disabled}
        onValueChange={(next) =>
          set({ [key]: next === NOT_RECORDED ? "" : next } as Partial<Draft>)
        }
      >
        <SelectTrigger id={`emergency-${key}`} className="w-full">
          <SelectValue placeholder={t("records.emergency.notRecorded")} />
        </SelectTrigger>
        <SelectContent>
          {/* The way back to "not recorded", as every optional select in the
              records offers one. */}
          <SelectItem value={NOT_RECORDED}>
            {t("records.emergency.notRecorded")}
          </SelectItem>
          {values.map((option) => (
            <SelectItem key={option} value={option}>
              {t(`records.emergency.${valuePrefix}.${option}`)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );

  const textField = (
    key: "contacts" | "implants" | "note",
    max: number,
    rows: number,
  ) => (
    <div className="space-y-2">
      <Label htmlFor={`emergency-${key}`}>
        {t(`records.emergency.${key}`)}
      </Label>
      <Textarea
        id={`emergency-${key}`}
        value={current?.[key] ?? ""}
        maxLength={max}
        rows={rows}
        disabled={disabled}
        placeholder={t(`records.emergency.${key}Placeholder`)}
        onChange={(event) =>
          set({ [key]: event.target.value } as Partial<Draft>)
        }
      />
    </div>
  );

  return (
    <div className="space-y-6" data-slot="emergency-profile-manager">
      <div className="grid gap-4 md:grid-cols-3">
        {enumField("bloodType", EMERGENCY_BLOOD_TYPE_VALUES, "bloodTypeValues")}
        {enumField("organDonor", ORGAN_DONOR_STATUS_VALUES, "organDonorValues")}
        {enumField(
          "advanceDirective",
          ADVANCE_DIRECTIVE_STATUS_VALUES,
          "advanceDirectiveValues",
        )}
      </div>

      {textField("contacts", EMERGENCY_CONTACTS_MAX, 3)}
      {textField("implants", EMERGENCY_IMPLANTS_MAX, 2)}
      {textField("note", EMERGENCY_NOTE_MAX, 3)}

      <p className="text-muted-foreground text-xs">
        {t("records.emergency.reportHint")}
      </p>

      {/* The card these details fill: a page of its own, so the way there is
          a button in the action row (ui-standards §12), secondary to Save. */}
      <SettingsCardActions>
        <Button
          asChild
          type="button"
          variant="outline"
          size="sm"
          className="min-h-11 sm:min-h-9"
        >
          <Link href="/emergency-card" data-slot="emergency-card-entry">
            {t("records.emergency.cardLink")}
          </Link>
        </Button>
        <Button
          type="button"
          size="sm"
          className="min-h-11 sm:min-h-9"
          disabled={disabled || !dirty}
          onClick={() => current && save.mutate(current)}
        >
          {save.isPending && (
            <Loader2
              className="size-4 animate-spin motion-reduce:animate-none"
              aria-hidden
            />
          )}
          {t("records.emergency.save")}
        </Button>
      </SettingsCardActions>
    </div>
  );
}
