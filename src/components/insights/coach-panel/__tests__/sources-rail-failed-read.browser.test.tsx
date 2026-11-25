/**
 * A Coach preferences read that fails leaves nothing to save on top of.
 *
 * The read used to answer a non-OK response with the built-in defaults. The
 * rail then showed those defaults as the saved state, and the next switch sent
 * them back as the whole document, without the revision token (there was none
 * to read), so the unconditional write replaced every preference the account
 * had saved: the data scope, the look-back window, the reasoning level. A
 * passing 502 during a deploy was enough.
 */
import { describe, expect, it } from "vitest";

import { renderWithApp } from "../../../../../tests/browser/render";
import { stubFetch } from "../../../../../tests/browser/fetch-stub";
import { CoachPrefsSection } from "@/components/settings/coach-prefs-section";
import { SourcesRail } from "../sources-rail";

const PREFS = "/api/auth/me/coach-prefs";

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 150));
}

describe("SourcesRail after a failed preferences read", () => {
  it("offers no switch to save over the stored preferences", async () => {
    const fetchStub = stubFetch()
      .on("GET", PREFS, { status: 502, error: "Bad gateway" })
      .on("PUT", PREFS, { data: null });
    const { screen } = await renderWithApp(<SourcesRail />);
    await expect
      .poll(() => fetchStub.calls("GET", PREFS).length)
      .toBeGreaterThan(0);
    await settle();

    const switches = screen.container.querySelectorAll<HTMLButtonElement>(
      '[data-slot="coach-sources-checkbox"]',
    );
    expect(switches.length).toBeGreaterThan(0);
    for (const control of switches) expect(control.disabled).toBe(true);

    switches[0].click();
    await settle();
    expect(fetchStub.calls("PUT", PREFS)).toHaveLength(0);
  });

  it("saves with the stored revision once the read succeeds", async () => {
    const fetchStub = stubFetch()
      .on("GET", PREFS, {
        data: {
          tone: "warm",
          verbosity: "default",
          excludeMetrics: [],
          updatedAt: "2026-11-24T10:00:00.000Z",
        },
      })
      .on("PUT", PREFS, { data: null });
    const { screen } = await renderWithApp(<SourcesRail />);
    await expect
      .poll(
        () =>
          screen.container.querySelector<HTMLButtonElement>(
            '[data-slot="coach-sources-checkbox"]:not([disabled])',
          ) !== null,
      )
      .toBe(true);
    screen.container
      .querySelector<HTMLButtonElement>('[data-slot="coach-sources-checkbox"]')!
      .click();
    await expect.poll(() => fetchStub.calls("PUT", PREFS).length).toBe(1);
    expect(fetchStub.calls("PUT", PREFS)[0].body).toMatchObject({
      baseUpdatedAt: "2026-11-24T10:00:00.000Z",
    });
  });
});

describe("Settings > Coach after a failed preferences read", () => {
  it("says the read failed instead of loading for ever", async () => {
    const fetchStub = stubFetch().on("GET", PREFS, {
      status: 502,
      error: "Bad gateway",
    });
    const { screen } = await renderWithApp(
      <CoachPrefsSection isAuthenticated />,
    );
    await expect
      .poll(
        () =>
          screen.container.querySelector('[data-slot="query-error-row"]') !==
          null,
        { timeout: 10_000 },
      )
      .toBe(true);
    expect(
      screen.container.querySelector('[data-slot="coach-prefs-skeleton"]'),
    ).toBeNull();
    expect(fetchStub.calls("PUT", PREFS)).toHaveLength(0);
  });
});
