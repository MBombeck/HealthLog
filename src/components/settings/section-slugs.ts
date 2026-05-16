/**
 * Server-safe constants for the v1.4 settings split. Kept in a separate
 * module from `<SettingsShell>` (a client component) so server-rendered code
 * paths — `generateStaticParams()`, the page guard, future tests — can import
 * the slug list without dragging the whole client bundle into the server
 * graph.
 */

// v1.4.34 IW-D — `sources` slug was retired. The two former sections
// (`/settings/thresholds` and `/settings/sources`) merged into a single
// "Targets & Sources" page under `/settings/thresholds`. The historic
// `/settings/sources` URL stays alive as a `permanentRedirect` (see
// `src/app/settings/sources/page.tsx`) so external bookmarks (iOS,
// docs) follow through unchanged. Per
// `.planning/research/v1434-r-2-carryover-scope.md` §7 and
// `.planning/round-v1433-audit-menu.md` §7.1 (item 3).
export const SETTINGS_SECTION_SLUGS = [
  "account",
  "integrations",
  "notifications",
  "dashboard",
  "thresholds",
  "ai",
  "api",
  "export",
  "advanced",
  "about",
] as const;

export type SettingsSectionSlug = (typeof SETTINGS_SECTION_SLUGS)[number];

export function isSettingsSectionSlug(
  value: string,
): value is SettingsSectionSlug {
  return (SETTINGS_SECTION_SLUGS as readonly string[]).includes(value);
}
