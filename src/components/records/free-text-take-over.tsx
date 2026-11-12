"use client";

/**
 * v1.43 (#614) — turn the free-text conditions or allergies line into a
 * structured entry, by hand.
 *
 * The free text and the structured records overlap: the chronic conditions
 * live in the condition journal (`IllnessEpisode`, `CHRONIC_ONGOING`), the
 * allergies in `Allergy`. Nothing here parses the free text or merges
 * anything on its own. The button opens a form beside the text; the person
 * types the entry, it is saved through the ordinary create route, and only
 * then is clearing the free text offered, as a separate decision.
 *
 * The button shows only while there is free text and the target is
 * available (`takeOver` from the life-circumstances read).
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";

import { AllergyForm } from "@/components/records/allergy-form";
import { toastWrittenOutcome } from "@/components/outcome/outcome-toast";
import { Button } from "@/components/ui/button";
import { DateField } from "@/components/ui/date-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { apiGet, apiPost, apiPut } from "@/lib/api/api-fetch";
import { useAboutMeSaveTimeoutMs } from "@/hooks/use-ai-capability";
import { withBaseToken } from "@/lib/api/optimistic-token";
import { showErrorToast } from "@/lib/errors/error-toast";
import { useTranslations } from "@/lib/i18n/context";
import type { LifeCircumstancesDto } from "@/lib/profile/life-circumstances";
import {
  allergyDependentKeys,
  illnessDependentKeys,
  invalidateKeys,
  queryKeys,
  refetchInactiveDailyReads,
} from "@/lib/query-keys";
import { dateOnlyAtNoonUtc, isCalendarDateKey } from "@/lib/tz/date-only";

interface AboutMeData {
  conditions: string | null;
  allergies: string | null;
  updatedAt: string | null;
}

export function FreeTextTakeOver({
  field,
}: {
  field: "conditions" | "allergies";
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  const [label, setLabel] = useState("");
  const [onset, setOnset] = useState("");
  const [footerEl, setFooterEl] = useState<HTMLElement | null>(null);

  const life = useQuery({
    queryKey: queryKeys.lifeCircumstances(),
    queryFn: () =>
      apiGet<LifeCircumstancesDto>("/api/anamnesis/life-circumstances"),
  });
  const aboutMe = useQuery({
    queryKey: queryKeys.coachAboutMe(),
    queryFn: () => apiGet<AboutMeData>("/api/coach/about-me"),
  });

  const afterCreate = () => {
    setSaved(true);
    toastWrittenOutcome("success", t("records.life.takeOver.savedToast"));
    void invalidateKeys(queryClient, [
      queryKeys.lifeCircumstances(),
      ...(field === "conditions" ? illnessDependentKeys : allergyDependentKeys),
    ]);
    // A chronic condition frames the dashboard and the Today digest.
    if (field === "conditions") void refetchInactiveDailyReads(queryClient);
  };

  const createCondition = useMutation({
    mutationKey: queryKeys.lifeCircumstances(),
    mutationFn: () =>
      apiPost("/api/illness/episodes", {
        label: label.trim(),
        type: "CHRONIC",
        lifecycle: "CHRONIC_ONGOING",
        ...(isCalendarDateKey(onset)
          ? { onsetAt: dateOnlyAtNoonUtc(onset).toISOString() }
          : {}),
      }),
    onSuccess: afterCreate,
    onError: (error) =>
      showErrorToast(t("records.life.takeOver.saveError"), { cause: error }),
  });

  const saveTimeoutMs = useAboutMeSaveTimeoutMs();
  const clear = useMutation({
    mutationKey: queryKeys.coachAboutMe(),
    mutationFn: () =>
      apiPut(
        "/api/coach/about-me",
        withBaseToken({ [field]: "" }, aboutMe.data?.updatedAt ?? undefined),
        { signal: AbortSignal.timeout(saveTimeoutMs) },
      ),
    onSuccess: () => {
      toastWrittenOutcome("success", t("records.life.takeOver.clearedToast"));
      close();
      void invalidateKeys(queryClient, [
        queryKeys.coachAboutMe(),
        queryKeys.lifeCircumstances(),
      ]);
    },
    onError: (error) =>
      showErrorToast(t("records.life.takeOver.clearError"), { cause: error }),
  });

  function close() {
    setOpen(false);
    setSaved(false);
    setLabel("");
    setOnset("");
  }

  const entry = life.data?.takeOver.find((item) => item.field === field);
  const text = aboutMe.data?.[field] ?? null;
  if (!entry?.freeTextPresent || !entry.available || !text) return null;

  const title =
    field === "conditions"
      ? t("records.life.takeOver.conditionsTitle")
      : t("records.life.takeOver.allergiesTitle");

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="min-h-11 sm:min-h-9"
        onClick={() => setOpen(true)}
        data-slot={`take-over-${field}`}
      >
        {field === "conditions"
          ? t("records.life.takeOver.conditionsButton")
          : t("records.life.takeOver.allergiesButton")}
      </Button>
      <ResponsiveSheet
        open={open}
        onOpenChange={(next) => (next ? setOpen(true) : close())}
        title={title}
        description={t("records.life.takeOver.description")}
        footer={
          saved ? (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="min-h-11 sm:min-h-9"
                onClick={close}
              >
                {t("records.life.takeOver.keep")}
              </Button>
              <Button
                type="button"
                size="sm"
                className="min-h-11 sm:min-h-9"
                disabled={clear.isPending}
                onClick={() => clear.mutate()}
              >
                {t("records.life.takeOver.clear")}
              </Button>
            </>
          ) : field === "conditions" ? (
            <Button
              type="button"
              size="sm"
              className="min-h-11 sm:min-h-9"
              disabled={label.trim().length === 0 || createCondition.isPending}
              onClick={() => createCondition.mutate()}
            >
              {createCondition.isPending && (
                <Loader2
                  className="size-4 animate-spin motion-reduce:animate-none"
                  aria-hidden
                />
              )}
              {t("records.life.takeOver.save")}
            </Button>
          ) : (
            <div ref={setFooterEl} className="flex w-full justify-end gap-2" />
          )
        }
      >
        <div className="space-y-4">
          <div className="space-y-1.5">
            <p className="text-sm font-medium">
              {t("records.life.takeOver.freeTextLabel")}
            </p>
            <p className="bg-muted/40 rounded-md p-3 text-sm whitespace-pre-wrap">
              {text}
            </p>
          </div>
          {saved ? (
            <p className="text-sm">
              {t("records.life.takeOver.clearQuestion")}
            </p>
          ) : field === "conditions" ? (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="take-over-condition-label">
                  {t("records.life.takeOver.conditionLabel")}
                </Label>
                <Input
                  id="take-over-condition-label"
                  maxLength={120}
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="take-over-condition-onset">
                  {t("records.life.takeOver.onset")}
                </Label>
                <DateField
                  id="take-over-condition-onset"
                  value={onset}
                  onChange={setOnset}
                />
              </div>
            </>
          ) : (
            <AllergyForm
              footerSlot={footerEl}
              onSuccess={afterCreate}
              onCancel={close}
            />
          )}
        </div>
      </ResponsiveSheet>
    </>
  );
}
