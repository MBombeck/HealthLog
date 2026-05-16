/**
 * Server-safe constants for the v1.5 admin split. Mirrors the pattern in
 * `src/components/settings/section-slugs.ts` so server-rendered code paths
 * (`generateStaticParams()`, the page guard, route-existence tests) can
 * import the slug list without dragging the `<AdminShell>` client bundle
 * into the server graph.
 *
 * Order is the in-app navigation order — sidebar nav, mobile strip, and
 * `generateStaticParams()` all consume it directly.
 */

export const ADMIN_SECTION_SLUGS = [
  "system-status",
  "general",
  "services",
  "integrations",
  "ai-quality",
  // v1.4.31 — operator-side assistant feature-flag toggles. Sits
  // between `ai-quality` (provider config) and `coach-feedback`
  // (in-app feedback inbox) per
  // `.planning/research/v15-assistant-optional.md` Part B.
  "assistant",
  "coach-feedback",
  "feedback",
  "reminders",
  "users",
  "api-tokens",
  "login-overview",
  "app-logs",
  "backups",
  "danger-zone",
] as const;

export type AdminSectionSlug = (typeof ADMIN_SECTION_SLUGS)[number];

export function isAdminSectionSlug(value: string): value is AdminSectionSlug {
  return (ADMIN_SECTION_SLUGS as readonly string[]).includes(value);
}
