"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { apiGet, apiPost } from "@/lib/api/api-fetch";
import { CONFIRMS_INLINE } from "@/lib/api/mutation-feedback";
import { showErrorToast } from "@/lib/errors/error-toast";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";

interface TravelSuggestion {
  id: string;
  startDate: string;
  endDate: string;
  countryCode: string;
}

function countryName(code: string, locale: string): string {
  try {
    return new Intl.DisplayNames([locale], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}

/**
 * Trips suggested from Dawarich travel days. "Use" fills the trip form below
 * with the dates and the country, and the person picks the place; the saved
 * trip then covers the run and the suggestion goes. "Dismiss" hides it for
 * good. Renders nothing while there is nothing to suggest, which includes
 * every account without a Dawarich connection.
 */
export function TravelSuggestions({
  enabled,
  onUse,
}: {
  enabled: boolean;
  onUse: (suggestion: {
    startDate: string;
    endDate: string;
    place: string;
  }) => void;
}) {
  const { t, locale } = useTranslations();
  const fmt = useFormatters();
  const queryClient = useQueryClient();
  const suggestions = useQuery({
    queryKey: queryKeys.environmentTravelSuggestions(),
    enabled,
    queryFn: () =>
      apiGet<{ suggestions: TravelSuggestion[] }>(
        "/api/environment/travel/suggestions",
      ),
  });
  const dismiss = useMutation({
    // Confirms in place: the dismissed suggestion leaves the list.
    meta: CONFIRMS_INLINE,
    mutationFn: (id: string) =>
      apiPost(
        `/api/environment/travel/suggestions/${encodeURIComponent(id)}/dismiss`,
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: queryKeys.environmentTravelSuggestions(),
      }),
    onError: (failure) =>
      showErrorToast(t("settings.sections.environment.saveError"), {
        cause: failure,
      }),
  });

  const list = suggestions.data?.suggestions ?? [];
  if (list.length === 0) return null;

  return (
    <div className="space-y-2" data-slot="travel-suggestions">
      <p className="text-sm">
        {t("settings.sections.environment.travel.suggestionsIntro")}
      </p>
      <ul className="divide-border divide-y rounded-md border">
        {list.map((s) => {
          const place = countryName(s.countryCode, locale);
          return (
            <li
              key={s.id}
              data-slot="travel-suggestion"
              className="flex items-center justify-between gap-2 p-2"
            >
              <span className="min-w-0">
                <span className="block truncate text-sm">{place}</span>
                <span className="text-muted-foreground block text-xs">
                  {t("settings.sections.environment.travel.range", {
                    start: fmt.dateShortSmartCalendar(s.startDate),
                    end: fmt.dateShortSmartCalendar(s.endDate),
                  })}
                </span>
              </span>
              <span className="flex shrink-0 gap-1">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="min-h-11 sm:min-h-9"
                  onClick={() =>
                    onUse({ startDate: s.startDate, endDate: s.endDate, place })
                  }
                >
                  <Check className="size-3.5" aria-hidden="true" />
                  {t("settings.sections.environment.travel.suggestionUse")}
                </Button>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="min-h-11 min-w-11 sm:min-h-9 sm:min-w-9"
                  aria-label={t(
                    "settings.sections.environment.travel.suggestionDismiss",
                  )}
                  disabled={dismiss.isPending}
                  onClick={() => dismiss.mutate(s.id)}
                >
                  <X className="size-4" aria-hidden="true" />
                </Button>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
