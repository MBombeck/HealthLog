/**
 * Every route of the app with its pattern, its owner and its two budgets.
 *
 * The coverage map of the 1.50 design system as data, so that no route
 * falls out of it unnoticed: `route-pattern-registry.test.ts` derives the
 * route list from every `src/app/**\/page.tsx` on disk (route groups
 * stripped, dynamic segments kept), expands `/settings/[section]` and
 * `/admin/[section]` into their sections, and fails on a route without an
 * entry, an entry without a route, an unknown pattern or owner, and a
 * budget that disagrees with `e2e/text-budgets.json` or
 * `e2e/mobile-height-budgets.json`.
 *
 * - `pattern`: A list, B detail, C settings, D form, E import or export
 *   source, F ask, G onboarding step, H overview, I metric page, P prose
 *   and public, or `redirect` for a page that only sends the reader on. A
 *   page that combines two (the start page is H + F) names the frame.
 * - `owner`: the package that changes the route for 1.50, `merged` when its
 *   pass is in, `none` when nobody does.
 * - `textBudget` / `heightBudget`: the number in the budget file, or the
 *   reason the route has none there. A number here that differs from the
 *   file fails, so the file stays the one place a budget is changed.
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

export const OWNERS = [
  "P1",
  "P2",
  "P3",
  "P4",
  "P5",
  "MD",
  "ONB",
  "ASK",
  "INT",
  "IO",
  "CAT",
  "TXT",
  "N1",
  "N2",
  "N3",
  "N4",
  "merged",
  "none",
] as const;

export type RoutePattern = (typeof PATTERNS)[number];
export type RouteOwner = (typeof OWNERS)[number];

export interface RouteEntry {
  pattern: RoutePattern;
  owner: RouteOwner;
  /** Words in `<main>`, as in `e2e/text-budgets.json`, or why there is none. */
  textBudget: number | string;
  /** Page height in px, as in `e2e/mobile-height-budgets.json`, or why not. */
  heightBudget: number | string;
}

const REDIRECT = "redirect: renders nothing of its own";
const INSIGHTS_WORDS =
  "Insights: the words are the record's data and model text (G2 counts the page's own copy)";
const TEXT_NOT_MEASURED = "not in text-budgets.json yet (G2 extends it)";
const HEIGHT_NOT_MEASURED = "not on the height spec's route list";
const DYNAMIC = "dynamic route: the height spec measures no instance of it";

export const ROUTE_PATTERNS: Record<string, RouteEntry> = {
  "/": {
    pattern: "H",
    owner: "ASK",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/about": {
    pattern: "P",
    owner: "none",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/achievements": {
    pattern: "A",
    owner: "P3",
    textBudget: 270,
    heightBudget: 6100,
  },
  "/admin": {
    pattern: "C",
    owner: "P5",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: 2900,
  },
  "/admin/about": {
    pattern: "C",
    owner: "none",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/admin/api-tokens": {
    pattern: "C",
    owner: "none",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/admin/app-logs": {
    pattern: "C",
    owner: "P5",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: 2700,
  },
  "/admin/backups": {
    pattern: "C",
    owner: "P5",
    textBudget: 290,
    heightBudget: 2000,
  },
  "/admin/coach": {
    pattern: "C",
    owner: "P5",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: 3700,
  },
  "/admin/danger-zone": {
    pattern: "C",
    owner: "none",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/admin/encryption": {
    pattern: "C",
    owner: "P5",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: 3100,
  },
  "/admin/general": {
    pattern: "C",
    owner: "none",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: 1400,
  },
  "/admin/integrations": {
    pattern: "C",
    owner: "none",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: 1200,
  },
  "/admin/invites": {
    pattern: "C",
    owner: "none",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/admin/login-overview": {
    pattern: "C",
    owner: "P5",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: 3800,
  },
  "/admin/module-availability": {
    pattern: "C",
    owner: "none",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: 2000,
  },
  "/admin/reminders": {
    pattern: "C",
    owner: "none",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/admin/services": {
    pattern: "C",
    owner: "none",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: 1700,
  },
  "/admin/system-status": {
    pattern: "C",
    owner: "P5",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: 3800,
  },
  "/admin/users": {
    pattern: "C",
    owner: "none",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/auth/claim": {
    pattern: "P",
    owner: "none",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/auth/login": {
    pattern: "P",
    owner: "ONB",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/auth/native-return": {
    pattern: "P",
    owner: "none",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/auth/register": {
    pattern: "P",
    owner: "ONB",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/c/[token]/view": {
    pattern: "P",
    owner: "none",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: DYNAMIC,
  },
  "/care": {
    pattern: "A",
    owner: "P2",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: 800,
  },
  "/care/practitioners": {
    pattern: "A",
    owner: "P2",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: 800,
  },
  "/claim/[token]": {
    pattern: "redirect",
    owner: "none",
    textBudget: REDIRECT,
    heightBudget: REDIRECT,
  },
  "/coach": {
    pattern: "A",
    owner: "none",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: 2500,
  },
  "/coach/conversations": {
    pattern: "A",
    owner: "none",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/coach/plans": {
    pattern: "A",
    owner: "none",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: 800,
  },
  "/confirm-access": {
    pattern: "P",
    owner: "none",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/custom-metrics/[id]": {
    pattern: "B",
    owner: "none",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: DYNAMIC,
  },
  "/custom-metrics/[id]/values": {
    pattern: "A",
    owner: "none",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: DYNAMIC,
  },
  "/cycle": {
    pattern: "B",
    owner: "P3",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: 1600,
  },
  "/documents": {
    pattern: "A",
    owner: "merged",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/documents/deleted": {
    pattern: "A",
    owner: "none",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/emergency-card": {
    pattern: "A",
    owner: "P3",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: 2900,
  },
  "/enroll-mfa": {
    pattern: "G",
    owner: "none",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/illness": {
    pattern: "A",
    owner: "P3",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: 800,
  },
  "/illness/[id]": {
    pattern: "B",
    owner: "none",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: DYNAMIC,
  },
  "/insights": {
    pattern: "H",
    owner: "merged",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/active-energy": {
    pattern: "I",
    owner: "none",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/audio-events": {
    pattern: "I",
    owner: "none",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/blood-glucose": {
    pattern: "I",
    owner: "none",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/blood-pressure": {
    pattern: "I",
    owner: "merged",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/bmi": {
    pattern: "I",
    owner: "none",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/body-fat": {
    pattern: "I",
    owner: "none",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/body-temperature": {
    pattern: "I",
    owner: "none",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/body-water": {
    pattern: "I",
    owner: "none",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/bone-mass": {
    pattern: "I",
    owner: "none",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/breathing-disturbances": {
    pattern: "I",
    owner: "none",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/cardio-fitness": {
    pattern: "I",
    owner: "none",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/cardio-recovery": {
    pattern: "I",
    owner: "none",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/catalog": {
    pattern: "A",
    owner: "CAT",
    textBudget: INSIGHTS_WORDS,
    heightBudget: 7800,
  },
  "/insights/daylight": {
    pattern: "I",
    owner: "none",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/double-support-time": {
    pattern: "I",
    owner: "none",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/ecg": {
    pattern: "A",
    owner: "none",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/ecg/[id]": {
    pattern: "B",
    owner: "none",
    textBudget: INSIGHTS_WORDS,
    heightBudget: DYNAMIC,
  },
  "/insights/environmental-audio": {
    pattern: "I",
    owner: "none",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/falls": {
    pattern: "I",
    owner: "none",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/fat-free-mass": {
    pattern: "I",
    owner: "none",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/fat-mass": {
    pattern: "I",
    owner: "none",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/flights-climbed": {
    pattern: "I",
    owner: "none",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/grip-strength": {
    pattern: "I",
    owner: "none",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/headphone-audio": {
    pattern: "I",
    owner: "none",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/health-score": {
    pattern: "redirect",
    owner: "none",
    textBudget: REDIRECT,
    heightBudget: REDIRECT,
  },
  "/insights/hrv": {
    pattern: "I",
    owner: "none",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/ketones": {
    pattern: "I",
    owner: "none",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/lean-body-mass": {
    pattern: "I",
    owner: "none",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/medications": {
    pattern: "I",
    owner: "none",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/mood": {
    pattern: "I",
    owner: "none",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/muscle-mass": {
    pattern: "I",
    owner: "none",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/nutrients": {
    pattern: "I",
    owner: "none",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/oxygen": {
    pattern: "I",
    owner: "none",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/pain": {
    pattern: "I",
    owner: "none",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/pulse": {
    pattern: "I",
    owner: "none",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/pulse-wave-velocity": {
    pattern: "I",
    owner: "none",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/recovery": {
    pattern: "I",
    owner: "none",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/respiratory-rate": {
    pattern: "I",
    owner: "none",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/resting-pulse": {
    pattern: "I",
    owner: "none",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/scores/[metric]": {
    pattern: "B",
    owner: "merged",
    textBudget: INSIGHTS_WORDS,
    heightBudget: DYNAMIC,
  },
  "/insights/six-minute-walk": {
    pattern: "I",
    owner: "none",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/skin-temperature": {
    pattern: "I",
    owner: "none",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/sleep": {
    pattern: "I",
    owner: "none",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/sources": {
    pattern: "C",
    owner: "none",
    textBudget: INSIGHTS_WORDS,
    heightBudget: 900,
  },
  "/insights/stair-ascent-speed": {
    pattern: "I",
    owner: "none",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/stair-descent-speed": {
    pattern: "I",
    owner: "none",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/step-length": {
    pattern: "I",
    owner: "none",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/steps": {
    pattern: "I",
    owner: "none",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/values/[type]": {
    pattern: "A",
    owner: "P1",
    textBudget: INSIGHTS_WORDS,
    heightBudget: DYNAMIC,
  },
  "/insights/vascular-age": {
    pattern: "I",
    owner: "none",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/visceral-fat": {
    pattern: "I",
    owner: "none",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/waist": {
    pattern: "I",
    owner: "none",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/waist-to-height": {
    pattern: "I",
    owner: "none",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/walking-asymmetry": {
    pattern: "I",
    owner: "none",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/walking-distance": {
    pattern: "I",
    owner: "none",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/walking-heart-rate": {
    pattern: "I",
    owner: "none",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/walking-speed": {
    pattern: "I",
    owner: "none",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/walking-steadiness": {
    pattern: "I",
    owner: "none",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/weight": {
    pattern: "I",
    owner: "none",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/insights/workouts": {
    pattern: "A",
    owner: "none",
    textBudget: INSIGHTS_WORDS,
    heightBudget: 1400,
  },
  "/insights/workouts/[id]": {
    pattern: "B",
    owner: "none",
    textBudget: INSIGHTS_WORDS,
    heightBudget: DYNAMIC,
  },
  "/insights/wrist-temperature": {
    pattern: "I",
    owner: "none",
    textBudget: INSIGHTS_WORDS,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/invite/[token]": {
    pattern: "P",
    owner: "none",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: DYNAMIC,
  },
  "/labs": {
    pattern: "A",
    owner: "P2",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: 800,
  },
  "/labs/[biomarkerId]": {
    pattern: "B",
    owner: "P3",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: DYNAMIC,
  },
  "/labs/[biomarkerId]/values": {
    pattern: "A",
    owner: "none",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: DYNAMIC,
  },
  "/measurements": {
    pattern: "A",
    owner: "P2",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: 2400,
  },
  "/medications": {
    pattern: "A",
    owner: "P2",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: 900,
  },
  "/medications/[id]": {
    pattern: "B",
    owner: "MD",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: DYNAMIC,
  },
  "/medications/[id]/history": {
    pattern: "B",
    owner: "MD",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: DYNAMIC,
  },
  "/medications/new": {
    pattern: "redirect",
    owner: "none",
    textBudget: REDIRECT,
    heightBudget: REDIRECT,
  },
  "/mental-wellbeing": {
    pattern: "A",
    owner: "P3",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: 1300,
  },
  "/mood": {
    pattern: "A",
    owner: "P2",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: 900,
  },
  "/notifications": {
    pattern: "A",
    owner: "P3",
    textBudget: 330,
    heightBudget: 2100,
  },
  "/onboarding": {
    pattern: "G",
    owner: "ONB",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/onboarding/[step]": {
    pattern: "G",
    owner: "ONB",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: DYNAMIC,
  },
  "/onboarding/handover": {
    pattern: "G",
    owner: "none",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/onboarding/server": {
    pattern: "redirect",
    owner: "ONB",
    textBudget: REDIRECT,
    heightBudget: REDIRECT,
  },
  "/onboarding/server/[step]": {
    pattern: "G",
    owner: "ONB",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: DYNAMIC,
  },
  "/privacy": {
    pattern: "P",
    owner: "none",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/profile": {
    pattern: "A",
    owner: "none",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/seizures": {
    pattern: "A",
    owner: "none",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: 800,
  },
  "/settings": {
    pattern: "redirect",
    owner: "none",
    textBudget: REDIRECT,
    heightBudget: REDIRECT,
  },
  "/settings/about": {
    pattern: "C",
    owner: "none",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: 900,
  },
  "/settings/access": {
    pattern: "C",
    owner: "P4",
    textBudget: 250,
    heightBudget: 2000,
  },
  "/settings/account": {
    pattern: "C",
    owner: "merged",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/settings/advanced": {
    pattern: "C",
    owner: "none",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: 800,
  },
  "/settings/ai": {
    pattern: "C",
    owner: "TXT",
    textBudget: 380,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/settings/anamnesis": {
    pattern: "C",
    owner: "P4",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: 3900,
  },
  "/settings/api": {
    pattern: "C",
    owner: "INT",
    textBudget: 60,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/settings/coach": {
    pattern: "C",
    owner: "none",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/settings/environment": {
    pattern: "C",
    owner: "none",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: 1900,
  },
  "/settings/export": {
    pattern: "C",
    owner: "IO",
    textBudget: 180,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/settings/health-record": {
    pattern: "C",
    owner: "P4",
    textBudget: 490,
    heightBudget: 6900,
  },
  "/settings/integrations": {
    pattern: "C",
    owner: "INT",
    textBudget: 240,
    heightBudget: HEIGHT_NOT_MEASURED,
  },
  "/settings/layout": {
    pattern: "C",
    owner: "none",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: 800,
  },
  "/settings/layout/[module]": {
    pattern: "C",
    owner: "P4",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: "measured as its instance /settings/layout/dashboard",
  },
  "/settings/layout/dashboard": {
    pattern: "C",
    owner: "P4",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: 4400,
  },
  "/settings/mcp": {
    pattern: "C",
    owner: "P4",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: 1700,
  },
  "/settings/modules": {
    pattern: "C",
    owner: "P4",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: 2300,
  },
  "/settings/modules/[module]": {
    pattern: "C",
    owner: "none",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: DYNAMIC,
  },
  "/settings/notifications": {
    pattern: "C",
    owner: "none",
    textBudget: 220,
    heightBudget: 2700,
  },
  "/settings/privacy": {
    pattern: "C",
    owner: "TXT",
    textBudget: 480,
    heightBudget: 3300,
  },
  "/settings/score": {
    pattern: "C",
    owner: "P4",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: 1700,
  },
  "/settings/security": {
    pattern: "C",
    owner: "P4",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: 1600,
  },
  "/settings/sources": {
    pattern: "C",
    owner: "P4",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: 1900,
  },
  "/settings/thresholds": {
    pattern: "C",
    owner: "P4",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: 2200,
  },
  "/timeline": {
    pattern: "A",
    owner: "none",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: 800,
  },
  "/vaccinations": {
    pattern: "A",
    owner: "P2",
    textBudget: TEXT_NOT_MEASURED,
    heightBudget: 800,
  },
};
