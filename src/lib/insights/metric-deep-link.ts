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
  measurementTypeHref,
  measurementValuesHref,
  metricHref,
} from "@/lib/links/hrefs";
import { SIGNALS } from "@/lib/signals/registry";
import { measurementTypeEnum } from "@/lib/validations/measurement";

export function insightsHrefForMetric(
  raw: string | null | undefined,
): string | null {
  const id = raw?.trim() ?? "";
  if (id === "" || id.length > 64 || !/^[A-Za-z0-9_-]+$/.test(id)) {
    return null;
  }

  // A metric with a page of its own, in any spelling the registry reads.
  const page = metricHref(id);
  if (page) return page;

  // A Coach source key whose metric has no page: its value list.
  const lower = id.toLowerCase();
  const sourceTypes = Object.hasOwn(COACH_SOURCE_MEASUREMENT_TYPES, lower)
    ? COACH_SOURCE_MEASUREMENT_TYPES[lower as CoachScopeSource]
    : [];
  if (sourceTypes.length > 0) return measurementValuesHref(sourceTypes[0]!);

  // A signal key, then a measurement type itself.
  const upper = id.toUpperCase();
  const signal = SIGNALS[upper];
  if (signal && (signal.kind === "measurement" || signal.kind === "score")) {
    return measurementTypeHref(signal.source.measurementType);
  }
  if (measurementTypeEnum.safeParse(upper).success) {
    return measurementTypeHref(upper);
  }
  return null;
}
