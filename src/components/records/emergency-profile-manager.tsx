"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

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

interface Draft {
  bloodType: string;
  organDonor: string;
  advanceDirective: string;
  contacts: string;
  implants: string;
  note: string;
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
      apiPatch<EmergencyProfileDto>("/api/anamnesis/emergency", {
        // A select left at "" is "not recorded" and is omitted so a partial
        // save leaves the column untouched; the free-text fields always ride,
        // with an emptied field clearing its column server-side.
        ...(input.bloodType ? { bloodType: input.bloodType } : {}),
        ...(input.organDonor ? { organDonor: input.organDonor } : {}),
        ...(input.advanceDirective
          ? { advanceDirective: input.advanceDirective }
          : {}),
        contacts: input.contacts,
        implants: input.implants,
        note: input.note,
      }),
    onSuccess: (data) => {
      setDraft(draftFromDto(data));
      queryClient.setQueryData(queryKeys.emergencyProfile(), data);
      toastWrittenOutcome("success", t("records.emergency.savedToast"));
    },
    onError: () => toast.error(t("records.emergency.saveError")),
  });

  if (query.isError) {
    return (
      <QueryErrorCard
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
    key: "bloodType" | "organDonor" | "advanceDirective",
    values: readonly string[],
    valuePrefix: string,
  ) => (
    <div className="space-y-2">
      <Label htmlFor={`emergency-${key}`}>
        {t(`records.emergency.${key}`)}
      </Label>
      <Select
        value={current?.[key] ?? ""}
        disabled={disabled}
        onValueChange={(next) => set({ [key]: next } as Partial<Draft>)}
      >
        <SelectTrigger id={`emergency-${key}`} className="w-full">
          <SelectValue placeholder={t("records.emergency.notRecorded")} />
        </SelectTrigger>
        <SelectContent>
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

      <SettingsCardActions>
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
