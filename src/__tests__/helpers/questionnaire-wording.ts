/**
 * Seed a test's query cache with every language's questionnaire text, the
 * way the client holds it once the language's chunk has loaded, so a
 * server-rendered surface paints the text instead of its loading state.
 */
import type { QueryClient } from "@tanstack/react-query";

import { locales } from "@/lib/i18n/config";
import { WORDING } from "@/lib/mental-health/wording";
import type { LocaleWording } from "@/lib/mental-health/wording/types";
import { queryKeys } from "@/lib/query-keys";

export function seedQuestionnaireWording(queryClient: QueryClient): void {
  for (const locale of locales) {
    const chunk: LocaleWording = {
      PHQ9: WORDING.PHQ9[locale],
      GAD7: WORDING.GAD7[locale],
      WHO5: WORDING.WHO5[locale],
      SCI: WORDING.SCI[locale],
    };
    queryClient.setQueryData(queryKeys.mentalHealthWording(locale), chunk);
  }
}
