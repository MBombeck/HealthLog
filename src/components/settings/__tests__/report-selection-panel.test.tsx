/**
 * Settings → Gesundheitsakte: what the export panel opens with.
 *
 * Two things are seeded from `/api/auth/me` during render — the practice name
 * and the saved selection. The seed runs during render because a `useState`
 * initialiser would read `undefined` while `useAuth` is still resolving and
 * stick, and it is gated on the user id so a late re-resolve never clobbers
 * edits in flight.
 *
 * The three panel states are the load-bearing part. A first run must select
 * NOTHING — no template, no server default, no group half on — and must leave
 * Generate disabled until a person ticks something, with the standard-report
 * button one click away. A repeat run must open collapsed carrying the owner's
 * own last scope. A set that arrives without being asked for is a
 * preselection whatever it is called, and material nobody ticked is exactly
 * what this surface must never send.
 *
 * SSR-only, per the project convention for this surface.
 *
 * Mutation checks (each verified red, then reverted):
 *   - remove the seeding block → "pre-fills the input" and "restores the saved
 *     selection" go red.
 *   - seed `selected` from `STANDARD_TEMPLATE_LEAVES` → "selects nothing on a
 *     first run", "counts nothing in any group" and "disables Generate" go
 *     red.
 *   - start `pickerOpen` at `false` → "opens expanded on the first run" goes
 *     red.
 *   - drop `selected.size === 0` from the Generate `disabled` expression →
 *     "disables Generate while the scope is empty" goes red.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import type { AuthUser } from "@/hooks/use-auth";

const authSpy = vi.fn<() => { user: AuthUser | null }>();
vi.mock("@/hooks/use-auth", async () => {
  const actual =
    await vi.importActual<typeof import("@/hooks/use-auth")>(
      "@/hooks/use-auth",
    );
  return { ...actual, useAuth: () => authSpy() };
});

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  // The panel's visit offer reads the encounter list. Pending forever here:
  // this file is about the panel's own state, and a resolved read would put
  // an offer in the markup every assertion below would have to know about.
  useQuery: () => ({ data: undefined, isPending: true, isError: false }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { HealthRecordExportPanel } from "../report-selection/selection-panel";

function buildUser(lastReportPracticeName: string | null): AuthUser {
  return {
    id: "user-1",
    username: "user",
    email: null,
    role: "USER",
    heightCm: null,
    dateOfBirth: null,
    gender: null,
    timezone: "Europe/Berlin",
    onboardingCompletedAt: null,
    onboardingTourCompleted: true,
    onboardingTourProgress: null,
    avatarUrl: null,
    glucoseUnit: null,
    unitPreference: "metric",
    timeFormat: "AUTO",
    dateFormat: "AUTO",
    disableCoach: false,
    fullName: null,
    insurerName: null,
    insurerIkNumber: null,
    insuranceNumber: null,
    lastReportPracticeName,
    reportSelection: null,
    cycleTrackingEnabled: false,
    modules: {},
  } as AuthUser;
}

function withSavedSelection(user: AuthUser, leaves: string[]): AuthUser {
  return {
    ...user,
    reportSelection: {
      v: 2,
      leaves,
      format: "fhir",
      rangeDays: 180,
      includeCharts: false,
    },
  } as AuthUser;
}

/**
 * Whether a leaf row renders as checked. Only the fenced tier and an expanded
 * group render leaf rows at all — a collapsed group shows its count chip
 * instead, which is the point of the two-interaction repeat path.
 */
function leafChecked(html: string, leaf: string): boolean {
  const row = html.match(
    new RegExp(`data-testid="report-leaf-${leaf}-export"[\\s\\S]*?</label>`),
  )?.[0];
  if (!row) return false;
  return /data-state="checked"/.test(row);
}

/** The "n/total" chip a collapsed group row carries. */
function groupChip(html: string, group: string): string | null {
  const row = html.match(
    new RegExp(
      `data-testid="report-group-row-${group}-export"[\\s\\S]*?</div>`,
    ),
  )?.[0];
  return row?.match(/data-slot="tag-chip"[^>]*>([^<]*)</)?.[1] ?? null;
}

function renderPanel(user: AuthUser | null): string {
  authSpy.mockReturnValue({ user });
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <HealthRecordExportPanel />
    </I18nProvider>,
  );
}

function practiceInputValue(html: string): string | null {
  const input = html.match(/<input[^>]*id="hr-practice"[^>]*>/)?.[0];
  if (!input) return null;
  return input.match(/value="([^"]*)"/)?.[1] ?? "";
}

/** Whether the Generate control refuses the press. */
function generateDisabled(html: string): boolean {
  const button = html.match(
    /<button[^>]*data-testid="health-record-generate"[^>]*>/,
  )?.[0];
  if (!button) throw new Error("the Generate button did not render");
  return /\sdisabled=""/.test(button);
}

describe("<HealthRecordExportPanel> — remembered practice name", () => {
  it("pre-fills the input with the last-used practice name", () => {
    const html = renderPanel(buildUser("Sample Practice"));
    expect(practiceInputValue(html)).toBe("Sample Practice");
  });

  it("leaves the input empty when no name was ever remembered", () => {
    const html = renderPanel(buildUser(null));
    expect(practiceInputValue(html)).toBe("");
  });

  it("leaves the input empty while the auth payload is still resolving", () => {
    const html = renderPanel(null);
    expect(practiceInputValue(html)).toBe("");
  });
});

describe("<HealthRecordExportPanel> — the first run", () => {
  it("opens the picker expanded with the standard-report button in view", () => {
    const html = renderPanel(buildUser(null));
    expect(html).toContain('data-testid="health-record-included-data-panel"');
    expect(html).toContain('data-testid="report-scope-picker-export"');
    // The template is offered by name on a button, not applied behind the
    // user's back. One click is still one click; it just has to happen.
    expect(html).toContain('data-testid="report-apply-standard-export"');
    expect(html).toContain("Apply Standard doctor&#x27;s report");
  });

  it("selects nothing at all — no template, no default", () => {
    const html = renderPanel(buildUser(null));
    expect(html).toContain('data-testid="report-scope-summary-export"');
    expect(html).toContain("Nothing selected yet");
    // Every leaf the panel renders at all is off. Only the fenced tier renders
    // leaf rows while every group is collapsed, and none of them is checked.
    for (const leaf of ["MOOD", "CYCLE", "FAMILY_HISTORY", "PHQ9_SCORE"]) {
      expect(leafChecked(html, leaf), leaf).toBe(false);
    }
  });

  it("counts nothing in any group, the template's own groups included", () => {
    const html = renderPanel(buildUser(null));
    // These six carry the standard template's leaves. On a first run they read
    // 0/n like every other group: the template is a button, not a starting
    // state.
    expect(groupChip(html, "identity")).toBe("0/3");
    expect(groupChip(html, "vitals")).toBe("0/7");
    expect(groupChip(html, "body")).toBe("0/12");
    expect(groupChip(html, "labs")).toBe("0/1");
    expect(groupChip(html, "medications")).toBe("0/4");
    // ALLERGIES, ILLNESS_EPISODES, VISITS, SURGICAL_HISTORY, IMMUNIZATIONS.
    expect(groupChip(html, "history")).toBe("0/5");
    expect(groupChip(html, "cardio")).toBe("0/14");
    expect(groupChip(html, "activity")).toBe("0/8");
    expect(groupChip(html, "sleepRecovery")).toBe("0/16");
    expect(groupChip(html, "mobility")).toBe("0/11");
    expect(groupChip(html, "environment")).toBe("0/4");
  });

  it("disables Generate while the scope is empty, and says what to do", () => {
    const html = renderPanel(buildUser(null));
    expect(generateDisabled(html)).toBe(true);
    // The reason sits beside the control and points at the way out of it,
    // rather than telling the person off after they press.
    expect(html).toContain(
      "Nothing selected yet. Choose what to include, or apply the standard report.",
    );
  });

  it("leaves every fenced leaf unchecked and renders the tier", () => {
    const html = renderPanel(buildUser(null));
    expect(html).toContain('data-testid="report-sensitive-tier-export"');
    for (const leaf of [
      "MOOD",
      "CYCLE",
      "FAMILY_HISTORY",
      "PHQ9_SCORE",
      "GAD7_SCORE",
      "WHO5_SCORE",
      "SCI_SCORE",
    ]) {
      expect(leafChecked(html, leaf), leaf).toBe(false);
    }
  });

  it("gives the fenced tier no group checkbox", () => {
    const html = renderPanel(buildUser(null));
    expect(html).toContain('data-testid="report-group-check-vitals-export"');
    expect(html).not.toContain(
      'data-testid="report-group-check-sensitive-export"',
    );
  });
});

describe("<HealthRecordExportPanel> — a repeat run", () => {
  it("restores the saved selection and collapses the picker", () => {
    const html = renderPanel(
      withSavedSelection(buildUser("Sample Practice"), [
        "RESTING_HEART_RATE",
        "MOOD",
      ]),
    );
    expect(html).not.toContain(
      'data-testid="health-record-included-data-panel"',
    );
    // The scope line still says what will be in the document, and it names the
    // fenced inclusion rather than folding it into the count.
    expect(html).toContain("2 entries from 2 areas");
    expect(html).toContain("incl. Mood");
  });

  it("enables Generate once a scope has been chosen", () => {
    const html = renderPanel(withSavedSelection(buildUser(null), ["WEIGHT"]));
    expect(generateDisabled(html)).toBe(false);
    expect(html).not.toContain("Nothing selected yet");
  });

  it("restores the saved format and range", () => {
    const html = renderPanel(withSavedSelection(buildUser(null), ["WEIGHT"]));
    // FHIR was saved, so the practice-name line (PDF only) is not rendered.
    expect(practiceInputValue(html)).toBeNull();
    expect(html).toContain('<option value="180" selected=""');
  });

  it("falls back to an empty scope when the saved blob cannot be read", () => {
    const user = {
      ...buildUser(null),
      reportSelection: { bp: true, weight: true },
    } as AuthUser;
    const html = renderPanel(user);
    // A shape the server cannot read is not consent to anything, so the panel
    // treats it as a first run: nothing selected, Generate refused, the
    // standard-report button one click away.
    expect(groupChip(html, "body")).toBe("0/12");
    expect(generateDisabled(html)).toBe(true);
    expect(html).toContain('data-testid="report-apply-standard-export"');
  });
});
