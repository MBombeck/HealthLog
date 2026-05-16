"use client";

import { SourcesSection } from "@/components/settings/sources-section";
import { ThresholdsEditorSection } from "@/components/settings/thresholds-editor-section";
import { useTranslations } from "@/lib/i18n/context";

/**
 * `<ThresholdsSection>` — route-level wrapper for `/settings/thresholds`.
 *
 * v1.4.34 IW-D — section was renamed "Zielwerte & Quellen" / "Targets &
 * Sources" and absorbs the former `/settings/sources` content. The two
 * editors stay distinct mutation flows (`/api/user/thresholds` for
 * ranges + `/api/auth/me/source-priority` for source ladders) so a save
 * on one half never disturbs the other; presenting them on a single
 * page collapses two adjacent sidebar slots into one and matches the
 * Settings nav audit (§7.1 item 3 in
 * `.planning/round-v1433-audit-menu.md` — both screens were per-metric
 * configuration shelves and reading them together matches how a user
 * actually thinks about a metric: "for this metric, which sources do
 * I trust AND what range counts as healthy?").
 *
 * `/settings/sources` stays alive as a `permanentRedirect` (see
 * `src/app/settings/sources/page.tsx`) so external bookmarks (iOS
 * Settings deep-links, docs) keep resolving.
 *
 * Visual structure on this page:
 *   1. Section header (combined title + description).
 *   2. `<ThresholdsEditorSection>` — per-metric range inputs (top).
 *      The editor card kept its own affordance row (icon, reset-all
 *      button) so the action surface stays compact.
 *   3. `<SourcesSection>` body — per-metric source priority + the
 *      two-axis device-type expander (bottom). The inner section's
 *      header was suppressed in `mode="embedded"` because the page
 *      header above already names the surface.
 *
 * v1.4.16 phase B6: file renamed from the historic
 * `thresholds-settings-section.tsx` (`<ThresholdsSettingsSection>`)
 * so the filename + default export match the slug — every other
 * section in `src/components/settings/` follows the
 * `<slug>-section.tsx` `<SlugSection>` convention. The inner editor
 * card was simultaneously moved out of `thresholds-section.tsx`
 * (where it used to live as `<ThresholdsSection>`) into
 * `thresholds-editor-section.tsx` (`<ThresholdsEditorSection>`) so
 * the names stop clashing.
 */
export function ThresholdsSection() {
  const { t } = useTranslations();

  return (
    <section
      aria-labelledby="settings-section-thresholds-title"
      className="space-y-6"
    >
      <header className="space-y-1">
        <h1
          id="settings-section-thresholds-title"
          className="text-2xl font-semibold tracking-tight"
        >
          {t("settings.sections.thresholds.title")}
        </h1>
        <p className="text-muted-foreground text-sm">
          {t("settings.sections.thresholds.description")}
        </p>
      </header>

      {/* Per-metric threshold ranges — top card. */}
      <ThresholdsEditorSection id="thresholds" />

      {/* Per-metric source priority + two-axis device-type ladder —
          bottom card. `mode="embedded"` suppresses the inner h1 +
          subtitle (the page header above owns the surface name) and
          drops the inner `<section>` aria-label so the assistive-tech
          reading order stays one combined surface, not two. */}
      <SourcesSection mode="embedded" />
    </section>
  );
}
