import { describe, expect, it } from "vitest";

import { errorCodeToI18nKey } from "@/components/insights/coach-panel/coach-error-key";

import { coachErrorCode } from "../document-chat-sheet";

describe("the guardian's document chat reads errors in the Coach's words", () => {
  it("maps the document endpoint's stream codes onto the Coach's", () => {
    expect(coachErrorCode("documents.chat.provider.none")).toBe(
      "coach.provider.none",
    );
    expect(
      errorCodeToI18nKey(coachErrorCode("documents.chat.provider.none")),
    ).toBe("insights.coach.errorNoProvider");
    expect(
      errorCodeToI18nKey(coachErrorCode("documents.chat.budget.exceeded")),
    ).toBe("insights.coach.dailyLimitBody");
  });

  it("leaves every other code as it is", () => {
    expect(coachErrorCode("consent.ai.required")).toBe("consent.ai.required");
    expect(coachErrorCode("coach.network")).toBe("coach.network");
  });
});
