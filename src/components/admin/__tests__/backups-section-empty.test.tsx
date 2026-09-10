import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import de from "../../../../messages/de.json";
import en from "../../../../messages/en.json";

const healthySchedule = {
  lastSuccessAt: "2026-09-01T03:00:00.000Z",
  lastSuccessAgeDays: 2,
  staleAfterDays: 10,
  stale: false,
  lastRun: {
    at: "2026-09-01T03:00:12.000Z",
    state: "completed" as const,
    error: null,
  },
  lastRunFailed: false,
};

const mocks = vi.hoisted(() => ({
  mutationOptions: [] as Array<{
    onSuccess?: (data: { summary: Record<string, number> }) => void;
  }>,
  toastSuccess: vi.fn(),
  // Mutable so one file can render both a healthy schedule and a broken one;
  // the query mock reads it on every render.
  queryData: { rows: [], retentionDays: 30 } as Record<string, unknown>,
}));

/**
 * v1.4.15 phase-C5 — `/admin/backups` empty state.
 *
 * The previous build rendered a single-line `<p>No backups recorded
 * yet.</p>` inside the card. Brand-new admins didn't realise the "Run
 * backup now" CTA in the header was the way to create one, so the page
 * felt inert. The new EmptyState primitive duplicates the header CTA
 * inside the card so the action is right next to the explanation.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/admin/backups",
}));

vi.mock("sonner", () => ({
  toast: {
    success: mocks.toastSuccess,
    error: vi.fn(),
  },
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: mocks.queryData,
    isLoading: false,
    isError: false,
  }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useMutation: (options: unknown) => {
    mocks.mutationOptions.push(
      options as {
        onSuccess?: (data: { summary: Record<string, number> }) => void;
      },
    );
    return {
      mutate: vi.fn(),
      mutateAsync: vi.fn(),
      isPending: false,
      isError: false,
      error: null,
      variables: undefined,
    };
  },
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { id: "u1", username: "testuser", role: "ADMIN" },
    isAuthenticated: true,
    isLoading: false,
    refetch: vi.fn(),
  }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { BackupsSection } from "../backups-section";

function render(locale: "en" | "de" = "en") {
  mocks.queryData = {
    rows: [],
    retentionDays: 30,
    schedule: healthySchedule,
  };
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>
      <BackupsSection />
    </I18nProvider>,
  );
}

describe("BackupsSection — empty state", () => {
  it("renders the EmptyState primitive when no backups exist", () => {
    const html = render();
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("border-dashed");
  });

  it("includes the localized title and description", () => {
    const html = render();
    expect(html).toContain("No backups yet");
    expect(html).toContain("Backups run automatically every Sunday at 03:00");
  });

  it("exposes the Backup-now CTA inside the empty card", () => {
    const html = render();
    // The header's CTA is also "Backup now"; the empty-state CTA must
    // appear AT LEAST TWICE — once in the header, once inside the
    // empty card. If the empty card forgets the action we'd see only
    // one occurrence.
    const matches = (html.match(/Backup now/g) ?? []).length;
    expect(matches).toBeGreaterThanOrEqual(2);
  });

  it("uses the full muted semantic color for localized upload help", () => {
    const english = render();
    const german = render("de");
    const helpElement = english.match(
      /<[^>]+data-slot="backup-upload-help"[^>]*>/,
    )?.[0];
    const className = helpElement?.match(/\bclass="([^"]*)"/)?.[1] ?? "";

    expect(english).toContain(
      "JSON file matching the current backup schema. Max 10 MB.",
    );
    expect(german).toContain(
      "JSON-Datei passend zum aktuellen Backup-Schema. Max. 10 MB.",
    );
    expect(helpElement).toBeDefined();
    expect(className.split(/\s+/)).toContain("text-muted-foreground");
    expect(className).not.toMatch(/\b(?:opacity-\d+|text-\S+\/\d+)\b/);
  });

  it("names the instance-wide effect on the opt-in that carries it, in both catalogs", () => {
    // The restore rewrites the host's own settings only when the operator
    // ticks the box, so the warning belongs to the box rather than to the
    // sentence above it — and the box has to say what it turns on.
    expect(de.admin.section.backups.restoreInstanceSettingsLabel).toMatch(
      /instanzweite Einstellungen/i,
    );
    expect(de.admin.section.backups.restoreInstanceSettingsHint).toMatch(
      /Installation/,
    );
    expect(en.admin.section.backups.restoreInstanceSettingsLabel).toMatch(
      /instance settings/i,
    );
    expect(en.admin.section.backups.restoreInstanceSettingsHint).toMatch(
      /installation/i,
    );
  });
});

/**
 * The gap that let a weekly backup stop for a month and a half without anyone
 * noticing: the page rendered whatever rows it had, and a copy from six weeks
 * ago is indistinguishable from Sunday's until somebody subtracts the dates.
 */
describe("BackupsSection — schedule health", () => {
  function withSchedule(schedule: Record<string, unknown>) {
    mocks.queryData = { rows: [], retentionDays: 30, schedule };
    return renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <BackupsSection />
      </I18nProvider>,
    );
  }

  it("stays quiet while the schedule is healthy", () => {
    const html = render();
    expect(html).not.toContain('data-slot="backup-schedule-notice"');
  });

  it("says so when the newest scheduled copy has gone stale", () => {
    const html = withSchedule({
      ...healthySchedule,
      lastSuccessAt: "2026-07-19T03:00:00.000Z",
      lastSuccessAgeDays: 46,
      stale: true,
      lastRun: null,
      lastRunFailed: false,
    });

    expect(html).toContain('data-slot="backup-schedule-notice"');
    expect(html).toContain("The weekly backup has stopped");
    expect(html).toContain("46");
  });

  it("names the reason when the last scheduled run failed", () => {
    const html = withSchedule({
      ...healthySchedule,
      lastRun: {
        at: "2026-08-30T03:46:00.000Z",
        state: "failed",
        error: "job timed out",
      },
      lastRunFailed: true,
    });

    expect(html).toContain("The last scheduled backup run failed");
    expect(html).toContain("job timed out");
  });

  it("survives a response that predates the schedule field", () => {
    mocks.queryData = { rows: [], retentionDays: 30 };
    expect(() =>
      renderToStaticMarkup(
        <I18nProvider initialLocale="en">
          <BackupsSection />
        </I18nProvider>,
      ),
    ).not.toThrow();
  });
});

describe("BackupsSection — upload outcome", () => {
  it("includes health profile fact revisions in the restored record total", () => {
    mocks.toastSuccess.mockClear();
    const firstMutation = mocks.mutationOptions.length;
    render();
    const uploadOutcome = mocks.mutationOptions[firstMutation + 1]?.onSuccess;
    expect(uploadOutcome).toBeTypeOf("function");

    uploadOutcome!({
      summary: {
        measurements: 1,
        medications: 2,
        intakeEvents: 3,
        moodEntries: 4,
        healthProfileFactRevisions: 5,
      },
    });

    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      expect.stringContaining("15"),
    );
  });
});
