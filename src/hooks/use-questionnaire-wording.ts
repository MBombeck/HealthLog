/**
 * The questionnaire text in one language, loaded as its own chunk the first
 * time a questionnaire surface asks for it and kept for the session. Static
 * data: it never goes stale and is never refetched. Undefined while the
 * chunk is on its way.
 */
import { useQuery } from "@tanstack/react-query";

import { wordingLocale } from "@/lib/mental-health/instrument-wording";
import { loadLocaleWording } from "@/lib/mental-health/wording/load";
import type { LocaleWording } from "@/lib/mental-health/wording/types";
import { queryKeys } from "@/lib/query-keys";

export function useQuestionnaireWording(
  locale: string,
): LocaleWording | undefined {
  const resolved = wordingLocale(locale);
  const { data } = useQuery({
    queryKey: queryKeys.mentalHealthWording(resolved),
    queryFn: () => loadLocaleWording(resolved),
    staleTime: Infinity,
    gcTime: Infinity,
  });
  return data;
}
