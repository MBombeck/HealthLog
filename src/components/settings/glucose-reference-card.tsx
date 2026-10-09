"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Droplet, Info } from "lucide-react";

import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { apiGet, apiPatch } from "@/lib/api/api-fetch";

/**
 * Glucose reference band — the web control for the declared diabetes opt-in
 * (`GET/PATCH /api/auth/me/diabetes`).
 *
 * WHY IT LIVES ON TARGETS
 * -----------------------
 * The flag answers exactly the question this page answers — "which range is my
 * reading judged against" — and the page already owns the four glucose target
 * rows. Putting it anywhere else would split one concept across two surfaces.
 * The card sits ABOVE the per-metric editor because the two controls are
 * ordered: this one picks the default band, a per-metric override below then
 * beats it (`src/lib/targets/glucose-targets.ts`).
 *
 * WHAT IT DOES NOT DO
 * -------------------
 * The flag is a display preference, never a diagnosis, and is never inferred
 * from a reading. It selects the band the glucose surfaces and the Coach's
 * reference grounding read; the app takes no clinical action on it. The copy
 * says so at the point of the switch rather than in a help page.
 *
 * Note: `GET /api/user/thresholds` (the editor below) reports the general
 * bands regardless of this flag — the flag resolves in the targets pipeline
 * (`src/lib/targets/build-response.ts`), which is why the mutation invalidates
 * `insightsTargets()` rather than `userThresholds()`.
 */

interface DiabetesPrefShape {
  hasDiabetes: boolean;
}

export function GlucoseReferenceCard() {
  const { t } = useTranslations();
  const queryClient = useQueryClient();

  const { data } = useQuery({
    queryKey: queryKeys.diabetesPref(),
    queryFn: async () => apiGet<DiabetesPrefShape>("/api/auth/me/diabetes"),
  });

  const toggle = useMutation({
    mutationFn: async (hasDiabetes: boolean) =>
      apiPatch<DiabetesPrefShape>("/api/auth/me/diabetes", { hasDiabetes }),
    onSuccess: (next) => {
      queryClient.setQueryData(queryKeys.diabetesPref(), next);
      void queryClient.invalidateQueries({
        queryKey: queryKeys.insightsTargets(),
      });
    },
  });

  const enabled = data?.hasDiabetes ?? false;

  return (
    <SettingsCard>
      <SettingsCardHeader
        anchor="glucose-reference"
        icon={Droplet}
        title={t("settings.glucoseReference.title")}
        description={t("settings.glucoseReference.description")}
      />
      <div className="space-y-4">
        <div className="flex items-start justify-between gap-4">
          <Label htmlFor="glucose-reference-diabetes" className="text-sm">
            {t("settings.glucoseReference.enable")}
          </Label>
          <Switch
            id="glucose-reference-diabetes"
            checked={enabled}
            disabled={toggle.isPending || data == null}
            onCheckedChange={(v) => toggle.mutate(v)}
            className="mt-0.5 shrink-0"
          />
        </div>

        <p className="text-sm">{t("settings.glucoseReference.explainer")}</p>

        <div
          data-slot="glucose-reference-disclaimer"
          className="border-border bg-muted/40 flex items-start gap-2.5 rounded-lg border-l-2 p-3"
        >
          <Info
            className="text-muted-foreground mt-0.5 h-4 w-4 shrink-0"
            aria-hidden="true"
          />
          <p className="text-foreground/80 text-xs leading-relaxed">
            {t("settings.glucoseReference.disclaimer")}
          </p>
        </div>

        {toggle.isError ? (
          <p className="text-destructive text-sm" role="alert">
            {t("settings.glucoseReference.error")}
          </p>
        ) : null}
      </div>
    </SettingsCard>
  );
}
