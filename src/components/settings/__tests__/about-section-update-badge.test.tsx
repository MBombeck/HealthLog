import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import { AboutSection, UpdateBadge } from "../about-section";

/**
 * v1.4.36 W4f — AboutSection update-badge contract.
 *
 * The dedicated "Updates" card with the manual "Check for updates"
 * button is gone. The 24 h auto-check still runs on mount and
 * surfaces a subtle ArrowUpCircle badge next to the version line
 * ONLY when the check returns `{ status: "newer_available", ... }`.
 *
 * These SSR smoke tests pin the badge presence by seeding the
 * react-query cache with a fake version payload (so the version
 * line paints synchronously) and exercising the path that decides
 * whether the badge mounts. The badge itself owns its own
 * `useState`, so its presence is gated on the runCheck branch —
 * SSR renders the initial `null` state. The actual badge render
 * is therefore covered by the runtime store-set + re-render in
 * future Playwright surfaces; here we pin the *baseline* contract
 * that the version line + Sources/docs panel still render and
 * the legacy manual-check chrome is gone.
 */

function makeClient() {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Number.POSITIVE_INFINITY,
        refetchOnMount: false,
      },
    },
  });
  // Seed the version query so the section paints inline rather than
  // rendering its loader skeleton.
  client.setQueryData(["api", "version"], {
    version: "1.4.36",
    buildSha: "abc1234",
    builtAt: "2026-05-17T08:00:00.000Z",
    license: "AGPL-3.0",
    repository: "https://github.com/MBombeck/HealthLog",
    changelog: "https://github.com/MBombeck/HealthLog/blob/main/CHANGELOG.md",
    docs: "https://github.com/MBombeck/HealthLog/tree/main/docs",
  });
  return client;
}

function render(node: React.ReactNode, locale: "en" | "de" = "en") {
  const client = makeClient();
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>
      <QueryClientProvider client={client}>{node}</QueryClientProvider>
    </I18nProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // Fail the auto-check fetch so the badge stays in its initial
  // (no-result) state. This lets the SSR smoke tests assert the
  // "no badge" baseline; the badge-visible branch is unit-tested
  // separately by toggling `updateResult` via a forced re-render
  // in the future Playwright + RTL suite.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("network disabled in tests");
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("<AboutSection> — update badge", () => {
  it("renders the version line without a badge by default", () => {
    const html = render(<AboutSection />);
    expect(html).toContain("v1.4.36");
    // No badge — ArrowUpCircle's lucide class name is the unique signal.
    expect(html).not.toContain("lucide-arrow-up-circle");
  });

  it("drops the manual 'Check for updates' button surface entirely", () => {
    const html = render(<AboutSection />);
    // Pre-v1.4.36 the section carried a "Check for updates" CTA
    // alongside a last-checked timestamp. Both are now gone — only
    // the 24 h auto-check stays, surfacing through the badge above.
    expect(html).not.toContain(">Check for updates<");
    expect(html).not.toContain(">Check now<");
    expect(html).not.toContain("last-checked-iso");
  });

  it("preserves the Sources & docs panel", () => {
    const html = render(<AboutSection />);
    expect(html).toContain("Sources &amp; docs");
  });

  it("uses a dedicated 'Built' label for the build-time row rather than the gitSha fallback", () => {
    const html = render(<AboutSection />);
    // Distinct label keeps the dt copy separate from the "Build" gitSha
    // header above it; the prior `t('builtAt', { time: '' }).trim()`
    // pattern silently leaked the gitSha key as a fallback.
    expect(html).toContain(">Built<");
    // Only ONE column should ever read "Build" — the gitSha header.
    const buildOccurrences = html.match(/>Build</g) ?? [];
    expect(buildOccurrences.length).toBe(1);
  });
});

describe("<UpdateBadge> — a11y contract", () => {
  it("renders an anchor with aria-label, focus-visible ring, and 44 px hit target when a URL is known", () => {
    const html = renderToStaticMarkup(
      <UpdateBadge
        latestTag="v1.4.99"
        htmlUrl="https://example.test/releases/v1.4.99"
        ariaLabel="A newer version is available: v1.4.99"
      />,
    );
    expect(html).toContain('aria-label="A newer version is available: v1.4.99"');
    expect(html).toContain("min-h-11");
    expect(html).toContain("min-w-11");
    expect(html).toContain("focus-visible:ring-ring");
    expect(html).toContain("focus-visible:ring-2");
    expect(html).toContain("focus-visible:ring-offset-2");
    expect(html).toContain("text-primary");
    expect(html).toContain('href="https://example.test/releases/v1.4.99"');
  });

  it("falls back to a span with role=img + aria-label when no URL is known", () => {
    const html = renderToStaticMarkup(
      <UpdateBadge
        latestTag="v1.4.99"
        htmlUrl={null}
        ariaLabel="A newer version is available: v1.4.99"
      />,
    );
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="A newer version is available: v1.4.99"');
    expect(html).toContain("min-h-11");
    expect(html).toContain("min-w-11");
  });
});
