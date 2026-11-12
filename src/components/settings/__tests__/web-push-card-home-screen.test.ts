/**
 * Which "push is unavailable" sentence the Web Push card shows.
 *
 * An iPhone in a Safari tab has no PushManager, the same as a browser that
 * cannot do push at all, and the card used to tell both that push is not
 * supported. On iOS the fix is to open HealthLog from the Home Screen, so
 * that case gets its own sentence.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { needsHomeScreen } from "../web-push-card";

const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";
const IPAD_AS_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15";
const ANDROID_FIREFOX =
  "Mozilla/5.0 (Android 14; Mobile; rv:132.0) Gecko/132.0 Firefox/132.0";

function device(
  userAgent: string,
  maxTouchPoints: number,
  standalone: boolean,
) {
  vi.stubGlobal("navigator", { userAgent, maxTouchPoints });
  vi.stubGlobal("window", {
    matchMedia: (query: string) => ({
      matches: standalone && query === "(display-mode: standalone)",
    }),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("needsHomeScreen", () => {
  it("asks an iPhone in a Safari tab to open the Home Screen app", () => {
    device(IPHONE, 5, false);
    expect(needsHomeScreen()).toBe(true);
  });

  it("asks an iPad, which reports itself as a Mac, the same", () => {
    device(IPAD_AS_MAC, 5, false);
    expect(needsHomeScreen()).toBe(true);
  });

  it("does not ask the installed app, where push is missing for real", () => {
    device(IPHONE, 5, true);
    expect(needsHomeScreen()).toBe(false);
  });

  it("does not ask a Mac without a touch screen", () => {
    device(IPAD_AS_MAC, 0, false);
    expect(needsHomeScreen()).toBe(false);
  });

  it("does not ask a browser that has no push at all", () => {
    device(ANDROID_FIREFOX, 5, false);
    expect(needsHomeScreen()).toBe(false);
  });
});
