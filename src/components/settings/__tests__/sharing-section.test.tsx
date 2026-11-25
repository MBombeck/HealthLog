/**
 * v1.11.0 — Settings → Sharing (Epic C, C7).
 *
 * The owner share-link surface. The security-load-bearing guarantees the
 * test pins:
 *   1. The list never carries a raw `hls_` token — the server stores only the
 *      hash, so the list response shape has no token field and the rendered
 *      markup must not surface one.
 *   2. The one-time token reveal card (`share-token-reveal`) is absent until a
 *      create succeeds — on first paint (no token in state) it must not render.
 *   3. Active links render with a revoke control; revoked/expired links fold
 *      into the inactive list.
 *   4. The expiry input is bounded at the server cap (90 days).
 *
 * SSR-static render only (no jsdom), matching the sibling settings-section
 * tests. The TanStack hooks are mocked so the query returns a fixed link list.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { id: "u1", role: "USER" },
    isAuthenticated: true,
    isLoading: false,
    refetch: vi.fn(),
  }),
}));

const FIXTURE_LINKS = [
  {
    id: "link-active",
    label: "Cardiology referral",
    rangeStart: "2026-01-01T00:00:00.000Z",
    rangeEnd: null,
    documentCount: 2,
    expiresAt: "2099-01-01T00:00:00.000Z",
    createdAt: "2026-06-01T00:00:00.000Z",
    revokedAt: null,
    lastAccessAt: "2026-06-02T10:00:00.000Z",
    accessCount: 3,
    active: true,
  },
  {
    id: "link-revoked",
    label: "Old GP link",
    rangeStart: "2026-01-01T00:00:00.000Z",
    rangeEnd: null,
    documentCount: 0,
    expiresAt: "2099-01-01T00:00:00.000Z",
    createdAt: "2026-05-01T00:00:00.000Z",
    revokedAt: "2026-05-15T00:00:00.000Z",
    lastAccessAt: null,
    accessCount: 0,
    active: false,
  },
];

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: FIXTURE_LINKS, isLoading: false }),
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { SharingSection } from "../sharing-section";
import { primeLocales } from "@/__tests__/helpers/prime-locales";

primeLocales("de");

function render(locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>
      <SharingSection />
    </I18nProvider>,
  );
}

describe("<SharingSection> — owner share-link surface (C7)", () => {
  it("renders the create form with a 90-day-capped expiry input", () => {
    const html = render();
    expect(html).toContain("New share link");
    // The expiry field carries the server's max-days cap.
    expect(html).toContain('max="90"');
    expect(html).toContain("Create link");
  });

  it("does not reveal a token before a create succeeds", () => {
    const html = render();
    // The one-time reveal card only mounts once `newToken` state is set.
    expect(html).not.toContain('data-testid="share-token-reveal"');
  });

  it("lists the active link with a revoke control and never a raw token", () => {
    const html = render();
    expect(html).toContain('data-testid="share-active-list"');
    expect(html).toContain("Cardiology referral");
    expect(html).toContain("Revoke");
    // The list response shape carries no token; the markup must not surface
    // an `hls_` string anywhere.
    expect(html).not.toContain("hls_");
    // No FHIR badge: the link has never served FHIR, so advertising
    // it on the owner's list was the last place the promise still showed.
    expect(html).not.toContain("FHIR");
  });

  it("folds revoked links into the inactive list (not the active list)", () => {
    const html = render();
    // The active list must NOT contain the revoked link's label.
    const activeListStart = html.indexOf('data-testid="share-active-list"');
    const activeListEnd = html.indexOf('data-testid="share-inactive-list"');
    // Inactive list is collapsed by default, so the label only appears once
    // the disclosure is open — but the active list must never carry it.
    const activeSlice =
      activeListEnd > activeListStart
        ? html.slice(activeListStart, activeListEnd)
        : html.slice(activeListStart);
    expect(activeSlice).not.toContain("Old GP link");
    // The inactive-count disclosure surfaces.
    expect(html).toContain("Revoked and expired");
  });

  it("renders localized section copy", () => {
    const html = render("de");
    expect(html).toContain("Neuer Freigabelink");
  });

  it("offers the document picker trigger and surfaces the ≤50 cap", () => {
    const html = render();
    // The attach-documents affordance is present on the create form.
    expect(html).toContain('data-testid="share-attach-open"');
    expect(html).toContain("Attach documents");
    // The cap the picker enforces client-side is surfaced in the count copy.
    expect(html).toContain("of 50 selected");
  });

  it("surfaces the frozen-set warning so the write-once contract is explicit", () => {
    const html = render();
    // The set cannot be edited after creation — the UI must say so.
    expect(html).toContain("fixed once you create the link");
  });

  it("shows a document-count badge on a link that carries documents", () => {
    const html = render();
    expect(html).toContain('data-testid="share-doc-count-badge"');
    // The active fixture carries two documents.
    const activeStart = html.indexOf('data-testid="share-active-list"');
    const activeSlice = html.slice(activeStart);
    expect(activeSlice).toContain('data-testid="share-doc-count-badge"');
  });
});
