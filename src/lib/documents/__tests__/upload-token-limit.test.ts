/**
 * The per-token upload ceiling for `documents:write` callers (#1038) is an
 * operator setting (`DOCUMENT_UPLOAD_LIMIT_PER_HOUR`), not a constant. Pins the
 * default, the clamp, and the fallback on garbage — the same contract as
 * `DOCUMENT_AI_LIMIT_PER_HOUR`.
 */
import { afterEach, describe, expect, it } from "vitest";

import { resolveDocumentUploadLimitPerHour } from "../upload-policy";

const ORIGINAL = process.env.DOCUMENT_UPLOAD_LIMIT_PER_HOUR;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.DOCUMENT_UPLOAD_LIMIT_PER_HOUR;
  else process.env.DOCUMENT_UPLOAD_LIMIT_PER_HOUR = ORIGINAL;
});

describe("resolveDocumentUploadLimitPerHour", () => {
  it("defaults to 120 when unset", () => {
    delete process.env.DOCUMENT_UPLOAD_LIMIT_PER_HOUR;
    expect(resolveDocumentUploadLimitPerHour()).toBe(120);
  });

  it("honours an operator value", () => {
    process.env.DOCUMENT_UPLOAD_LIMIT_PER_HOUR = "400";
    expect(resolveDocumentUploadLimitPerHour()).toBe(400);
  });

  it("falls back to the default on a non-number", () => {
    process.env.DOCUMENT_UPLOAD_LIMIT_PER_HOUR = "lots";
    expect(resolveDocumentUploadLimitPerHour()).toBe(120);
  });

  it("clamps to 1-1000", () => {
    process.env.DOCUMENT_UPLOAD_LIMIT_PER_HOUR = "0";
    expect(resolveDocumentUploadLimitPerHour()).toBe(1);
    process.env.DOCUMENT_UPLOAD_LIMIT_PER_HOUR = "50000";
    expect(resolveDocumentUploadLimitPerHour()).toBe(1000);
  });
});
