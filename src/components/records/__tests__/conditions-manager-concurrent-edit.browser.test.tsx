/**
 * Saving the conditions note never puts back what another device changed.
 *
 * The editor used to send both of its fields on every save, read from its
 * cached copy, without the self-context revision token. Editing the
 * conditions note in a tab opened before the Coach focus was changed on the
 * phone wrote the old focus back, and a conditions note saved elsewhere in
 * the meantime was overwritten without a word. The save now sends only the
 * field that changed, with the revision it was based on, and a conflict keeps
 * the draft and reloads.
 */
import { describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";

import { renderWithApp } from "../../../../tests/browser/render";
import { stubFetch } from "../../../../tests/browser/fetch-stub";
import { ConditionsManager } from "../conditions-manager";

const ABOUT_ME = "/api/coach/about-me";
const REVISION = "2026-11-24T09:00:00.000Z";

function aboutMe(overrides: Record<string, unknown> = {}) {
  return {
    aboutMe: null,
    conditions: "Asthma",
    allergies: null,
    coachFocus: "Sleep",
    fieldMaxChars: 500,
    maxChars: 4000,
    updatedAt: REVISION,
    ...overrides,
  };
}

async function editConditions(
  screen: Awaited<ReturnType<typeof renderWithApp>>["screen"],
  text: string,
) {
  const area = screen.getByTestId("records-conditions-conditions");
  await expect.element(area).toHaveValue("Asthma");
  await userEvent.clear(area);
  await userEvent.type(area, text);
  await screen.getByTestId("records-conditions-save").click();
}

describe("ConditionsManager save", () => {
  it("sends only the edited field, with the revision it was based on", async () => {
    const fetchStub = stubFetch()
      .on("GET", ABOUT_ME, { data: aboutMe() })
      .on("PUT", ABOUT_ME, { data: aboutMe({ conditions: "Asthma, COPD" }) });
    const { screen } = await renderWithApp(<ConditionsManager />);
    await editConditions(screen, "Asthma, COPD");

    await expect.poll(() => fetchStub.calls("PUT", ABOUT_ME).length).toBe(1);
    expect(fetchStub.calls("PUT", ABOUT_ME)[0].body).toEqual({
      conditions: "Asthma, COPD",
      baseUpdatedAt: REVISION,
    });
  });

  it("keeps the draft and reloads when the record changed elsewhere", async () => {
    let reads = 0;
    const fetchStub = stubFetch()
      .on("GET", ABOUT_ME, () => {
        reads += 1;
        return { data: aboutMe() };
      })
      .on("PUT", ABOUT_ME, {
        status: 409,
        error: "Changed elsewhere",
        meta: { errorCode: "about_me_conflict" },
      });
    const { screen } = await renderWithApp(<ConditionsManager />);
    await editConditions(screen, "Asthma, COPD");

    await expect.poll(() => fetchStub.calls("PUT", ABOUT_ME).length).toBe(1);
    await expect.poll(() => reads).toBeGreaterThan(1);
    await expect
      .element(screen.getByTestId("records-conditions-conditions"))
      .toHaveValue("Asthma, COPD");
  });
});
