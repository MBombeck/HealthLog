/**
 * Accept-and-ignore widget ids OUTSIDE the catalogue on write.
 *
 * Every catalogue id (web and iOS-only) validates and persists; only a
 * genuinely-unknown id (a retired tile, or a typo) is filtered out here
 * BEFORE Zod so it can't 422 the whole blob. The strict enum still validates
 * the surviving ids, so a malformed entry (non-string id, missing `order`)
 * still 422s. An id outside the catalogue silently vanishes — acceptable,
 * and greppable via the annotation.
 */
import { DASHBOARD_WIDGET_CATALOGUE_IDS } from "@/lib/dashboard-layout";
import { annotate } from "@/lib/logging/context";

/** Drops unknown ids from `body.widgets` in place, and says so on the event. */
export function dropUnknownWidgetIds(body: unknown): void {
  const knownWidgetIds = new Set<string>(DASHBOARD_WIDGET_CATALOGUE_IDS);
  if (
    body &&
    typeof body === "object" &&
    Array.isArray((body as { widgets?: unknown }).widgets)
  ) {
    const widgetsBody = body as {
      widgets: Array<{ id?: unknown }>;
    };
    const droppedIds = widgetsBody.widgets
      .map((w) => w?.id)
      .filter(
        (id): id is string => typeof id === "string" && !knownWidgetIds.has(id),
      );
    if (droppedIds.length > 0) {
      widgetsBody.widgets = widgetsBody.widgets.filter(
        (w) => !(typeof w?.id === "string" && !knownWidgetIds.has(w.id)),
      );
      // The unknown-id filter runs over the FULL incoming `widgets` array
      // BEFORE Zod's `.max()` applies, so `droppedIds` is bounded only by
      // the request body limit. Cap the logged array (keep the full
      // `dropped_count`) so a single large request can't push thousands of
      // strings into one wide-event line.
      annotate({
        action: { name: "dashboard.widgets.unknown-id-dropped" },
        meta: {
          dropped_ids: droppedIds.slice(0, 20),
          dropped_count: droppedIds.length,
        },
      });
    }
  }
}
