import Link from "next/link";

import { useTranslations } from "@/lib/i18n/context";
import { pageHref } from "@/lib/links/hrefs";

/**
 * The Health score page's one sentence for a pillar held back for safety
 * signposting, with the way to the support the questionnaire result named.
 *
 * Only wellbeing is ever withheld this way: the server sets that reason on
 * the questionnaire pillar alone. The clinical behaviour (the pillar does
 * not count, the result shows its support card) is the server's and the
 * Mental wellbeing page's; this line only says it plainly. The overview's
 * ring says nothing about it, because a one-line slot would make it read
 * like a fault.
 */
export function HealthScoreWithheldLine({ pillars }: { pillars: string[] }) {
  const { t } = useTranslations();
  return (
    <p
      data-slot="health-score-crisis"
      data-pillars={pillars.join(",")}
      className="text-foreground text-xs"
    >
      {t("insights.healthScore.crisisWithheld")}{" "}
      <Link
        href={pageHref("mentalWellbeing")}
        data-slot="health-score-crisis-link"
        className="text-foreground/80 hover:text-foreground underline underline-offset-2"
      >
        {t("insights.healthScore.crisisSupportLink")}
      </Link>
    </p>
  );
}
