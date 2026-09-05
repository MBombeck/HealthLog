import { describe, it, expect } from "vitest";

import { classifyErrorBody } from "../provider-runner";

/**
 * An upstream error body never reaches the logs verbatim.
 *
 * The provider chain used to put the first 500 characters of whatever the
 * remote returned into a wide-event meta key. That is fine for a terse vendor
 * error and catastrophic for a gateway that echoes the offending request on a
 * 400 — the standard shape for `context_length_exceeded` — because on this path
 * the request is the coach system prompt plus the user's health snapshot.
 *
 * Scrubbing cannot fix this: there is no pattern that distinguishes a person's
 * weight history from any other text. So the body is classified rather than
 * quoted, and these tests pin that no input content survives.
 */

/** Health content of the kind a gateway echo would carry. */
const ECHOED_PROMPT =
  'context_length_exceeded: request was {"messages":[{"role":"system","content":"You are writing a short assessment. Weight 82.4 kg, resting pulse 61 bpm, ramipril 5mg daily, mood note: felt low on Tuesday"}]}';

describe("upstream error-body classification", () => {
  it("names a known rejection without quoting the body", () => {
    const out = classifyErrorBody(ECHOED_PROMPT);
    expect(out).toBe("classified:context_length_exceeded");
  });

  it("carries no health content from an echoed prompt", () => {
    const out = classifyErrorBody(ECHOED_PROMPT) ?? "";
    for (const leak of [
      "82.4",
      "ramipril",
      "felt low on Tuesday",
      "resting pulse",
      "messages",
    ]) {
      expect(out, `classification leaked "${leak}"`).not.toContain(leak);
    }
  });

  it("reports only a size for an unrecognised body", () => {
    // Still enough to tell "the same failure every hop" from "a different one
    // each time", which is the actual diagnostic question. The expected length
    // is measured here from the literal, not read back from the implementation.
    const body = "something entirely unexpected from a proxy";
    expect(classifyErrorBody(body)).toBe(`unclassified:${body.length}chars`);
  });

  it("never returns a substring of an unrecognised body", () => {
    const secretish = "internal-hostname-10-1-2-3 said no";
    const out = classifyErrorBody(secretish) ?? "";
    expect(out).not.toContain("internal-hostname");
    expect(out).not.toContain("said no");
  });

  it("classifies the other known shapes", () => {
    expect(classifyErrorBody("429 rate limit reached")).toBe(
      "classified:rate_limited",
    );
    expect(classifyErrorBody("the model_not_found for gpt-x")).toBe(
      "classified:model_not_found",
    );
    expect(classifyErrorBody("invalid response_format schema")).toBe(
      "classified:response_format_rejected",
    );
    expect(classifyErrorBody("insufficient_quota on this key")).toBe(
      "classified:quota_or_billing",
    );
    expect(classifyErrorBody("invalid_api_key supplied")).toBe(
      "classified:auth_rejected",
    );
  });

  it("names a gateway's own wording for the two account-side refusals", () => {
    // A gateway meters prepaid credit and enforces the account's data policy
    // in its own vocabulary, not OpenAI's. Both used to land in the
    // unclassified bucket, which is exactly the pair a person needs told
    // apart: top the account up, or widen the routing policy.
    expect(
      classifyErrorBody(
        '{"error":{"code":402,"message":"Insufficient credits"}}',
      ),
    ).toBe("classified:quota_or_billing");
    expect(
      classifyErrorBody(
        '{"error":{"code":403,"message":"No endpoints found matching your data policy"}}',
      ),
    ).toBe("classified:no_eligible_provider");
  });

  it("passes through absence honestly", () => {
    expect(classifyErrorBody(null)).toBeNull();
    expect(classifyErrorBody("")).toBeNull();
    expect(classifyErrorBody(undefined)).toBeNull();
  });
});
