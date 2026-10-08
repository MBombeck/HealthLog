"use client";

/**
 * Rung 1: the catalogue's own knowledge, rendered with its citation.
 *
 * This is information reproduction, never a personal recommendation. The
 * sentences are composed from the seed's `typicalSeriesDoses`,
 * `boosterIntervalMonths` and `category` over a handful of i18n templates —
 * not hand-written per entry — so six locales carry ~6 templates rather than
 * ~35 prose blocks. Every sentence is population-level and impersonal by
 * construction: it states what the cited schedule says, with no "you should"
 * and no conditioning on age, sex or history. That conditioning would be rung
 * 3, and rung 3 is a different venture.
 *
 * The per-entry `source` renders verbatim as the footnote — a citation is a
 * proper noun, like a unit, and is not translated.
 *
 * The person's own vaccine definitions (v1.42, #1005) render through the same
 * templates, with the antigens they listed first and no footnote: their
 * numbers are the person's, not a cited schedule's.
 */
import { useTranslations } from "@/lib/i18n/context";
import {
  resolveVaccineEntry,
  type ResolvedVaccineEntry,
} from "@/lib/vaccinations/resolve-vaccine-entry";

type Translate = ReturnType<typeof useTranslations>["t"];
type TranslateCount = ReturnType<typeof useTranslations>["tCount"];

/** The impersonal sentences that apply to this entry, in reading order. */
function infoSentences(
  entry: ResolvedVaccineEntry | null,
  t: Translate,
  tCount: TranslateCount,
): { lines: string[]; source: string | null } | null {
  if (!entry) return null;

  const lines: string[] = [];

  if (entry.kind === "custom" && entry.components.length > 0) {
    lines.push(
      t("vaccinations.custom.protectsAgainst", {
        list: entry.components
          .map((antigen) => t(`vaccinations.catalog.${antigen}`))
          .join(", "),
      }),
    );
  }

  if (entry.typicalSeriesDoses !== null) {
    lines.push(
      tCount("vaccinations.info.primarySeries", entry.typicalSeriesDoses, {
        count: entry.typicalSeriesDoses,
      }),
    );
  }

  if (entry.boosterIntervalMonths !== null) {
    const months = entry.boosterIntervalMonths;
    if (months === 12) {
      lines.push(t("vaccinations.info.yearly"));
    } else if (months % 12 === 0) {
      const years = months / 12;
      lines.push(
        tCount("vaccinations.info.boosterYears", years, { count: years }),
      );
    } else {
      lines.push(
        tCount("vaccinations.info.boosterMonths", months, { count: months }),
      );
    }
  }

  if (entry.category === "standard60") {
    lines.push(t("vaccinations.info.standard60"));
  }

  if (lines.length === 0) return null;
  return { lines, source: entry.source };
}

/**
 * Whether {@link CatalogInfo} would render anything for this slug — so a
 * caller can decide to mount an info affordance at all, rather than opening an
 * empty popover for an entry the templates say nothing about.
 */
export function catalogInfoAvailable(slug: string | null): boolean {
  const entry = resolveVaccineEntry({ antigenSlug: slug });
  if (!entry) return false;
  return (
    entry.typicalSeriesDoses !== null ||
    entry.boosterIntervalMonths !== null ||
    entry.category === "standard60"
  );
}

export function CatalogInfo({
  slug = null,
  entry,
}: {
  slug?: string | null;
  /** An already resolved entry, e.g. one of the person's own definitions. */
  entry?: ResolvedVaccineEntry | null;
}) {
  const { t, tCount } = useTranslations();
  const info = infoSentences(
    entry ?? resolveVaccineEntry({ antigenSlug: slug }),
    t,
    tCount,
  );
  if (!info) return null;

  return (
    <div className="space-y-1" data-slot="vaccination-catalog-info">
      <ul className="text-foreground space-y-0.5 text-sm">
        {info.lines.map((line, index) => (
          <li key={index}>{line}</li>
        ))}
      </ul>
      {info.source ? (
        <p className="text-muted-foreground text-xs">
          {t("vaccinations.info.sourceLabel", { source: info.source })}
        </p>
      ) : null}
    </div>
  );
}
