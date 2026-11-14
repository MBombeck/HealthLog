/**
 * How the Browser Push card reads a refusal from `pushManager.subscribe()`.
 *
 * The reported case is Brave with push messaging switched off, which rejects
 * with `AbortError: Registration failed - push service error` and used to
 * show only "Activation failed".
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  classifyWebPushSubscribeFailure,
  isBraveBrowser,
} from "../web-push-subscribe-failure";

function domError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

const PUSH_SERVICE_ERROR = domError(
  "AbortError",
  "Registration failed - push service error",
);

describe("classifyWebPushSubscribeFailure", () => {
  it("names the push service when the browser could not register with it", () => {
    expect(
      classifyWebPushSubscribeFailure(PUSH_SERVICE_ERROR, {
        permission: "granted",
        isBrave: false,
      }),
    ).toBe("push-service");
  });

  it("names Brave's setting when the browser is Brave", () => {
    expect(
      classifyWebPushSubscribeFailure(PUSH_SERVICE_ERROR, {
        permission: "granted",
        isBrave: true,
      }),
    ).toBe("push-service-brave");
  });

  it("reads any other AbortError from subscribe as the push service", () => {
    // Chromium also says "push service not available"; Firefox says
    // "Error retrieving push subscription." Both are the push service.
    for (const message of [
      "Registration failed - push service not available",
      "Error retrieving push subscription.",
    ]) {
      expect(
        classifyWebPushSubscribeFailure(domError("AbortError", message), {
          permission: "granted",
          isBrave: false,
        }),
      ).toBe("push-service");
    }
  });

  it("keeps a blocked permission as blocked, whatever the error said", () => {
    expect(
      classifyWebPushSubscribeFailure(PUSH_SERVICE_ERROR, {
        permission: "denied",
        isBrave: true,
      }),
    ).toBe("denied");
  });

  it("does not blame the push service for a dismissed permission prompt", () => {
    expect(
      classifyWebPushSubscribeFailure(
        domError("NotAllowedError", "Registration failed - permission denied"),
        { permission: "default", isBrave: true },
      ),
    ).toBe("unknown");
    expect(
      classifyWebPushSubscribeFailure(
        domError("AbortError", "Registration failed - permission denied"),
        { permission: "default", isBrave: true },
      ),
    ).toBe("unknown");
  });

  it("does not blame the push service for a key the browser would not take", () => {
    expect(
      classifyWebPushSubscribeFailure(
        domError(
          "AbortError",
          "Registration failed - missing applicationServerKey, and manifest empty or missing",
        ),
        { permission: "granted", isBrave: true },
      ),
    ).toBe("unknown");
    expect(
      classifyWebPushSubscribeFailure(
        domError(
          "InvalidAccessError",
          "The provided applicationServerKey is not valid.",
        ),
        { permission: "granted", isBrave: false },
      ),
    ).toBe("unknown");
  });

  it("keeps the generic message for anything that is not an error object", () => {
    expect(
      classifyWebPushSubscribeFailure("boom", {
        permission: "granted",
        isBrave: false,
      }),
    ).toBe("unknown");
    expect(
      classifyWebPushSubscribeFailure(new TypeError("Failed to fetch"), {
        permission: "granted",
        isBrave: false,
      }),
    ).toBe("unknown");
  });
});

describe("isBraveBrowser", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");

  afterEach(() => {
    if (original) Object.defineProperty(globalThis, "navigator", original);
  });

  function withNavigator(value: unknown): void {
    Object.defineProperty(globalThis, "navigator", {
      value,
      configurable: true,
      writable: true,
    });
  }

  it("is true when navigator.brave is present", () => {
    withNavigator({ brave: { isBrave: async () => true } });
    expect(isBraveBrowser()).toBe(true);
  });

  it("is false for a Chromium without navigator.brave", () => {
    withNavigator({ userAgent: "Mozilla/5.0 Chrome/130" });
    expect(isBraveBrowser()).toBe(false);
  });
});
