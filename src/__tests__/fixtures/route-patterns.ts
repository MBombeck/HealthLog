/**
 * Every route of the app with its pattern, and why a budget file does not
 * measure it.
 *
 * The coverage map of the page patterns as data, so that no route
 * falls out of it unnoticed: `route-pattern-registry.test.ts` derives the
 * route list from every `src/app/**\/page.tsx` on disk (route groups
 * stripped, dynamic segments kept), expands `/settings/[section]` and
 * `/admin/[section]` into their sections, and fails on a route without an
 * entry, an entry without a route, an unknown pattern, and a route that
 * `e2e/text-budgets.json` or `e2e/mobile-height-budgets.json` neither
 * measures nor gives a reason for.
 *
 * - `pattern`: A list, B detail, C settings, D form, E import or export
 *   source, F ask, G onboarding step, H overview, I metric page, P prose
 *   and public, or `redirect` for a page that only sends the reader on. A
 *   page that combines two (the start page is H + F) names the frame.
 * - `textBudget` / `heightBudget`: why the route has no number in that
 *   budget file. A route the file measures carries nothing here, so the
 *   file stays the one place a budget is set.
 *
 * A concrete instance of a dynamic route (`/settings/layout/dashboard`) may
 * have its own entry when a budget file measures that instance.
 */

export const PATTERNS = [
  "A",
  "B",
  "C",
  "D",
  "E",
  "F",
  "G",
  "H",
  "I",
  "P",
  "redirect",
] as const;

export type RoutePattern = (typeof PATTERNS)[number];

export interface RouteEntry {
  pattern: RoutePattern;
  /** Why `e2e/text-budgets.json` does not count the route's words. */
  textBudget?: string;
  /** Why `e2e/mobile-height-budgets.json` does not measure the route. */
  heightBudget?: string;
}

const REDIRECT = "redirect: renders nothing of its own";
const INSIGHTS_WORDS =
  "Insights: the words are the record's data and model text (the budget counts a page's own copy)";
const TEXT_NOT_MEASURED = "not in text-budgets.json yet";
const HEIGHT_NOT_MEASURED = "not on the height spec's route list";
const DYNAMIC = "dynamic route: the height spec measures no instance of it";

export const ROUTE_PATTERNS: Record<string, RouteEntry> = {
  "/": {
    pattern: "H",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/about": {
    pattern: "P",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/achievements": {
    pattern: "A",
  },
  "/admin": {
    pattern: "C",
    textBudget: TEXT_NOT_MEASURED,
  },
  "/admin/about": {
    pattern: "C",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/admin/api-tokens": {
    pattern: "C",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/admin/app-logs": {
    pattern: "C",
    textBudget: TEXT_NOT_MEASURED,
  },
  "/admin/backups": {
    pattern: "C",
  },
  "/admin/coach": {
    pattern: "C",
    textBudget: TEXT_NOT_MEASURED,
  },
  "/admin/danger-zone": {
    pattern: "C",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/admin/encryption": {
    pattern: "C",
    textBudget: TEXT_NOT_MEASURED,
  },
  "/admin/general": {
    pattern: "C",
    textBudget: TEXT_NOT_MEASURED,
  },
  "/admin/integrations": {
    pattern: "C",
    textBudget: TEXT_NOT_MEASURED,
  },
  "/admin/invites": {
    pattern: "C",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/admin/login-overview": {
    pattern: "C",
    textBudget: TEXT_NOT_MEASURED,
  },
  "/admin/module-availability": {
    pattern: "C",
    textBudget: TEXT_NOT_MEASURED,
  },
  "/admin/reminders": {
    pattern: "C",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/admin/services": {
    pattern: "C",
    textBudget: TEXT_NOT_MEASURED,
  },
  "/admin/setup": {
    pattern: "C",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/admin/system-status": {
    pattern: "C",
    textBudget: TEXT_NOT_MEASURED,
  },
  "/admin/users": {
    pattern: "C",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/auth/claim": {
    pattern: "P",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/auth/login": {
    pattern: "P",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/auth/native-return": {
    pattern: "P",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/auth/register": {
    pattern: "P",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/c/[token]/view": {
    pattern: "P",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: DYNAMIC,
  },
  "/care": {
    pattern: "A",
    textBudget: TEXT_NOT_MEASURED,
  },
  "/care/practitioners": {
    pattern: "A",
    textBudget: TEXT_NOT_MEASURED,
  },
  "/claim/[token]": {
    pattern: "redirect",
    textBudget: REDIRECT,
    heightBudget: REDIRECT,
  },
  "/coach": {
    pattern: "A",
    textBudget: TEXT_NOT_MEASURED,
  },
  "/coach/conversations": {
    pattern: "A",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/coach/plans": {
    pattern: "A",
    textBudget: TEXT_NOT_MEASURED,
  },
  "/confirm-access": {
    pattern: "P",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/custom-metrics/[id]": {
    pattern: "B",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: DYNAMIC,
  },
  "/custom-metrics/[id]/values": {
    pattern: "A",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: DYNAMIC,
  },
  "/cycle": {
    pattern: "B",
    textBudget: TEXT_NOT_MEASURED,
  },
  "/documents": {
    pattern: "A",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/documents/deleted": {
    pattern: "A",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/emergency-card": {
    pattern: "A",
    textBudget: TEXT_NOT_MEASURED,
  },
  "/enroll-mfa": {
    pattern: "G",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/illness": {
    pattern: "A",
    textBudget: TEXT_NOT_MEASURED,
  },
  "/illness/[id]": {
    pattern: "B",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: DYNAMIC,
  },
  "/insights": {
    pattern: "H",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/active-energy": {
    pattern: "I",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/audio-events": {
    pattern: "I",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/blood-glucose": {
    pattern: "I",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/blood-pressure": {
    pattern: "I",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/bmi": {
    pattern: "I",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/body-fat": {
    pattern: "I",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/body-temperature": {
    pattern: "I",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/body-water": {
    pattern: "I",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/bone-mass": {
    pattern: "I",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/breathing-disturbances": {
    pattern: "I",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/cardio-fitness": {
    pattern: "I",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/cardio-recovery": {
    pattern: "I",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/catalog": {
    pattern: "A",
    textBudget: INSIGHTS_WORDS,
  },
  "/insights/daylight": {
    pattern: "I",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/double-support-time": {
    pattern: "I",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/ecg": {
    pattern: "A",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/ecg/[id]": {
    pattern: "B",
    textBudget: INSIGHTS_WORDS,
    heightBudget: DYNAMIC,
  },
  "/insights/environmental-audio": {
    pattern: "I",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/falls": {
    pattern: "I",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/fat-free-mass": {
    pattern: "I",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/fat-mass": {
    pattern: "I",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/flights-climbed": {
    pattern: "I",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/grip-strength": {
    pattern: "I",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/headphone-audio": {
    pattern: "I",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/health-score": {
    pattern: "redirect",
    textBudget: REDIRECT,
    heightBudget: REDIRECT,
  },
  "/insights/hrv": {
    pattern: "I",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/ketones": {
    pattern: "I",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/lean-body-mass": {
    pattern: "I",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/medications": {
    pattern: "I",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/mood": {
    pattern: "I",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/muscle-mass": {
    pattern: "I",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/nutrients": {
    pattern: "I",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/oxygen": {
    pattern: "I",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/pain": {
    pattern: "I",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/pulse": {
    pattern: "I",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/pulse-wave-velocity": {
    pattern: "I",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/recovery": {
    pattern: "I",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/respiratory-rate": {
    pattern: "I",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/resting-pulse": {
    pattern: "I",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/scores/[metric]": {
    pattern: "B",
    textBudget: INSIGHTS_WORDS,
    heightBudget: DYNAMIC,
  },
  "/insights/six-minute-walk": {
    pattern: "I",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/skin-temperature": {
    pattern: "I",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/sleep": {
    pattern: "I",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/sources": {
    pattern: "C",
    textBudget: INSIGHTS_WORDS,
  },
  "/insights/stair-ascent-speed": {
    pattern: "I",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/stair-descent-speed": {
    pattern: "I",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/step-length": {
    pattern: "I",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/steps": {
    pattern: "I",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/values/[type]": {
    pattern: "A",
    textBudget: INSIGHTS_WORDS,
    heightBudget: DYNAMIC,
  },
  "/insights/vascular-age": {
    pattern: "I",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/visceral-fat": {
    pattern: "I",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/waist": {
    pattern: "I",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/waist-to-height": {
    pattern: "I",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/walking-asymmetry": {
    pattern: "I",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/walking-distance": {
    pattern: "I",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/walking-heart-rate": {
    pattern: "I",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/walking-speed": {
    pattern: "I",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/walking-steadiness": {
    pattern: "I",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/weight": {
    pattern: "I",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/workouts": {
    pattern: "A",
    textBudget: INSIGHTS_WORDS,
  },
  "/insights/workouts/[id]": {
    pattern: "B",
    textBudget: INSIGHTS_WORDS,
    heightBudget: DYNAMIC,
  },
  "/insights/wrist-temperature": {
    pattern: "I",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/invite/[token]": {
    pattern: "P",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: DYNAMIC,
  },
  "/labs": {
    pattern: "A",
    textBudget: TEXT_NOT_MEASURED,
  },
  "/labs/[biomarkerId]": {
    pattern: "B",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: DYNAMIC,
  },
  "/labs/[biomarkerId]/values": {
    pattern: "A",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: DYNAMIC,
  },
  "/measurements": {
    pattern: "A",
    textBudget: TEXT_NOT_MEASURED,
  },
  "/medications": {
    pattern: "A",
    textBudget: TEXT_NOT_MEASURED,
  },
  "/medications/[id]": {
    pattern: "B",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: DYNAMIC,
  },
  "/medications/[id]/history": {
    pattern: "B",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: DYNAMIC,
  },
  "/medications/new": {
    pattern: "redirect",
    textBudget: REDIRECT,
    heightBudget: REDIRECT,
  },
  "/mental-wellbeing": {
    pattern: "A",
    textBudget: TEXT_NOT_MEASURED,
  },
  "/mood": {
    pattern: "A",
    textBudget: TEXT_NOT_MEASURED,
  },
  "/notifications": {
    pattern: "A",
  },
  "/onboarding": {
    pattern: "G",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/onboarding/[step]": {
    pattern: "G",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: DYNAMIC,
  },
  "/onboarding/handover": {
    pattern: "G",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/onboarding/server": {
    pattern: "redirect",
    textBudget: REDIRECT,
    heightBudget: REDIRECT,
  },
  "/onboarding/server/[step]": {
    pattern: "G",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: DYNAMIC,
  },
  "/privacy": {
    pattern: "P",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/profile": {
    pattern: "A",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/seizures": {
    pattern: "A",
    textBudget: TEXT_NOT_MEASURED,
  },
  "/settings": {
    pattern: "redirect",
    textBudget: REDIRECT,
    heightBudget: REDIRECT,
  },
  "/settings/about": {
    pattern: "C",
    textBudget: TEXT_NOT_MEASURED,
  },
  "/settings/access": {
    pattern: "C",
  },
  "/settings/account": {
    pattern: "C",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/settings/advanced": {
    pattern: "C",
    textBudget: TEXT_NOT_MEASURED,
  },
  "/settings/ai": {
    pattern: "C",
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/settings/anamnesis": {
    pattern: "C",
    textBudget: TEXT_NOT_MEASURED,
  },
  "/settings/api": {
    pattern: "C",
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/settings/coach": {
    pattern: "C",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/settings/environment": {
    pattern: "C",
    textBudget: TEXT_NOT_MEASURED,
  },
  "/settings/export": {
    pattern: "C",
  },
  "/settings/health-record": {
    pattern: "C",
  },
  "/settings/integrations": {
    pattern: "C",
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/settings/layout": {
    pattern: "C",
    textBudget: TEXT_NOT_MEASURED,
  },
  "/settings/layout/[module]": {
    pattern: "C",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: "measured as its instance /settings/layout/dashboard",
  },
  "/settings/layout/dashboard": {
    pattern: "C",
    textBudget: TEXT_NOT_MEASURED,
  },
  "/settings/mcp": {
    pattern: "C",
    textBudget: TEXT_NOT_MEASURED,
  },
  "/settings/modules": {
    pattern: "C",
    textBudget: TEXT_NOT_MEASURED,
  },
  "/settings/modules/[module]": {
    pattern: "C",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: DYNAMIC,
  },
  "/settings/notifications": {
    pattern: "C",
  },
  "/settings/privacy": {
    pattern: "C",
  },
  "/settings/score": {
    pattern: "C",
    textBudget: TEXT_NOT_MEASURED,
  },
  "/settings/security": {
    pattern: "C",
    textBudget: TEXT_NOT_MEASURED,
  },
  "/settings/sources": {
    pattern: "C",
    textBudget: TEXT_NOT_MEASURED,
  },
  "/settings/thresholds": {
    pattern: "C",
    textBudget: TEXT_NOT_MEASURED,
  },
  "/timeline": {
    pattern: "A",
    textBudget: TEXT_NOT_MEASURED,
  },
  "/vaccinations": {
    pattern: "A",
    textBudget: TEXT_NOT_MEASURED,
  },
};
