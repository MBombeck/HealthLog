"use client";

/**
 * `<IntegrationsGroupSection>` — composite admin route at `/admin/integrations`.
 *
 * Wraps the monitoring sub-sections (Umami, GlitchTip) under one route so each
 * existing component stays the source of truth for its own settings while
 * admins still get a single landing page. The Web Push keys moved to Push and
 * channels (`/admin/services`), beside the switch they serve.
 *
 * No wrapper element: `SectionFrame` already stacks its children at
 * `space-y-6`, so a second identical stack here was one nesting level with
 * no effect.
 */

import { GlitchtipSection } from "./glitchtip-section";
import { UmamiSection } from "./umami-section";

export function IntegrationsGroupSection() {
  return (
    <>
      <UmamiSection />
      <GlitchtipSection />
    </>
  );
}
