/**
 * A toggle in the injection-site exclusions never drops a stored exclusion.
 *
 * The card sends the whole list on every toggle and the server stores it as
 * sent. Two ways that list used to be wrong: a failed read answered `[]` as if
 * nothing were excluded, so the next click replaced every exclusion with one;
 * and the list came from a copy cached for minutes in a tab that does not
 * refetch on focus, so a click undid exclusions added on another device since.
 */
import { describe, expect, it } from "vitest";

import { renderWithApp } from "../../../../tests/browser/render";
import { stubFetch } from "../../../../tests/browser/fetch-stub";
import { InjectionSitesCard } from "../injection-sites-card";

const PREFS = "/api/auth/me/injection-site-prefs";

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 150));
}

function checkboxes(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(
    container.querySelectorAll<HTMLButtonElement>('button[role="checkbox"]'),
  );
}

describe("InjectionSitesCard", () => {
  it("offers nothing to toggle after a failed read", async () => {
    const fetchStub = stubFetch()
      .on("GET", PREFS, { status: 502, error: "Bad gateway" })
      .on("PATCH", PREFS, { data: null });
    const { screen } = await renderWithApp(
      <InjectionSitesCard isAuthenticated />,
    );
    await expect
      .poll(() => fetchStub.calls("GET", PREFS).length)
      .toBeGreaterThan(0);
    await settle();

    const boxes = checkboxes(screen.container);
    expect(boxes.length).toBeGreaterThan(0);
    for (const box of boxes) expect(box.disabled).toBe(true);
    boxes[4].click();
    await settle();
    expect(fetchStub.calls("PATCH", PREFS)).toHaveLength(0);
  });

  it("applies a toggle to the list as stored, not as this tab last saw it", async () => {
    // This tab loaded one exclusion; another device has since added a second.
    let reads = 0;
    const fetchStub = stubFetch()
      .on("GET", PREFS, () => {
        reads += 1;
        return {
          data: {
            globalExcludedInjectionSites:
              reads === 1
                ? ["ABDOMEN_LEFT"]
                : ["ABDOMEN_LEFT", "ABDOMEN_RIGHT"],
          },
        };
      })
      .on("PATCH", PREFS, { data: null });
    const { screen } = await renderWithApp(
      <InjectionSitesCard isAuthenticated />,
    );
    await expect
      .poll(() => checkboxes(screen.container)[0]?.dataset.state)
      .toBe("checked");

    // THIGH_LEFT is the fifth site.
    checkboxes(screen.container)[4].click();
    await expect.poll(() => fetchStub.calls("PATCH", PREFS).length).toBe(1);
    expect(fetchStub.calls("PATCH", PREFS)[0].body).toEqual({
      globalExcludedInjectionSites: [
        "ABDOMEN_LEFT",
        "ABDOMEN_RIGHT",
        "THIGH_LEFT",
      ],
    });
  });
});
