/**
 * Where `/insights?metric=<id>` goes (MCP deep links).
 *
 * The MCP `search` and `fetch` results link a metric as
 * `/insights?metric=<id>`, with the id in whichever spelling that result
 * carries: a Coach source key (`hrv`, `resting_hr`, `bp`), a signal or
 * metric-status key (`GRIP_STRENGTH`, `CARDIO_RECOVERY`), or a sub-page slug.
 * The overview read none of them, so every such link landed on the overview.
 * This resolves the id to the metric's own page, or to its value list when no
 * page focuses it, and to nothing for an id it cannot place (the overview
 * then renders as before). Pure: no I/O.
 */
import { COACH_SOURCE_MEASUREMENT_TYPES } from "@/lib/ai/coach/source-measurement-types";
import type { CoachScopeSource } from "@/lib/ai/coach/types";
import {
  SUB_PAGE_SLUGS,
  subPageSlugForType,
  type SubPageSlug,
} from "@/lib/insights/sub-page-metric";
import { SIGNALS } from "@/lib/signals/registry";
import { measurementTypeEnum } from "@/lib/validations/measurement";

/** Coach sources that read a model other than `Measurement`. */
const NON_MEASUREMENT_SOURCES: Readonly<Record<string, string>> = {
  mood: "/insights/mood",
  workouts: "/insights/workouts",
  compliance: "/insights/medications",
};

const SLUGS: ReadonlySet<string> = new Set(SUB_PAGE_SLUGS);

function hrefForType(type: string): string {
  const slug = subPageSlugForType(type);
  return slug
    ? `/insights/${slug}`
    : `/insights/values/${encodeURIComponent(type)}`;
}

export function insightsHrefForMetric(
  raw: string | null | undefined,
): string | null {
  const id = raw?.trim() ?? "";
  if (id === "" || id.length > 64 || !/^[A-Za-z0-9_-]+$/.test(id)) {
    return null;
  }
  const lower = id.toLowerCase();

  // A sub-page slug, in either separator.
  const slug = lower.replace(/_/g, "-");
  if (SLUGS.has(slug)) return `/insights/${slug as SubPageSlug}`;

  // A Coach source key, the spelling the data inventory links carry.
  if (lower in NON_MEASUREMENT_SOURCES) return NON_MEASUREMENT_SOURCES[lower]!;
  const sourceTypes =
    COACH_SOURCE_MEASUREMENT_TYPES[lower as CoachScopeSource] ?? [];
  if (sourceTypes.length > 0) return hrefForType(sourceTypes[0]!);

  // A signal key, then a measurement type itself.
  const upper = id.toUpperCase();
  const signal = SIGNALS[upper];
  if (signal && (signal.kind === "measurement" || signal.kind === "score")) {
    return hrefForType(signal.source.measurementType);
  }
  if (measurementTypeEnum.safeParse(upper).success) return hrefForType(upper);
  return null;
}
