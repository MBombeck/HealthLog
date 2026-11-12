"use client";

/**
 * Settings → AI section wrapper.
 *
 * v1.16.4 — the former 2k-LOC monolith is split into per-provider
 * subcomponents under `src/components/settings/ai/` (one file per
 * provider form, plus the chain / runtime cards). This file only owns
 * the section frame and the card order; behaviour lives in the parts.
 *
 * v1.18.0 — the Coach preference cards (disable toggle, preferences,
 * memory) moved out to the dedicated Coach section. The AI section keeps
 * only provider / model / BYOK configuration.
 *
 * v1.18.1 — the "About me" context moved to Settings → Account (under
 * Profil, before Zyklus-Tracking). It is personal medical context the daily
 * briefing reads too, so it belongs with the account profile rather than the
 * provider-configuration screen.
 */

import { AiConsentRequest } from "@/components/ai/ai-consent-request";
import { AiInsightsCard } from "@/components/settings/ai/ai-insights-card";
import { OperatorOffNotice } from "@/components/settings/ai/operator-off-notice";
import { StoredCoachMemory } from "@/components/settings/coach-memory-section";
import { AiSetupHint } from "@/components/insights/ai-setup-hint";
import { useAuth } from "@/hooks/use-auth";
import { useMounted } from "@/hooks/use-mounted";
import { isSurfaceVisible } from "@/lib/modules/surface";

export function AiSection() {
  const { isAuthenticated, user } = useAuth();
  // v1.16.6 — the auth query can resolve before this boundary
  // hydrates; every `disabled={!isAuthenticated}` binding in the child
  // cards would then disagree with the SSR HTML (React #418). Gate the
  // prop on `useMounted()` so the hydration render matches the
  // server-rendered "not yet authenticated" state and the cards enable
  // on the first client re-render.
  const mounted = useMounted();
  const authed = mounted && isAuthenticated;

  // v1.18.6 — the visible heading + subtitle now come from the shared
  // `<SettingsSectionFrame>` in the route; this body is the single provider
  // card. (The "About me" context moved to Settings → Account in v1.18.1 D8.)
  //
  // v1.39 — above the provider card: what the operator has switched off (so
  // nothing below reads as broken), and the one calm setup hint while no
  // provider is configured, or the consent question while the operator's
  // provider waits on it. Below it: what the Coach stored, while Settings →
  // Coach is not reachable, so it can always be read and deleted.
  const coachSettingsReachable = isSurfaceVisible(
    "settings:coach",
    user?.modules,
  );
  return (
    <div className="space-y-6">
      <OperatorOffNotice />
      <AiSetupHint surface="settings" />
      {/* v1.43.2 — the consent question, above the provider card, while the
          operator's provider is closed by nothing but the missing consent. */}
      <AiConsentRequest surface="settings" />
      <AiInsightsCard isAuthenticated={authed} />
      {authed && !coachSettingsReachable ? (
        <StoredCoachMemory isAuthenticated={authed} />
      ) : null}
    </div>
  );
}
