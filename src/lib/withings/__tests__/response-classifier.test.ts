/**
 * v1.4.42 W6 — Withings off-response classifier.
 *
 * The classifier turns a `(httpStatus, body)` pair into a verdict of
 * `success / transient / reauth_required / persistent`. Every other
 * Withings code path branches on the verdict; this suite pins the
 * three-way taxonomy plus the "off-spec response" edge cases the
 * legacy client treated as silent no-data.
 */
import { describe, expect, it } from "vitest";
import {
  WithingsApiError,
  classifyError,
  classifyWithingsResponse,
} from "../response-classifier";

describe("classifyWithingsResponse — success branch", () => {
  it("treats HTTP 200 + status 0 as success", () => {
    const v = classifyWithingsResponse(200, { status: 0 });
    expect(v.classification).toBe("success");
    expect(v.withingsStatus).toBe(0);
    expect(v.reason).toBe("ok");
  });
});

describe("classifyWithingsResponse — transient branch", () => {
  it("HTTP 503 → transient (upstream outage)", () => {
    const v = classifyWithingsResponse(503, null);
    expect(v.classification).toBe("transient");
    expect(v.reason).toBe("http_503");
  });

  it("HTTP 502 → transient", () => {
    expect(classifyWithingsResponse(502, null).classification).toBe(
      "transient",
    );
  });

  it("HTTP 429 → transient (rate-limit)", () => {
    const v = classifyWithingsResponse(429, null);
    expect(v.classification).toBe("transient");
    expect(v.reason).toBe("http_429");
  });

  it("Withings status 503 (service unavailable) → transient", () => {
    const v = classifyWithingsResponse(200, { status: 503 });
    expect(v.classification).toBe("transient");
    expect(v.withingsStatus).toBe(503);
  });

  it("Withings status 601 (rate-limited) → transient", () => {
    expect(
      classifyWithingsResponse(200, { status: 601 }).classification,
    ).toBe("transient");
  });

  it("Withings status 2554 (notify-subscribe transient) → transient", () => {
    expect(
      classifyWithingsResponse(200, { status: 2554 }).classification,
    ).toBe("transient");
  });

  it("off-spec body without a `status` field → transient (one-off CDN page)", () => {
    const v = classifyWithingsResponse(200, {});
    expect(v.classification).toBe("transient");
    expect(v.reason).toBe("no_status_field");
  });

  it("unknown Withings status defaults to transient (admin-alert ladder catches recurrence)", () => {
    const v = classifyWithingsResponse(200, { status: 9999 });
    expect(v.classification).toBe("transient");
    expect(v.reason).toBe("withings_9999_unknown");
  });
});

describe("classifyWithingsResponse — reauth_required branch", () => {
  it.each([100, 101, 102])(
    "Withings status %i → reauth_required (permanent revoke)",
    (status) => {
      const v = classifyWithingsResponse(200, { status });
      expect(v.classification).toBe("reauth_required");
      expect(v.withingsStatus).toBe(status);
    },
  );

  it("Withings 200 (invalid_grant boundary) → reauth_required", () => {
    expect(
      classifyWithingsResponse(200, { status: 200 }).classification,
    ).toBe("reauth_required");
  });

  it("Withings 250 (mid-range invalid_grant) → reauth_required", () => {
    expect(
      classifyWithingsResponse(200, { status: 250 }).classification,
    ).toBe("reauth_required");
  });

  it("Withings 299 (invalid_grant upper boundary) → reauth_required", () => {
    expect(
      classifyWithingsResponse(200, { status: 299 }).classification,
    ).toBe("reauth_required");
  });
});

describe("classifyWithingsResponse — persistent branch", () => {
  it("Withings status 293 (invalid params) → persistent", () => {
    const v = classifyWithingsResponse(200, { status: 293 });
    expect(v.classification).toBe("persistent");
    expect(v.withingsStatus).toBe(293);
  });

  it("Withings status 294 (already-subscribed) → persistent (callers downgrade for subscribe)", () => {
    // 294 is idempotent-success at the subscribeWebhook call-site;
    // the classifier still surfaces it as persistent so any OTHER
    // endpoint that sees 294 is loud about the contract bug.
    expect(
      classifyWithingsResponse(200, { status: 294 }).classification,
    ).toBe("persistent");
  });

  it("HTTP 400 (unexpected from Withings) → persistent", () => {
    const v = classifyWithingsResponse(400, null);
    expect(v.classification).toBe("persistent");
    expect(v.reason).toBe("http_400");
  });

  it("HTTP 404 → persistent", () => {
    expect(classifyWithingsResponse(404, null).classification).toBe(
      "persistent",
    );
  });
});

describe("WithingsApiError", () => {
  it("carries the classification + status on the typed error", () => {
    const err = new WithingsApiError({
      verb: "refresh",
      classification: "reauth_required",
      withingsStatus: 100,
      reason: "withings_100",
      upstreamError: "Authentication failed",
    });
    expect(err.classification).toBe("reauth_required");
    expect(err.withingsStatus).toBe(100);
    expect(err.reason).toBe("withings_100");
    expect(err.verb).toBe("refresh");
    expect(err.name).toBe("WithingsApiError");
  });

  it("preserves the legacy `Withings <verb> error: <status> - <error>` message shape", () => {
    const err = new WithingsApiError({
      verb: "measure",
      classification: "transient",
      withingsStatus: 503,
      reason: "withings_503",
      upstreamError: "service unavailable",
    });
    // Legacy regex consumers (extractWithingsStatus, etc.) expect
    // exactly this shape.
    expect(err.message).toBe(
      "Withings measure error: 503 - service unavailable",
    );
    expect(/Withings\s+\w+\s+error:\s*(\d+)/.exec(err.message)?.[1]).toBe(
      "503",
    );
  });

  it("omits the dash-segment when upstreamError is absent", () => {
    const err = new WithingsApiError({
      verb: "subscribe",
      classification: "persistent",
      withingsStatus: 293,
      reason: "withings_293",
    });
    expect(err.message).toBe("Withings subscribe error: 293");
  });
});

describe("classifyError", () => {
  it("reads the verdict directly off a WithingsApiError instance", () => {
    const err = new WithingsApiError({
      verb: "refresh",
      classification: "reauth_required",
      withingsStatus: 101,
      reason: "withings_101",
    });
    expect(classifyError(err)).toBe("reauth_required");
  });

  it("falls back to the message regex when the prototype was lost (pg-boss round-trip)", () => {
    // pg-boss serializes job errors to JSON and re-throws as plain Error
    // on retry — the WithingsApiError prototype does NOT survive.
    const rehydrated = new Error("Withings refresh error: 102 - User does not exist");
    expect(classifyError(rehydrated)).toBe("reauth_required");
  });

  it("classifies a recovered Withings 503 transient via the regex fallback", () => {
    const rehydrated = new Error("Withings measure error: 503");
    expect(classifyError(rehydrated)).toBe("transient");
  });

  it("classifies a recovered Withings 293 persistent via the regex fallback", () => {
    const rehydrated = new Error("Withings activity error: 293");
    expect(classifyError(rehydrated)).toBe("persistent");
  });

  it("defaults to transient for unrelated errors (network drop, timeout)", () => {
    expect(classifyError(new Error("ECONNRESET"))).toBe("transient");
    expect(classifyError("string error")).toBe("transient");
    expect(classifyError(null)).toBe("transient");
  });
});
