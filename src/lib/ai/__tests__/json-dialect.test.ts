import { describe, expect, it } from "vitest";

import { isResponseFormatRejection } from "../json-dialect";

describe("isResponseFormatRejection", () => {
  it("reads a complaint about response_format as a JSON-mode rejection", () => {
    expect(
      isResponseFormatRejection(400, "Unsupported value: 'response_format'"),
    ).toBe(true);
    expect(isResponseFormatRejection(422, "unknown parameter")).toBe(true);
  });

  it("does not read a complaint about reasoning_effort as one", () => {
    expect(
      isResponseFormatRejection(
        400,
        "Unrecognized request argument supplied: reasoning_effort",
      ),
    ).toBe(false);
    expect(
      isResponseFormatRejection(400, "unknown field `reasoning effort`"),
    ).toBe(false);
  });

  it("still flips when both fields are named", () => {
    expect(
      isResponseFormatRejection(
        400,
        "unknown parameters: response_format, reasoning_effort",
      ),
    ).toBe(true);
  });

  it("ignores server errors", () => {
    expect(isResponseFormatRejection(500, "response_format")).toBe(false);
  });
});
