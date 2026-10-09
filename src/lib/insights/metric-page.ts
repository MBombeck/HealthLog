/**
 * The page a value's name leads to: one answer for every surface that lists
 * values by kind (the day view's value tiles, the timeline's value lines).
 *
 * A measurement type goes to the insights sub-page that focuses it
 * (`subPageSlugForType`); the day view's blood-pressure tile, keyed
 * `BLOOD_PRESSURE`, goes to the blood-pressure page; the mood score goes to
 * the mood page. A kind without a page of its own has no link (`null`), and
 * its name stays plain text: a link to a filtered list would be a different
 * promise than "this value's page".
 *
 * Pure and client-safe.
 */
import { subPageSlugForType } from "@/lib/insights/sub-page-metric";

/** The mood score's key on the timeline (`MOOD_SERIES_KEY` on the server). */
const MOOD_KEY = "MOOD";

export function metricPageHref(key: string): string | null {
  if (key === MOOD_KEY) return "/insights/mood";
  if (key === "BLOOD_PRESSURE") return "/insights/blood-pressure";
  const slug = subPageSlugForType(key);
  return slug ? `/insights/${slug}` : null;
}
