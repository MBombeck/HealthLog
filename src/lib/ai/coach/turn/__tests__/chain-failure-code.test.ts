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

/**
 * #1404 — a capability bound to one provider has no fallback, so when that
 * provider is stopped, slow or silent the person needs the reason, not the
 * generic "try again in a moment".
 */
describe("chainFailureCode names why a chain gave no answer", () => {
  it("a provider that could not be reached", () => {
    expect(
      chainFailureCode({
        attempts: [hop({ providerType: "local", failureKind: "refused" })],
        primaryCredentialExpired: false,
      }),
    ).toBe("coach.provider.unreachable");
  });

  it("a provider that ran out of time", () => {
    expect(
      chainFailureCode({
        attempts: [hop({ providerType: "local", failureKind: "timeout" })],
        primaryCredentialExpired: false,
      }),
    ).toBe("coach.provider.timeout");
  });

  it("a mix of timeouts and unreachable hops reads as unreachable", () => {
    expect(
      chainFailureCode({
        attempts: [
          hop({ failureKind: "headers_timeout" }),
          hop({ attempt: 2, failureKind: "dns" }),
        ],
        primaryCredentialExpired: false,
      }),
    ).toBe("coach.provider.unreachable");
  });

  it("a provider that answered with nothing", () => {
    expect(
      chainFailureCode({
        attempts: [hop({ failureKind: "empty_response" })],
        primaryCredentialExpired: false,
      }),
    ).toBe("coach.provider.empty");
  });

  it("stays generic for an HTTP failure", () => {
    expect(
      chainFailureCode({
        attempts: [hop({ httpStatus: 502, failureKind: "http" })],
        primaryCredentialExpired: false,
      }),
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

  it("names an un-wrapped reply that held nothing (#1404)", () => {
    const err = Object.assign(new Error("returned empty content"), {
      httpStatus: 0,
      kind: "empty_response",
      upstream: "local",
    });
    expect(classifyBubblingProviderError(err)).toEqual({
      code: "empty",
      httpStatus: 0,
    });
  });
});
