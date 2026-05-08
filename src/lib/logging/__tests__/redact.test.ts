import { describe, expect, it } from "vitest";
import { redactSecrets, redactOptional } from "../redact";

describe("redactSecrets", () => {
  it("redacts Bearer tokens", () => {
    expect(redactSecrets("Authorization: Bearer hlk_abc123def456")).toBe(
      "Authorization: Bearer [REDACTED]",
    );
    expect(redactSecrets("auth=Bearer  whitespace_token")).toBe(
      "auth=Bearer [REDACTED]",
    );
  });

  it("redacts Telegram bot tokens in path-style URLs", () => {
    expect(
      redactSecrets(
        "fetch failed: https://api.telegram.org/bot1234567890:AAEhBP-w-secret/sendMessage",
      ),
    ).toBe("fetch failed: https://api.telegram.org/bot[REDACTED]/sendMessage");
  });

  it("redacts query-string secrets", () => {
    expect(redactSecrets("Withings webhook ?secret=abc123 failed")).toBe(
      "Withings webhook ?secret=[REDACTED] failed",
    );
    expect(redactSecrets("OAuth ?code=xyz&state=abc")).toBe(
      "OAuth ?code=[REDACTED]&state=abc",
    );
    expect(redactSecrets("api?api_key=secret")).toBe("api?api_key=[REDACTED]");
  });

  it("leaves non-secret-shaped strings alone", () => {
    expect(redactSecrets("HTTP 503 from upstream")).toBe(
      "HTTP 503 from upstream",
    );
    expect(redactSecrets("user-7 measurement saved")).toBe(
      "user-7 measurement saved",
    );
  });

  it("handles multiple secrets in one string", () => {
    // Bearer matches `\S+` so it greedily consumes `hlk_x;` — that's
    // safe (over-redaction is fine when the alternative is leaking).
    expect(redactSecrets("Bearer hlk_x bot999:tok ?code=abc123")).toBe(
      "Bearer [REDACTED] bot[REDACTED] ?code=[REDACTED]",
    );
  });
});

describe("redactOptional", () => {
  it("returns undefined for undefined input", () => {
    expect(redactOptional(undefined)).toBeUndefined();
  });

  it("redacts when present", () => {
    expect(redactOptional("Bearer x")).toBe("Bearer [REDACTED]");
  });
});
