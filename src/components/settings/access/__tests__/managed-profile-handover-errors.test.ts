/**
 * v1.42 (#959) — the sentences a refused handover mint and a refused claim
 * map to. Pure, so each arm is pinned without driving a browser.
 */
import { describe, expect, it } from "vitest";

import { handoverCreateErrorKey } from "@/components/settings/access/managed-profile-handover";
import { claimErrorKey } from "@/components/auth/claim-profile";
import { ApiError } from "@/lib/api/api-fetch";

describe("handoverCreateErrorKey", () => {
  it.each([
    [
      new ApiError("x", 401, { errorCode: "auth.stepup.required" }),
      "recordSharing.managed.errorStepUp",
    ],
    [
      new ApiError("x", 401, { errorCode: "auth.stepup.mfa_not_enrolled" }),
      "recordSharing.managed.errorMfaRequired",
    ],
    [
      new ApiError("x", 403, {
        errorCode: "profile_claim.oidc_only_unsupported",
      }),
      "recordSharing.managed.handover.oidcOnly",
    ],
    [new ApiError("x", 404, {}), "recordSharing.actionError.profileNotFound"],
    [
      new ApiError("x", 422, {
        errorCode: "managed_profile.handover.unknown_guardian",
      }),
      "recordSharing.managed.handover.errorRosterChanged",
    ],
    [new ApiError("x", 422, {}), "recordSharing.managed.errorInvalid"],
    [new ApiError("x", 429, {}), "recordSharing.managed.errorRateLimit"],
    [new ApiError("x", 500, {}), "recordSharing.managed.handover.errorFailed"],
    [new Error("offline"), "recordSharing.managed.errorOffline"],
  ])("maps %o", (err, key) => {
    expect(handoverCreateErrorKey(err)).toBe(key);
  });
});

describe("claimErrorKey", () => {
  it.each([
    [new ApiError("x", 404, {}), "auth.claim.invalid"],
    [
      new ApiError("x", 409, { errorCode: "profile_claim.taken" }),
      "auth.claim.errorTaken",
    ],
    [
      new ApiError("x", 409, { errorCode: "auth.already_authenticated" }),
      "auth.claim.signedInTitle",
    ],
    [new ApiError("x", 403, {}), "auth.claim.oidcOnly"],
    [new ApiError("x", 429, {}), "auth.claim.errorRateLimit"],
    [new ApiError("x", 500, {}), "auth.claim.errorFailed"],
    [new Error("offline"), "auth.claim.errorOffline"],
  ])("maps %o", (err, key) => {
    expect(claimErrorKey(err)).toBe(key);
  });
});
