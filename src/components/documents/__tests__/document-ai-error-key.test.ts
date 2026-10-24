/**
 * A refused document read names its reason. Before the capability refusals
 * had codes of their own, a missing consent, the operator's switch and a
 * missing provider all fell through to the generic "couldn't read" line, and
 * the one thing the reader could fix (the consent) was never said.
 */
import { describe, expect, it } from "vitest";

import { ApiError } from "@/lib/api/api-fetch";

import { documentAiErrorKey } from "../use-document-assist";

const refusal = (errorCode: string, status = 403) =>
  new ApiError("refused", status, { errorCode });

describe("documentAiErrorKey", () => {
  it("maps each capability refusal to its own sentence", () => {
    expect(documentAiErrorKey(refusal("consent.ai.required"))).toBe(
      "documents.assist.errorConsent",
    );
    expect(documentAiErrorKey(refusal("assistant.disabled.documentAi"))).toBe(
      "documents.assist.errorUnavailable",
    );
    expect(documentAiErrorKey(refusal("assistant.disabled.enabled"))).toBe(
      "documents.assist.errorUnavailable",
    );
    expect(documentAiErrorKey(refusal("ai.record.notPermitted"))).toBe(
      "documents.assist.errorUnavailable",
    );
    expect(documentAiErrorKey(refusal("ai.provider.none", 422))).toBe(
      "documents.assist.errorProvider",
    );
  });

  it("keeps the existing route codes", () => {
    expect(
      documentAiErrorKey(refusal("documents.inbound.budgetExceeded", 429)),
    ).toBe("documents.assist.errorBudget");
    expect(documentAiErrorKey(refusal("something.else", 500))).toBe(
      "documents.assist.errorGeneric",
    );
  });

  it("says the output limit stopped the read, not that the copy was unreadable", () => {
    expect(
      documentAiErrorKey(refusal("documents.inbound.outputLimit", 422)),
    ).toBe("documents.assist.errorOutputLimit");
  });
});
