"use client";

/**
 * `<SectionPlaceholder>` — the temporary body of every `/settings/[section]`
 * route until the matching extraction PR lands.
 *
 * The shell + routing surface ship in PR A2-shell so reviewers can validate
 * the URL structure in isolation. The follow-up PRs (A2-account, A2-about,
 * A2-ai, A2-integrations, A2-notifications, A2-rest) replace this placeholder
 * with the real content for each slug, copying from
 * `src/app/settings/page.legacy.tsx`.
 */

import {
  Bell,
  Download,
  Info,
  KeyRound,
  LayoutDashboard,
  Link2,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  User,
  type LucideIcon,
} from "lucide-react";

import { EmptyState } from "@/components/ui/empty-state";
import { useTranslations } from "@/lib/i18n/context";
import type { SettingsSectionSlug } from "./section-slugs";

const SLUG_ICON: Record<SettingsSectionSlug, LucideIcon> = {
  account: User,
  integrations: Link2,
  notifications: Bell,
  dashboard: LayoutDashboard,
  thresholds: SlidersHorizontal,
  ai: Sparkles,
  api: KeyRound,
  export: Download,
  advanced: Settings2,
  about: Info,
};

export interface SectionPlaceholderProps {
  slug: SettingsSectionSlug;
}

export function SectionPlaceholder({ slug }: SectionPlaceholderProps) {
  const { t } = useTranslations();
  const Icon = SLUG_ICON[slug];
  const sectionTitle = t(`settings.sections.${slug}.title`);
  const sectionDescription = t(`settings.sections.${slug}.description`);

  // v1.4.33 A4 — `<SectionPlaceholder>` is a defensive fallback for
  // slugs added to SETTINGS_SECTION_SLUGS without a matching component.
  // The type system blocks that path today, so the EmptyState body is
  // effectively unreachable. We retire the dedicated locale key
  // (`settings.sections.placeholder.coming_soon`) and inherit the
  // section's own description so the guard still renders meaningful
  // copy if it ever does fire — no more dead-string maintenance across
  // six locale files.
  return (
    <section
      aria-labelledby={`settings-section-${slug}-title`}
      className="space-y-6"
    >
      <header className="space-y-1">
        <h1
          id={`settings-section-${slug}-title`}
          className="text-2xl font-semibold tracking-tight"
        >
          {sectionTitle}
        </h1>
        <p className="text-muted-foreground text-sm">{sectionDescription}</p>
      </header>

      <EmptyState
        icon={<Icon className="size-6" />}
        title={sectionTitle}
        description={sectionDescription}
      />
    </section>
  );
}
