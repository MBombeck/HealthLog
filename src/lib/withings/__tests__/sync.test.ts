import { afterEach, describe, expect, it } from "vitest";
import { getWithingsWebhookCallbackUrl } from "../sync";

/**
 * v1.4.25 W17a — Withings webhook callback URL must put the shared
 * secret in the PATH (not the `?secret=` query parameter) so that the
 * value never lands in a reverse-proxy `query_string` access-log
 * column. Withings preserves the full URL on every notification, so
 * the format chosen at subscribe time is what every inbound delivery
 * carries thereafter.
 */
describe("getWithingsWebhookCallbackUrl", () => {
  const ORIGINAL_BASE = process.env.NEXT_PUBLIC_APP_URL;
  const ORIGINAL_SECRET = process.env.WITHINGS_WEBHOOK_SECRET;

  afterEach(() => {
    if (ORIGINAL_BASE === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
    else process.env.NEXT_PUBLIC_APP_URL = ORIGINAL_BASE;
    if (ORIGINAL_SECRET === undefined)
      delete process.env.WITHINGS_WEBHOOK_SECRET;
    else process.env.WITHINGS_WEBHOOK_SECRET = ORIGINAL_SECRET;
  });

  it("encodes the secret as the final path segment, not as ?secret=", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://healthlog.example.com";
    process.env.WITHINGS_WEBHOOK_SECRET = "super-secret-value";

    const url = getWithingsWebhookCallbackUrl();

    expect(url).toBe(
      "https://healthlog.example.com/api/withings/webhook/super-secret-value",
    );
    expect(url).not.toContain("?secret=");
    expect(url).not.toContain("?");
  });

  it("URL-encodes path-unsafe characters in the secret", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://healthlog.example.com";
    process.env.WITHINGS_WEBHOOK_SECRET = "a/b c?d";

    const url = getWithingsWebhookCallbackUrl();

    // `/`, ` `, and `?` would all break the path semantics if injected
    // raw; encodeURIComponent yields `a%2Fb%20c%3Fd`.
    expect(url).toBe(
      "https://healthlog.example.com/api/withings/webhook/a%2Fb%20c%3Fd",
    );
  });

  it("falls back to the bare legacy URL when WITHINGS_WEBHOOK_SECRET is unset", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://healthlog.example.com";
    delete process.env.WITHINGS_WEBHOOK_SECRET;

    const url = getWithingsWebhookCallbackUrl();

    expect(url).toBe("https://healthlog.example.com/api/withings/webhook");
  });
});
