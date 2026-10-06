/**
 * A link to `/coach` while the Coach is unavailable (no provider, no
 * consent) only bounces: the Coach page sends the visitor back to Insights.
 * Settings → Coach's sources pointer and the About-me questions tile offer
 * the link only while the Coach can actually open.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

const coachState = vi.hoisted(() => ({ available: true }));
vi.mock("@/hooks/use-ai-capability", () => ({
  useAiCapability: () => ({
    available: coachState.available,
    reason: coachState.available ? null : "no_provider",
    onDeviceAllowed: false,
  }),
  // v1.41 — the thinking depth reads the resolved block; none here.
  useCoachReasoning: () => null,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/settings/coach",
}));

import { I18nProvider } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { DEFAULT_COACH_PREFS } from "@/lib/validations/coach-prefs";
import { CoachPrefsSection } from "../coach-prefs-section";
import { AboutMeNoteManager } from "@/components/records/about-me-note-manager";

function render(node: React.ReactNode): string {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: 0, staleTime: Infinity } },
  });
  client.setQueryData(queryKeys.coachPrefs(), DEFAULT_COACH_PREFS);
  client.setQueryData(queryKeys.coachAboutMe(), {
    aboutMe: null,
    conditions: null,
    allergies: null,
    coachFocus: null,
    pendingQuestions: ["How do you sleep?"],
    updatedAt: "2026-09-01T00:00:00.000Z",
    maxChars: 4000,
    fieldMaxChars: 500,
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale="en">{node}</I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  coachState.available = true;
});

describe("Coach links follow the Coach's capability", () => {
  it("the sources pointer opens the Coach's settings on what it can see", () => {
    expect(render(<CoachPrefsSection isAuthenticated />)).toContain(
      'href="/coach?settings=data"',
    );
  });

  it("the sources pointer offers no dead link without the Coach", () => {
    coachState.available = false;
    const html = render(<CoachPrefsSection isAuthenticated />);
    expect(html).not.toContain('href="/coach?settings=data"');
    expect(html).not.toContain("coach-prefs-sources-pointer");
  });

  it("the About-me questions link to the Coach while it is available", () => {
    expect(render(<AboutMeNoteManager />)).toContain('href="/coach"');
  });

  it("the About-me questions stay readable but lose the link without the Coach", () => {
    coachState.available = false;
    const html = render(<AboutMeNoteManager />);
    expect(html).toContain("How do you sleep?");
    expect(html).not.toContain('href="/coach"');
  });
});
