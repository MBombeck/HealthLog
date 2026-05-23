import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Stub the launcher import so the helper test never has to instantiate
// the @dnd-kit / launcher render tree just to exercise its
// sessionStorage write side-effect. We assert the helper *calls* it on
// the success branch and skips it when no user-id was passed in.
const setTourForceLaunchSpy = vi.fn();
vi.mock("@/components/onboarding/tour-launcher", () => ({
  setTourForceLaunch: (userId: string) => setTourForceLaunchSpy(userId),
}));

import { restartOnboardingTour } from "../tour-restart";

describe("restartOnboardingTour()", () => {
  beforeEach(() => {
    setTourForceLaunchSpy.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("success branch — flips the server flag, fires the force-launch marker, returns { ok: true }", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("{}", { status: 200 }));

    const result = await restartOnboardingTour("user-42", { fetchImpl });

    expect(result).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("/api/onboarding/tour");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({ "Content-Type": "application/json" });
    expect(init?.body).toBe(JSON.stringify({ completed: false }));
    // Per-user force-launch marker fired on success.
    expect(setTourForceLaunchSpy).toHaveBeenCalledWith("user-42");
  });

  it("success branch — skips the force-launch marker when no userId was supplied", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("{}", { status: 200 }));

    const result = await restartOnboardingTour(undefined, { fetchImpl });

    expect(result).toEqual({ ok: true });
    expect(setTourForceLaunchSpy).not.toHaveBeenCalled();
  });

  it("error-network branch — fetch rejects, returns { ok: false } with common.networkError", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new TypeError("network down"));

    const result = await restartOnboardingTour("user-42", { fetchImpl });

    expect(result).toEqual({ ok: false, messageKey: "common.networkError" });
    // No force-launch marker should fire on the error branch — a failed
    // server flip MUST NOT arm the launcher.
    expect(setTourForceLaunchSpy).not.toHaveBeenCalled();
  });

  it("error-server-422 branch — non-ok response returns { ok: false } with settings.savingError", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: "Unprocessable" }), {
        status: 422,
      }),
    );

    const result = await restartOnboardingTour("user-42", { fetchImpl });

    expect(result).toEqual({ ok: false, messageKey: "settings.savingError" });
    expect(setTourForceLaunchSpy).not.toHaveBeenCalled();
  });
});
