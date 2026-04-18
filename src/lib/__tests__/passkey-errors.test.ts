import { describe, it, expect } from "vitest";
import { describePasskeyError } from "../passkey-errors";

function domException(name: string, message = ""): Error {
  const err = new Error(message);
  err.name = name;
  return err;
}

describe("describePasskeyError", () => {
  it("returns generic failure for non-Error inputs", () => {
    expect(describePasskeyError(undefined)).toEqual({
      key: "settings.passkeyRegistrationFailed",
    });
    expect(describePasskeyError("just a string")).toEqual({
      key: "settings.passkeyRegistrationFailed",
    });
  });

  it("maps NotAllowedError to cancelled (the common cancel/timeout case)", () => {
    expect(describePasskeyError(domException("NotAllowedError"))).toEqual({
      key: "settings.passkeyRegistrationCancelled",
    });
  });

  it("maps InvalidStateError to already-registered", () => {
    expect(describePasskeyError(domException("InvalidStateError"))).toEqual({
      key: "settings.passkeyAlreadyRegistered",
    });
  });

  it("maps NotSupportedError to not-supported", () => {
    expect(describePasskeyError(domException("NotSupportedError"))).toEqual({
      key: "settings.passkeyNotSupported",
    });
  });

  it("maps SecurityError to security-blocked", () => {
    expect(describePasskeyError(domException("SecurityError"))).toEqual({
      key: "settings.passkeySecurityBlocked",
    });
  });

  it("maps AbortError to timeout", () => {
    expect(describePasskeyError(domException("AbortError"))).toEqual({
      key: "settings.passkeyTimeout",
    });
  });

  it("maps SimpleWebAuthn ERROR_INVALID_RP_ID to security-blocked", () => {
    const err = new Error("bad rp");
    (err as Error & { code?: string }).code = "ERROR_INVALID_RP_ID";
    expect(describePasskeyError(err)).toEqual({
      key: "settings.passkeySecurityBlocked",
    });
  });

  it("falls back to unknown with a message param", () => {
    const result = describePasskeyError(new Error("mystery failure"));
    expect(result.key).toBe("settings.passkeyUnknownError");
    expect(result.params).toEqual({ message: "mystery failure" });
  });
});
