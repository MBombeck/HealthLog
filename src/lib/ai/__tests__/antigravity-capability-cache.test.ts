/**
 * Antigravity capability cache: stores per-user media capabilities from the
 * ACP initialize result, keyed by user id.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  antigravityReadsMedia,
  clearAntigravityCapabilityCache,
  forgetAntigravityCapabilities,
  setAntigravityCapabilities,
} from "../antigravity-capability-cache";

afterEach(() => {
  clearAntigravityCapabilityCache();
});

describe("setAntigravityCapabilities / antigravityReadsMedia", () => {
  it("returns false for an unknown user", () => {
    expect(antigravityReadsMedia("user-unknown")).toBe(false);
  });

  it("returns false when json is null", () => {
    setAntigravityCapabilities("u1", null);
    expect(antigravityReadsMedia("u1")).toBe(false);
  });

  it("returns false when json is undefined", () => {
    setAntigravityCapabilities("u1", undefined);
    expect(antigravityReadsMedia("u1")).toBe(false);
  });

  it("returns false when promptCapabilities is absent", () => {
    setAntigravityCapabilities("u1", {});
    expect(antigravityReadsMedia("u1")).toBe(false);
  });

  it("returns false when both image and embeddedContext are false", () => {
    setAntigravityCapabilities("u1", {
      promptCapabilities: { image: false, embeddedContext: false },
    });
    expect(antigravityReadsMedia("u1")).toBe(false);
  });

  it("returns true when image is true", () => {
    setAntigravityCapabilities("u1", {
      promptCapabilities: { image: true, embeddedContext: false },
    });
    expect(antigravityReadsMedia("u1")).toBe(true);
  });

  it("returns false when image is false and embeddedContext is true", () => {
    setAntigravityCapabilities("u1", {
      promptCapabilities: { image: false, embeddedContext: true },
    });
    expect(antigravityReadsMedia("u1")).toBe(false);
  });

  it("returns true when image is true and embeddedContext is false", () => {
    setAntigravityCapabilities("u1", {
      promptCapabilities: { image: true, embeddedContext: false },
    });
    expect(antigravityReadsMedia("u1")).toBe(true);
  });

  it("returns true when both are true", () => {
    setAntigravityCapabilities("u1", {
      promptCapabilities: { image: true, embeddedContext: true },
    });
    expect(antigravityReadsMedia("u1")).toBe(true);
  });

  it("last write wins for the same user", () => {
    setAntigravityCapabilities("u1", {
      promptCapabilities: { image: true, embeddedContext: true },
    });
    setAntigravityCapabilities("u1", {
      promptCapabilities: { image: false, embeddedContext: false },
    });
    expect(antigravityReadsMedia("u1")).toBe(false);
  });

  it("tracks multiple users independently", () => {
    setAntigravityCapabilities("u1", {
      promptCapabilities: { image: true, embeddedContext: true },
    });
    setAntigravityCapabilities("u2", {
      promptCapabilities: { image: false, embeddedContext: false },
    });
    expect(antigravityReadsMedia("u1")).toBe(true);
    expect(antigravityReadsMedia("u2")).toBe(false);
  });
});

describe("forgetAntigravityCapabilities", () => {
  it("clears an existing entry", () => {
    setAntigravityCapabilities("u1", {
      promptCapabilities: { image: true, embeddedContext: true },
    });
    forgetAntigravityCapabilities("u1");
    expect(antigravityReadsMedia("u1")).toBe(false);
  });

  it("is a no-op for an unknown user", () => {
    expect(() => forgetAntigravityCapabilities("nobody")).not.toThrow();
  });
});
