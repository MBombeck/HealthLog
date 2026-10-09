import { notFound } from "next/navigation";

import {
  SETTINGS_SECTION_SLUGS,
  isSettingsSectionSlug,
} from "@/components/settings/section-slugs";
import { SettingsShell } from "@/components/settings/settings-shell";
import {
  SettingsSectionLoader,
  SettingsSectionPreload,
} from "@/components/settings/settings-section-loader";
import { RecordSettingsSectionGate } from "@/components/settings/record-settings-section-gate";
import { getIntegrationCallbackUrls } from "@/lib/integrations/callback-urls";

/**
 * Dynamic settings section route. Each of the `SETTINGS_SECTION_SLUGS`
 * is pre-rendered at build via
 * `generateStaticParams()` so the URLs are
 * statically known to Next.js, while the `dynamicParams = false` flag below
 * tells the router to 404 (instead of attempting on-demand rendering) for any
 * slug not in the list — which is exactly what `notFound()` would do at
 * request time, just earlier and without rendering.
 */

export const dynamicParams = false;

export function generateStaticParams() {
  return SETTINGS_SECTION_SLUGS.map((section) => ({ section }));
}

interface PageProps {
  // Next.js 16 made route `params` an async Promise. We `await` it before use.
  params: Promise<{ section: string }>;
}

export default async function SettingsSectionPage({ params }: PageProps) {
  const { section } = await params;

  // Defence-in-depth — `dynamicParams = false` already 404s unknown slugs at
  // routing time, but we re-check here so a hand-rolled override of the route
  // config can never silently fall through to a typo'd slug.
  if (!isSettingsSectionSlug(section)) {
    notFound();
  }

  // Each section is its own chunk (see `SettingsSectionLoader`), so the route
  // ships the one it shows rather than all twenty-one. Integrations is the
  // one section that needs a server-resolved value: the OAuth callback URL
  // each provider registers, read from the runtime env here, per request,
  // because a `NEXT_PUBLIC_*` read inside a client module is inlined at build
  // time and the published image is built without it.
  //
  // v1.18.6.1 — the heading + subtitle (and the Layout-hub "← back" link)
  // live in `<SettingsShell>`, which places them in their own grid row
  // spanning only the content column so the left nav's first item lines up
  // with the top of the first card. The page body is pure card content,
  // wrapped in the labelled `<section>` so the historic
  // `settings-section-<slug>-title` `aria-labelledby` linkage still resolves.
  return (
    <SettingsShell active={section}>
      <SettingsSectionPreload section={section} />
      <RecordSettingsSectionGate section={section}>
        <section
          aria-labelledby={`settings-section-${section}-title`}
          className="space-y-6"
        >
          <SettingsSectionLoader
            section={section}
            callbackUrls={
              section === "integrations"
                ? getIntegrationCallbackUrls()
                : undefined
            }
          />
        </section>
      </RecordSettingsSectionGate>
    </SettingsShell>
  );
}
