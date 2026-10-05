import { describe, expect, it } from "vitest";

import { sheetShown } from "../conversations-panel";

/**
 * `/coach?settings=data` opens the phone sheet, and only the phone sheet.
 * The server and hydration renders take the narrow layout (the viewport is
 * not known yet), so a deep link that opened the sheet from the first
 * render flashed it on a desktop before the docked panel replaced it.
 */
describe("sheetShown", () => {
  const deepLink = { chosen: false, deepLinkPending: true };

  it("keeps the sheet shut while the viewport is not known", () => {
    expect(sheetShown({ ...deepLink, hydrated: false, docked: false })).toBe(
      false,
    );
  });

  it("never opens the sheet for a deep link on a docked viewport", () => {
    expect(sheetShown({ ...deepLink, hydrated: true, docked: true })).toBe(
      false,
    );
  });

  it("opens the sheet for a deep link on a phone once hydrated", () => {
    expect(sheetShown({ ...deepLink, hydrated: true, docked: false })).toBe(
      true,
    );
  });

  it("follows the person's own choice otherwise", () => {
    const base = { deepLinkPending: false, hydrated: true, docked: false };
    expect(sheetShown({ ...base, chosen: true })).toBe(true);
    expect(sheetShown({ ...base, chosen: false })).toBe(false);
  });
});
