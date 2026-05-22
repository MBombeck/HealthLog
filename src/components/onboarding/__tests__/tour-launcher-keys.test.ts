/**
 * v1.4.15 H4 — sessionStorage keys used by the dashboard tour
 * launcher must be scoped per user id. Without scoping, an admin
 * impersonating a second user (or a family member sharing the
 * browser) inherited the first user's "tour dismissed for this
 * session" flag and the tour silently no-op'd for the second user.
 *
 * The key-builders are exported so this lock-test pins the wire
 * format. Changing them is a soft compatibility break — every
 * already-rendered tab would re-fire the tour for the user once,
 * because the un-prefixed legacy keys are never read again. We
 * accept that one-off tax in exchange for the multi-tenant
 * correctness.
 *
 * v1.4.47 W5 adds a third key, `tourForceLaunchKey`, that carries
 * the "user just clicked Replay in Settings → About/Account" intent
 * across the navigation back to the dashboard. The launcher reads
 * and clears it on its next mount, bypassing the new 24 h
 * auto-launch gate so a first-day user who *wants* the tour
 * actually gets it.
 */
import { describe, expect, it } from "vitest";
import {
  tourForceLaunchKey,
  tourReferrerKey,
  tourSessionDismissedKey,
} from "../tour-launcher";

describe("tour-launcher sessionStorage key scoping", () => {
  it("scopes the dismiss key by user id", () => {
    expect(tourSessionDismissedKey("u_abc")).toBe(
      "healthlog-tour-session-dismissed:u_abc",
    );
  });

  it("scopes the referrer key by user id", () => {
    expect(tourReferrerKey("u_abc")).toBe("healthlog-tour-referrer:u_abc");
  });

  it("scopes the force-launch key by user id (v1.4.47 W5)", () => {
    expect(tourForceLaunchKey("u_abc")).toBe(
      "healthlog-tour-force-launch:u_abc",
    );
  });

  it("returns distinct keys for distinct users", () => {
    expect(tourSessionDismissedKey("u_alice")).not.toBe(
      tourSessionDismissedKey("u_bob"),
    );
    expect(tourReferrerKey("u_alice")).not.toBe(tourReferrerKey("u_bob"));
    expect(tourForceLaunchKey("u_alice")).not.toBe(
      tourForceLaunchKey("u_bob"),
    );
  });

  it("does not collide with the legacy un-scoped keys", () => {
    expect(tourSessionDismissedKey("u_x")).not.toBe(
      "healthlog-tour-session-dismissed",
    );
    expect(tourReferrerKey("u_x")).not.toBe("healthlog-tour-referrer");
    expect(tourForceLaunchKey("u_x")).not.toBe("healthlog-tour-force-launch");
  });

  it("uses three distinct namespaces so the keys can never alias each other", () => {
    // Belt-and-braces: if a future refactor accidentally collapses
    // two key builders onto the same prefix, the launcher's gating
    // logic would conflate "session-dismissed" with "force-launch"
    // and produce a one-shot tour-loop on every dashboard mount.
    const userId = "u_test";
    const keys = new Set([
      tourSessionDismissedKey(userId),
      tourReferrerKey(userId),
      tourForceLaunchKey(userId),
    ]);
    expect(keys.size).toBe(3);
  });
});
