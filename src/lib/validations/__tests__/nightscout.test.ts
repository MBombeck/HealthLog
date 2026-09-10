import { describe, expect, it } from "vitest";

import * as nightscoutValidation from "../nightscout";

type NightscoutOriginVerdict = {
  allowed: boolean;
  canonicalOrigin: string | null;
  privateOriginApproved: boolean;
  reasonCode: "invalid_origin" | "private_origin_not_approved" | null;
};

type NightscoutPolicyModule = typeof nightscoutValidation & {
  parseNightscoutPrivateOrigins(raw: string | undefined): ReadonlySet<string>;
  evaluateNightscoutOrigin(
    value: string,
    privateOrigins: ReadonlySet<string>,
  ): NightscoutOriginVerdict;
};

const { parseNightscoutPrivateOrigins, evaluateNightscoutOrigin } =
  nightscoutValidation as NightscoutPolicyModule;

describe("NIGHTSCOUT_PRIVATE_ORIGINS", () => {
  it("parses a comma-separated server setting into canonical exact origins", () => {
    expect(
      parseNightscoutPrivateOrigins(
        " http://10.0.0.4:1337, HTTPS://CGM.LAN:443 ,https://[fd00::4]:8443 ",
      ),
    ).toEqual(
      new Set([
        "http://10.0.0.4:1337",
        "https://cgm.lan",
        "https://[fd00::4]:8443",
      ]),
    );
  });

  it("authorizes no private origin when the operator setting is empty", () => {
    expect(parseNightscoutPrivateOrigins(undefined)).toEqual(new Set());
    expect(parseNightscoutPrivateOrigins("  ,  ")).toEqual(new Set());

    expect(
      evaluateNightscoutOrigin(
        "http://10.0.0.4:1337",
        parseNightscoutPrivateOrigins(""),
      ),
    ).toEqual({
      allowed: false,
      canonicalOrigin: "http://10.0.0.4:1337",
      privateOriginApproved: false,
      reasonCode: "private_origin_not_approved",
    });
  });

  it.each([
    ["credentials", "http://operator:secret@10.0.0.4:1337"],
    ["non-root path", "http://10.0.0.4:1337/api/v1"],
    ["query", "http://10.0.0.4:1337?token=secret"],
    ["fragment", "http://10.0.0.4:1337#admin"],
    ["wrong scheme", "ftp://10.0.0.4:1337"],
    ["wildcard", "https://*.cgm.lan"],
    ["suffix", ".cgm.lan"],
    ["malformed", "not an origin"],
  ])("rejects a %s operator trust entry", (_label, value) => {
    expect(() => parseNightscoutPrivateOrigins(value)).toThrow();
  });
});

describe("Nightscout exact-origin policy", () => {
  const privateOrigins = new Set([
    "http://10.0.0.4:1337",
    "https://cgm.lan:8443",
  ]);

  it("keeps an ordinary canonical public origin functional", () => {
    expect(
      evaluateNightscoutOrigin("https://NS.EXAMPLE.COM:443", privateOrigins),
    ).toEqual({
      allowed: true,
      canonicalOrigin: "https://ns.example.com",
      privateOriginApproved: false,
      reasonCode: null,
    });
  });

  it("allows only the exact operator-approved private scheme, host, and port", () => {
    expect(
      evaluateNightscoutOrigin("http://10.0.0.4:1337", privateOrigins),
    ).toEqual({
      allowed: true,
      canonicalOrigin: "http://10.0.0.4:1337",
      privateOriginApproved: true,
      reasonCode: null,
    });

    for (const value of [
      "https://10.0.0.4:1337",
      "http://10.0.0.4:8080",
      "http://10.0.0.40:1337",
      "https://sub.cgm.lan:8443",
    ]) {
      expect(evaluateNightscoutOrigin(value, privateOrigins)).toMatchObject({
        allowed: false,
        privateOriginApproved: false,
        reasonCode: "private_origin_not_approved",
      });
    }
  });

  it.each([
    ["credentials", "http://operator:secret@10.0.0.4:1337"],
    ["path", "http://10.0.0.4:1337/api/v1"],
    ["query", "http://10.0.0.4:1337?token=secret"],
    ["fragment", "http://10.0.0.4:1337#admin"],
  ])("rejects a %s even when its bare origin is approved", (_label, value) => {
    expect(evaluateNightscoutOrigin(value, privateOrigins)).toEqual({
      allowed: false,
      canonicalOrigin: null,
      privateOriginApproved: false,
      reasonCode: "invalid_origin",
    });
  });

  it("keeps a loopback Nightscout grant working exactly as before", () => {
    // A host-networking self-host lists http://localhost:1337; the shared
    // floor must not turn that into a failed sync on upgrade.
    expect(parseNightscoutPrivateOrigins("http://localhost:1337")).toEqual(
      new Set(["http://localhost:1337"]),
    );
    expect(
      evaluateNightscoutOrigin(
        "http://localhost:1337",
        parseNightscoutPrivateOrigins("http://localhost:1337"),
      ),
    ).toMatchObject({ allowed: true, privateOriginApproved: true });
    expect(
      parseNightscoutPrivateOrigins("http://127.0.0.1:1337, http://[::1]:1337"),
    ).toEqual(new Set(["http://127.0.0.1:1337", "http://[::1]:1337"]));
  });

  it("names the entry and the reason when a metadata grant is listed, without its token (M2)", () => {
    let caught: unknown;
    try {
      parseNightscoutPrivateOrigins(
        "https://cgm.lan, http://169.254.169.254:1337/?token=SECRET123",
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect((caught as Error).name).toBe("NightscoutOriginConfigError");
    expect(message).toContain(
      'NIGHTSCOUT_PRIVATE_ORIGINS entry "http://169.254.169.254:1337/"',
    );
    expect(message).toMatch(/link-local.*cannot be granted/);
    expect(message).not.toContain("SECRET123");
    expect(message).not.toContain("token=");
  });
});
