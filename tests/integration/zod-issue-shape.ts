/**
 * The shape of one sanitised issue in a 422 `details.issues[]`
 * (`SanitisedZodIssue` in `src/lib/api/zod-issue-fields.ts`). Beside its
 * path, code and message an issue may name the rejected key names and the
 * bounds the schema declares; both come from the schema, never from the
 * request. Nothing else may appear, `params` least of all, since it can echo
 * what the caller sent.
 */
import { expect } from "vitest";

const SANITISED_ISSUE_KEYS = [
  "code",
  "inclusive",
  "keys",
  "maximum",
  "maximumInclusive",
  "message",
  "minimum",
  "minimumInclusive",
  "origin",
  "path",
];

export function expectSanitisedIssue(issue: object): void {
  expect(issue).not.toHaveProperty("params");
  for (const key of Object.keys(issue)) {
    expect(SANITISED_ISSUE_KEYS).toContain(key);
  }
}
