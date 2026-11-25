"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toastWrittenOutcome } from "@/components/outcome/outcome-toast";
import { Syringe } from "lucide-react";

import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { Checkbox } from "@/components/ui/checkbox";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import {
  INJECTION_SITE_KEYS,
  describeInjectionSite,
  type InjectionSiteKey,
} from "@/lib/medications/injection-sites";
import { apiPatch } from "@/lib/api/api-fetch";
import {
  fetchGlobalExcludedInjectionSites,
  injectionSitePrefsQuery,
} from "@/lib/medications/use-injection-site-prefs";
import { showErrorToast } from "@/lib/errors/error-toast";

/**
 * v1.8.5 — Settings → global injection-site exclusion.
 *
 * A per-user deny-list. Sites checked here are never offered for any
 * medication's injection-site picker and are rejected (422) at intake —
 * even when a medication lists them as preferred (deny always wins).
 * Reads + PATCHes `GET/PATCH /api/auth/me/injection-site-prefs`; the
 * mutation invalidates `injectionSitePrefs()` so every picker re-reads.
 */
export function InjectionSitesCard({
  isAuthenticated,
}: {
  isAuthenticated: boolean;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();

  const { data } = useQuery({
    ...injectionSitePrefsQuery,
    enabled: isAuthenticated,
  });
  const excluded: InjectionSiteKey[] = data ?? [];

  // A toggle is applied to the list as stored now, not to this tab's copy:
  // the PATCH replaces the whole list, and the cached copy can be minutes or
  // hours old (another device, another tab). Toggles run one at a time
  // (`scope`), so a quick second click builds on the first.
  const mutation = useMutation({
    scope: { id: "injection-site-prefs" },
    mutationFn: async (change: {
      site: InjectionSiteKey;
      checked: boolean;
    }) => {
      const set = new Set(await fetchGlobalExcludedInjectionSites());
      if (change.checked) set.add(change.site);
      else set.delete(change.site);
      const next = INJECTION_SITE_KEYS.filter((s) => set.has(s));
      await apiPatch("/api/auth/me/injection-site-prefs", {
        globalExcludedInjectionSites: next,
      });
      return next;
    },
    onSuccess: (next) => {
      queryClient.setQueryData(queryKeys.injectionSitePrefs(), next);
      void queryClient.invalidateQueries({
        queryKey: queryKeys.injectionSitePrefs(),
      });
      toastWrittenOutcome("success", t("settings.saved"));
    },
    onError: (failure) =>
      showErrorToast(t("settings.savingError"), { cause: failure }),
  });

  function toggle(site: InjectionSiteKey, checked: boolean) {
    mutation.mutate({ site, checked });
  }

  return (
    <SettingsCard>
      <SettingsCardHeader
        anchor="injection-sites"
        icon={Syringe}
        title={t("settings.globalExcludedInjectionSitesLabel")}
        description={t("settings.globalExcludedInjectionSitesHint")}
      />
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {INJECTION_SITE_KEYS.map((site) => (
          <label key={site} className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={excluded.includes(site)}
              // Nothing to toggle until the stored list is known: a failed
              // read is not "no exclusions".
              disabled={data === undefined || mutation.isPending}
              onCheckedChange={(c) => toggle(site, c === true)}
            />
            {t(describeInjectionSite(site))}
          </label>
        ))}
      </div>
    </SettingsCard>
  );
}
