import { describe, expect, it } from "vitest";
import { WideEventBuilder } from "../event-builder";

describe("WideEventBuilder.setHttp", () => {
  it("stores plain http metadata as-is", () => {
    const evt = new WideEventBuilder("http");
    evt.setHttp({
      method: "GET",
      path: "/api/health",
      route: "/api/health",
      status: 200,
    });
    const json = evt.toJSON();
    expect(json.http).toMatchObject({
      method: "GET",
      path: "/api/health",
      route: "/api/health",
      status: 200,
    });
  });

  // Fix-J (v1.4.25 W21, sec-C1): WITHINGS_WEBHOOK_SECRET lands in
  // http.path on every request without this scrub. Verify the redaction
  // is applied at setHttp time so the secret never reaches stdout, the
  // in-memory ring buffer, or Loki.
  it("redacts Withings webhook secret from http.path and http.route", () => {
    const evt = new WideEventBuilder("http");
    evt.setHttp({
      method: "POST",
      path: "/api/withings/webhook/test-secret",
      route: "/api/withings/webhook/test-secret",
      status: 200,
    });
    const http = evt.toJSON().http;
    expect(http?.path).toBe("/api/withings/webhook/[REDACTED]");
    expect(http?.route).toBe("/api/withings/webhook/[REDACTED]");
  });

  it("preserves trailing path segments after the redacted secret", () => {
    const evt = new WideEventBuilder("http");
    evt.setHttp({
      method: "GET",
      path: "/api/withings/webhook/sup3r-secr3t/verify",
      route: "/api/withings/webhook/[token]/verify",
      status: 200,
    });
    const http = evt.toJSON().http;
    expect(http?.path).toBe("/api/withings/webhook/[REDACTED]/verify");
    // The Next.js route template `[token]` does not match the
    // path-segment rule's `<segment>` shape boundary (the brackets are
    // treated as a regular segment), so it is still redacted; either
    // shape is acceptable since the goal is to never leak the secret.
    expect(http?.route).toBe("/api/withings/webhook/[REDACTED]/verify");
  });

  it("does not over-redact unrelated paths", () => {
    const evt = new WideEventBuilder("http");
    evt.setHttp({
      method: "GET",
      path: "/api/measurements/123",
      route: "/api/measurements/[id]",
      status: 200,
    });
    const http = evt.toJSON().http;
    expect(http?.path).toBe("/api/measurements/123");
    expect(http?.route).toBe("/api/measurements/[id]");
  });

  it("still scrubs query-string secrets via the existing rule", () => {
    const evt = new WideEventBuilder("http");
    evt.setHttp({
      method: "POST",
      path: "/api/withings/webhook?secret=abc123",
      route: "/api/withings/webhook",
      status: 200,
    });
    const http = evt.toJSON().http;
    expect(http?.path).toBe("/api/withings/webhook?secret=[REDACTED]");
    expect(http?.route).toBe("/api/withings/webhook");
  });

  it("preserves other http fields verbatim", () => {
    const evt = new WideEventBuilder("http");
    evt.setHttp({
      method: "POST",
      path: "/api/withings/webhook/leak",
      route: "/api/withings/webhook/leak",
      status: 200,
      user_agent: "WithingsClient/1.0",
      ip: "10.0.0.1",
      content_length: 42,
      response_size: 17,
    });
    const http = evt.toJSON().http;
    expect(http).toMatchObject({
      method: "POST",
      path: "/api/withings/webhook/[REDACTED]",
      route: "/api/withings/webhook/[REDACTED]",
      status: 200,
      user_agent: "WithingsClient/1.0",
      ip: "10.0.0.1",
      content_length: 42,
      response_size: 17,
    });
  });

  it("handles an undefined http payload without throwing", () => {
    const evt = new WideEventBuilder("http");
    evt.setHttp(undefined);
    expect(evt.toJSON().http).toBeUndefined();
  });
});
