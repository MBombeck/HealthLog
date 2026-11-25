import { describe, it, expect } from "vitest";

import { WideEventBuilder } from "../event-builder";

/**
 * Nothing leaves the wide-event builder unscrubbed.
 *
 * `setError` and `setHttp` have always scrubbed. `addMeta` and
 * `addExternalCall` did not, which made them a trusted sink by accident: the
 * finished event is JSON-stringified whole to stdout and the log store, so a
 * string placed in meta is as visible as one placed in an error message.
 *
 * Two real feeds exploited that gap. A Telegram request timeout put the full
 * request URL — which embeds the bot token — into `external_calls[].error`. And
 * the AI provider chain fed upstream error bodies into meta, so a gateway that
 * echoes the offending request on a 400 echoed prompt content.
 *
 * These tests fail on the previous code.
 */

/** Read the finished event the way a transport would. */
function emitted(b: WideEventBuilder): string {
  return JSON.stringify(b.toJSON());
}

describe("wide-event builder — redaction at every entry point", () => {
  it("scrubs a bot token that arrives through addExternalCall", () => {
    const b = new WideEventBuilder("http");
    b.addExternalCall({
      service: "telegram",
      method: "sendMessage",
      duration_ms: 12,
      error:
        "timeout of 5000ms exceeded: https://api.telegram.org/bot123456:AAH-SuperSecretBotTokenValue/sendMessage",
    });
    expect(emitted(b)).not.toContain("AAH-SuperSecretBotTokenValue");
  });

  it("scrubs a credential that arrives through addWarning", () => {
    // A warning often carries an outbound error string, and for several
    // integrations that string is the request URL with a secret in it (a
    // GeoLite2 download carries the licence key). It must be scrubbed on the
    // way in, the same as setError / setHttp / addExternalCall.
    const b = new WideEventBuilder("background");
    b.addWarning(
      "geolite2 download failed: https://download.maxmind.com/app/geoip_download?edition_id=GeoLite2-City&license_key=SECRET_MAXMIND_KEY&suffix=tar.gz",
    );
    expect(emitted(b)).not.toContain("SECRET_MAXMIND_KEY");
  });

  it("scrubs an API key that arrives through addMeta", () => {
    const b = new WideEventBuilder("http");
    b.addMeta(
      "ai_chain_hop_1_body",
      "401 unauthorized: key sk-abcdef1234567890",
    );
    expect(emitted(b)).not.toContain("sk-abcdef1234567890");
  });

  it("scrubs strings nested inside an object or array", () => {
    // The emitted JSON flattens structure — a nested string is exactly as
    // exposed as a top-level one, so the walk has to reach it.
    const b = new WideEventBuilder("http");
    b.addMeta("payload", {
      hops: [{ detail: "token sk-nested9876543210 rejected" }],
    });
    expect(emitted(b)).not.toContain("sk-nested9876543210");
  });

  it("leaves ordinary diagnostic values intact", () => {
    // Over-redaction would make the logs useless, which is its own failure.
    const b = new WideEventBuilder("http");
    b.addMeta("count", 42);
    b.addMeta("action", "coach.budget.exceeded");
    const out = emitted(b);
    expect(out).toContain("coach.budget.exceeded");
    expect(out).toContain("42");
  });

  it("bounds pathological nesting instead of recursing without limit", () => {
    // A cyclic or absurdly nested value must not turn a log write into a crash.
    let deep: Record<string, unknown> = { leaf: "sk-deepvalue12345678" };
    for (let i = 0; i < 40; i++) deep = { next: deep };
    const b = new WideEventBuilder("http");
    expect(() => b.addMeta("deep", deep)).not.toThrow();
    expect(emitted(b)).not.toContain("sk-deepvalue12345678");
  });
});

describe("wide-event builder — health classifications", () => {
  it("drops a classification written under its own key", () => {
    const b = new WideEventBuilder("http");
    b.addMeta("illness_type", "MENTAL_HEALTH");
    b.addMeta("allergyCategory", "MEDICATION");
    b.addMeta("ilae_type", "FOCAL_IMPAIRED");
    const out = emitted(b);
    expect(out).not.toContain("MENTAL_HEALTH");
    expect(out).not.toContain("MEDICATION");
    expect(out).not.toContain("FOCAL_IMPAIRED");
  });

  it("drops a classification nested inside a meta object", () => {
    const b = new WideEventBuilder("http");
    b.addMeta("import", { rows: 3, symptoms: ["migraine", "nausea"] });
    const out = emitted(b);
    expect(out).not.toContain("migraine");
    expect(out).toContain('"rows":3');
  });

  it("keeps counts and flags named after a class", () => {
    const b = new WideEventBuilder("http");
    b.addMeta("allergy_count", 2);
    b.addMeta("conditions", 4);
    b.addMeta("mood_context", "written");
    const meta = b.toJSON().meta ?? {};
    expect(meta.allergy_count).toBe(2);
    expect(meta.conditions).toBe(4);
    expect(meta.mood_context).toBe("written");
  });
});
