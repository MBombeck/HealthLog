import { describe, expect, it } from "vitest";

import {
  codeForProviderCall,
  codeForProviderCalls,
  codeForProviderError,
  codeForRefusal,
  refusalOf,
} from "../classify";

describe("codeForProviderCall", () => {
  it("names the key, the rate limit and each failure kind", () => {
    expect(codeForProviderCall({ failure: "http", httpStatus: 401 })).toBe(
      "credential_expired",
    );
    expect(codeForProviderCall({ failure: "http", httpStatus: 429 })).toBe(
      "rate_limited",
    );
    expect(codeForProviderCall({ failure: "refused", httpStatus: null })).toBe(
      "provider_unreachable",
    );
    expect(
      codeForProviderCall({ failure: "headers_timeout", httpStatus: null }),
    ).toBe("provider_timeout");
    expect(
      codeForProviderCall({ failure: "reasoning_only", httpStatus: 200 }),
    ).toBe("provider_reasoning_only");
    expect(
      codeForProviderCall({ failure: "empty_response", httpStatus: 200 }),
    ).toBe("provider_empty");
    expect(codeForProviderCall({ failure: "paused", httpStatus: null })).toBe(
      "provider_paused",
    );
    expect(codeForProviderCall({ failure: "http", httpStatus: 500 })).toBe(
      "provider_error",
    );
  });

  it("does not count a call the caller cancelled", () => {
    expect(
      codeForProviderCall({ failure: "aborted", httpStatus: null }),
    ).toBeNull();
  });
});

describe("codeForProviderCalls", () => {
  it("keeps a shared code, folds timeouts into unreachable, and names a rejected first key", () => {
    expect(
      codeForProviderCalls([
        { failure: "timeout", httpStatus: null },
        { failure: "timeout", httpStatus: null },
      ]),
    ).toBe("provider_timeout");
    expect(
      codeForProviderCalls([
        { failure: "timeout", httpStatus: null },
        { failure: "dns", httpStatus: null },
      ]),
    ).toBe("provider_unreachable");
    expect(
      codeForProviderCalls([
        { failure: "http", httpStatus: 403 },
        { failure: "http", httpStatus: 500 },
      ]),
    ).toBe("credential_expired");
    expect(
      codeForProviderCalls([
        { failure: "http", httpStatus: 500 },
        { failure: "empty_response", httpStatus: 200 },
      ]),
    ).toBe("provider_error");
    expect(
      codeForProviderCalls([{ failure: "aborted", httpStatus: null }]),
    ).toBeNull();
  });
});

describe("codeForProviderError", () => {
  it("reads a chain failure through its hops, and an empty chain as no provider", () => {
    expect(
      codeForProviderError({
        attempts: [{ failureKind: "refused", httpStatus: null }],
        primaryCredentialExpired: false,
      }),
    ).toBe("provider_unreachable");
    expect(
      codeForProviderError({ attempts: [], primaryCredentialExpired: false }),
    ).toBe("no_provider");
    expect(
      codeForProviderError({
        attempts: [{ failureKind: "http", httpStatus: 500 }],
        primaryCredentialExpired: true,
      }),
    ).toBe("credential_expired");
  });

  it("needs the wire tag on a single error, so a server defect stays one", () => {
    expect(codeForProviderError(new Error("prisma exploded"))).toBeNull();
    expect(
      codeForProviderError(
        Object.assign(new Error("x"), { upstream: "openai", httpStatus: 429 }),
      ),
    ).toBe("rate_limited");
    expect(
      codeForProviderError(
        Object.assign(new Error("x"), { kind: "reasoning_only" }),
      ),
    ).toBe("provider_reasoning_only");
  });
});

describe("refusals", () => {
  it("reads a thrown capability refusal and a consent error", () => {
    expect(
      refusalOf({ name: "AiUnavailableError", reason: "no_provider" }),
    ).toBe("no_provider");
    expect(refusalOf({ errorCode: "consent.ai.required" })).toBe(
      "consent_required",
    );
    expect(refusalOf(new Error("other"))).toBeNull();
  });

  it("maps each reason that is recorded", () => {
    expect(codeForRefusal("no_provider")).toBe("no_provider");
    expect(codeForRefusal("consent_required")).toBe("consent_required");
    expect(codeForRefusal("not_permitted_for_record")).toBe("not_permitted");
    expect(codeForRefusal("check_failed")).toBe("check_failed");
  });
});
