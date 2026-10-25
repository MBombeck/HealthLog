/**
 * The recovery readiness card.
 *
 *   1. every signal renders as its own row with the server's state, its
 *      sentence and its time;
 *   2. a row that needs work links to where it is fixed, unless that is the
 *      page already open; an ok or inactive row carries no link;
 *   3. a grace period shows its due date rather than a time of an event;
 *   4. a failed drill shows its reason with no time window: a failure months
 *      old is still on the card;
 *   5. the overall badge carries the worst state; the copy resolves in German.
 *
 * Mutation check: show the fix link on every row and case 2 goes red; drop
 * the `detail` line and case 4 goes red.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { RecoveryReadinessCard } from "@/components/admin/recovery-readiness-card";
import type {
  ReadinessSignal,
  RecoveryReadiness,
} from "@/components/admin/use-recovery-readiness";
import { READINESS_FIX_PATHS } from "@/lib/recovery/readiness-model";
import { primeLocales } from "@/__tests__/helpers/prime-locales";

primeLocales("de");

const pathname = vi.hoisted(() => ({ current: "/admin" }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => pathname.current,
}));

function sig(
  id: ReadinessSignal["id"],
  state: ReadinessSignal["state"],
  reason: string,
  over: Partial<ReadinessSignal> = {},
): ReadinessSignal {
  return {
    id,
    state,
    reason,
    at: null,
    params: {},
    detail: null,
    fixPath: READINESS_FIX_PATHS[id],
    ...over,
  };
}

const READINESS: RecoveryReadiness = {
  state: "failing",
  evaluatedAt: "2026-10-25T12:00:00.000Z",
  signals: [
    sig("database_dump", "inactive", "not_available"),
    sig("weekly_copy", "attention", "stale", {
      at: "2026-10-14T03:00:00.000Z",
      params: { days: 11, accounts: 2 },
    }),
    sig("offhost_copies", "ok", "fresh", { at: "2026-10-25T02:40:00.000Z" }),
    sig("restore_drill", "failing", "failed", {
      at: "2026-07-01T04:20:00.000Z",
      params: { failed: 1, checked: 4 },
      detail: "1 of 4 backup objects failed. Restore drill: bad tag",
    }),
    sig("offhost_setup", "ok", "configured"),
    sig("recovery_kit", "ok", "not_confirmed_grace", {
      at: "2026-10-30T09:00:00.000Z",
      params: { keys: "v2, API_TOKEN_HMAC_KEY", count: 2 },
    }),
  ],
};

function render(readiness: RecoveryReadiness, locale: "en" | "de" = "en") {
  const client = new QueryClient();
  client.setQueryData(queryKeys.adminRecoveryReadiness(), readiness);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale={locale}>
        <RecoveryReadinessCard />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

/** The markup of one signal's row. */
function row(html: string, id: string): string {
  const start = html.indexOf(`data-testid="recovery-signal-${id}"`);
  expect(start).toBeGreaterThan(-1);
  const end = html.indexOf("</li>", start);
  return html.slice(start, end);
}

describe("RecoveryReadinessCard", () => {
  it("renders every signal with its state and sentence", () => {
    pathname.current = "/admin";
    const html = render(READINESS);
    for (const s of READINESS.signals) {
      expect(row(html, s.id)).toContain(`data-state="${s.state}"`);
    }
    expect(row(html, "weekly_copy")).toContain(
      "The oldest weekly copy is 11 days old. Accounts behind: 2.",
    );
    expect(row(html, "database_dump")).toContain(
      "This version does not schedule a database dump.",
    );
  });

  it("links a row that needs work to where it is fixed, and nothing else", () => {
    pathname.current = "/admin";
    const html = render(READINESS);
    expect(row(html, "weekly_copy")).toContain('href="/admin/backups"');
    expect(row(html, "restore_drill")).toContain('href="/admin/backups"');
    expect(row(html, "recovery_kit")).toContain('href="/admin/encryption"');
    expect(row(html, "offhost_copies")).not.toContain("href=");
    expect(row(html, "database_dump")).not.toContain("href=");
  });

  it("does not link to the page already open", () => {
    pathname.current = "/admin/backups";
    const html = render(READINESS);
    expect(row(html, "weekly_copy")).not.toContain("href=");
    expect(row(html, "recovery_kit")).toContain('href="/admin/encryption"');
  });

  it("shows a grace period's due date", () => {
    pathname.current = "/admin";
    expect(row(render(READINESS), "recovery_kit")).toContain("Due by ");
  });

  it("keeps a months-old drill failure on the card with its reason", () => {
    pathname.current = "/admin";
    const drill = row(render(READINESS), "restore_drill");
    expect(drill).toContain(
      "The last restore drill failed: 1 of 4 copies could not be read back.",
    );
    expect(drill).toContain("Restore drill: bad tag");
    expect(drill).toContain("Last drill: ");
  });

  it("carries the worst state on the badge, and speaks German", () => {
    pathname.current = "/admin";
    const html = render(READINESS);
    expect(html).toContain('data-testid="recovery-readiness-state"');
    expect(html).toContain('data-state="failing"');
    expect(render({ ...READINESS, state: "ok" })).toContain(">Ready<");
    expect(render(READINESS, "de")).toContain("Wiederherstellbarkeit");
  });
});
