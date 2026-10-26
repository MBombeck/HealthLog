/**
 * The `coach.provider.*` code a failed provider chain surfaces. #1276 — a
 * chain whose every hop answered with reasoning and no reply gets its own
 * code: "could not reach a provider, try again in a moment" is wrong for it,
 * because the provider was reached and answered, just never with an answer.
 */
import { describe, expect, it } from "vitest";

import type { FallbackHop } from "@/lib/ai/provider-runner";

import { chainFailureCode, classifyBubblingProviderError } from "../errors";

function hop(over: Partial<FallbackHop>): FallbackHop {
  return {
    providerType: "openai-compatible",
    attempt: 1,
    failureReason: "OpenAI-compatible gateway returned empty content",
    httpStatus: 0,
    ...over,
  };
}

describe("chainFailureCode", () => {
  it("names a chain that only ever reasoned", () => {
    expect(
      chainFailureCode({
        attempts: [hop({ failureKind: "reasoning_only" })],
        primaryCredentialExpired: false,
      }),
    ).toBe("coach.provider.reasoning_only");
  });

  it("stays generic when another hop failed for another reason", () => {
    expect(
      chainFailureCode({
        attempts: [
          hop({ failureKind: "reasoning_only" }),
          hop({ attempt: 2, httpStatus: 503, failureKind: "http" }),
        ],
        primaryCredentialExpired: false,
      }),
    ).toBe("coach.provider.unavailable");
  });

  it("keeps the existing codes", () => {
    expect(
      chainFailureCode({
        attempts: [hop({ httpStatus: 401 })],
        primaryCredentialExpired: true,
      }),
    ).toBe("coach.provider.credential_expired");
    expect(
      chainFailureCode({
        attempts: [hop({ httpStatus: 429 }), hop({ httpStatus: 429 })],
        primaryCredentialExpired: false,
      }),
    ).toBe("coach.provider.rate_limited");
    expect(
      chainFailureCode({ attempts: [], primaryCredentialExpired: false }),
    ).toBe("coach.provider.unavailable");
  });
});

describe("classifyBubblingProviderError", () => {
  it("names an un-wrapped reasoning-only reply", () => {
    const err = Object.assign(new Error("returned empty content"), {
      httpStatus: 0,
      kind: "reasoning_only",
      upstream: "openai-compatible",
    });
    expect(classifyBubblingProviderError(err)).toEqual({
      code: "reasoning_only",
      httpStatus: 0,
    });
  });
});
