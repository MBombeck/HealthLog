/**
 * The exact-origin grant grammar shared by every operator allowlist that opens
 * a private destination (`NIGHTSCOUT_PRIVATE_ORIGINS`,
 * `NOTIFICATION_PRIVATE_ORIGINS`).
 *
 * Two properties are pinned here and nowhere else:
 *
 *  1. A grant names one canonical `scheme://host[:port]` and nothing wider —
 *     no path, credentials, wildcard, suffix, sibling port or sub-host.
 *  2. A grant can never name loopback, the unspecified address, link-local or
 *     the cloud-metadata range. Those are refused at parse time when written
 *     as a literal, and the pinned dispatcher refuses them again when a
 *     listed DNS name resolves there (`safe-fetch-dispatcher.test.ts`).
 */
import { describe, expect, it, vi } from "vitest";

import {
  canonicalOrigin,
  describeGrantRejection,
  evaluateOriginGrant,
  parsePrivateOrigins,
  PRIVATE_ORIGIN_NOT_APPROVED_CODE,
  PRIVATE_ORIGIN_NOT_GRANTABLE_CODE,
  redactGrantEntry,
} from "../private-origin-policy";

describe("canonicalOrigin", () => {
  it("normalises case and drops a default port", () => {
    expect(canonicalOrigin("HTTPS://Gotify.Example.COM:443")).toBe(
      "https://gotify.example.com",
    );
    expect(canonicalOrigin("http://ntfy.lan:8080")).toBe(
      "http://ntfy.lan:8080",
    );
    expect(canonicalOrigin("https://[fd00::4]:8443")).toBe(
      "https://[fd00::4]:8443",
    );
  });

  it.each([
    ["credentials", "http://operator:secret@10.0.0.4:1337"],
    ["non-root path", "https://gotify.example.com/message"],
    ["query", "http://10.0.0.4:1337?token=secret"],
    ["fragment", "http://10.0.0.4:1337#admin"],
    ["wrong scheme", "ftp://10.0.0.4:1337"],
    ["wildcard", "https://*.gotify.lan"],
    ["suffix", ".gotify.lan"],
    ["malformed", "not an origin"],
  ])("refuses a %s as a grant", (_label, value) => {
    expect(canonicalOrigin(value)).toBeNull();
  });

  it.each([
    ["IPv4 unspecified", "http://0.0.0.0:8080"],
    ["link-local / metadata", "http://169.254.169.254"],
    ["IPv6 unspecified", "http://[::]:8080"],
    ["IPv6 link-local", "http://[fe80::1]:8080"],
    ["IPv4-mapped metadata", "http://[::ffff:169.254.169.254]"],
  ])("refuses %s as a grant", (_label, value) => {
    expect(canonicalOrigin(value)).toBeNull();
  });

  it("keeps loopback grantable: an exact loopback origin is a deliberate host-networking decision", () => {
    expect(canonicalOrigin("http://127.0.0.1:8080")).toBe(
      "http://127.0.0.1:8080",
    );
    expect(canonicalOrigin("http://127.10.20.30")).toBe("http://127.10.20.30");
    expect(canonicalOrigin("http://[::1]:8080")).toBe("http://[::1]:8080");
    expect(canonicalOrigin("http://localhost:1337")).toBe(
      "http://localhost:1337",
    );
    expect(canonicalOrigin("http://gotify.localhost")).toBe(
      "http://gotify.localhost",
    );
  });

  it("keeps mDNS and other reserved-looking names grantable when listed exactly", () => {
    // The input-time floor refuses `.local` and `.internal` unlisted; an
    // operator naming the exact origin is the override, and a loopback or
    // metadata answer is still dropped at dial time.
    expect(canonicalOrigin("http://gotify.local")).toBe("http://gotify.local");
    expect(canonicalOrigin("http://ntfy.internal:8080")).toBe(
      "http://ntfy.internal:8080",
    );
  });

  it("keeps RFC1918, CGNAT and ULA grantable — that is the point of the list", () => {
    expect(canonicalOrigin("http://10.0.0.4:1337")).toBe(
      "http://10.0.0.4:1337",
    );
    expect(canonicalOrigin("http://192.168.1.20")).toBe("http://192.168.1.20");
    expect(canonicalOrigin("http://172.16.0.9:8080")).toBe(
      "http://172.16.0.9:8080",
    );
    expect(canonicalOrigin("http://100.64.0.7")).toBe("http://100.64.0.7");
    expect(canonicalOrigin("http://[fd12:3456::1]:8080")).toBe(
      "http://[fd12:3456::1]:8080",
    );
  });
});

describe("parsePrivateOrigins", () => {
  it("parses a comma-separated setting into canonical exact origins", () => {
    const onInvalid = vi.fn();
    expect(
      parsePrivateOrigins(
        " http://10.0.0.4:1337, HTTPS://GOTIFY.LAN:443 ,https://[fd00::4]:8443 ",
        onInvalid,
      ),
    ).toEqual(
      new Set([
        "http://10.0.0.4:1337",
        "https://gotify.lan",
        "https://[fd00::4]:8443",
      ]),
    );
    expect(onInvalid).not.toHaveBeenCalled();
  });

  it("grants nothing for an empty setting", () => {
    const onInvalid = vi.fn();
    expect(parsePrivateOrigins(undefined, onInvalid)).toEqual(new Set());
    expect(parsePrivateOrigins("  ,  ", onInvalid)).toEqual(new Set());
    expect(onInvalid).not.toHaveBeenCalled();
  });

  it("hands every malformed entry to the caller, with a reason, and keeps the valid ones", () => {
    const onInvalid = vi.fn();
    expect(
      parsePrivateOrigins(
        "https://gotify.lan, https://*.lan, http://169.254.169.254, not an origin",
        onInvalid,
      ),
    ).toEqual(new Set(["https://gotify.lan"]));
    expect(onInvalid.mock.calls.map(([entry]) => entry)).toEqual([
      "https://*.lan",
      "http://169.254.169.254",
      "not an origin",
    ]);
    expect(onInvalid.mock.calls[1][1]).toMatch(/link-local.*cannot be granted/);
    expect(onInvalid.mock.calls[0][1]).toMatch(/one exact http\(s\) origin/);
  });

  it("never hands a query, fragment or userinfo to the caller (M3)", () => {
    const onInvalid = vi.fn();
    parsePrivateOrigins(
      "http://10.0.0.4/message?token=AbC123, http://user:pw@gotify.lan/, https://ntfy.lan/topic#frag",
      onInvalid,
    );
    const seen = onInvalid.mock.calls.map(([entry]) => entry);
    expect(seen).toEqual([
      "http://10.0.0.4/message",
      "http://gotify.lan/",
      "https://ntfy.lan/topic",
    ]);
    expect(JSON.stringify(onInvalid.mock.calls)).not.toMatch(
      /AbC123|token=|user:pw|#frag/,
    );
  });

  it("lets the caller turn a malformed entry into a throw", () => {
    expect(() =>
      parsePrivateOrigins("https://gotify.lan, junk", (entry) => {
        throw new Error(`bad entry: ${entry}`);
      }),
    ).toThrow("bad entry: junk");
  });
});

describe("evaluateOriginGrant", () => {
  const grants = new Set(["http://10.0.0.4:1337", "https://gotify.lan:8443"]);

  it("approves exactly the listed scheme, host and port", () => {
    expect(evaluateOriginGrant("http://10.0.0.4:1337", grants)).toEqual({
      allowed: true,
      canonicalOrigin: "http://10.0.0.4:1337",
      privateOriginApproved: true,
      reasonCode: null,
    });
  });

  it.each([
    ["scheme", "https://10.0.0.4:1337"],
    ["port", "http://10.0.0.4:8080"],
    ["neighbouring address", "http://10.0.0.40:1337"],
    ["sub-host", "https://sub.gotify.lan:8443"],
    ["sibling port on a listed name", "https://gotify.lan"],
  ])("refuses a %s that differs from the grant", (_label, origin) => {
    expect(evaluateOriginGrant(origin, grants)).toEqual({
      allowed: false,
      canonicalOrigin: origin,
      privateOriginApproved: false,
      reasonCode: PRIVATE_ORIGIN_NOT_APPROVED_CODE,
    });
  });

  it("keeps a public origin functional without any grant", () => {
    expect(evaluateOriginGrant("https://ntfy.sh", new Set())).toEqual({
      allowed: true,
      canonicalOrigin: "https://ntfy.sh",
      privateOriginApproved: false,
      reasonCode: null,
    });
  });

  it("refuses an unlisted private origin", () => {
    expect(evaluateOriginGrant("http://192.168.1.9:8080", grants)).toEqual({
      allowed: false,
      canonicalOrigin: "http://192.168.1.9:8080",
      privateOriginApproved: false,
      reasonCode: PRIVATE_ORIGIN_NOT_APPROVED_CODE,
    });
  });

  it("approves a listed loopback origin and refuses an unlisted one", () => {
    const loopbackGrants = new Set([
      "http://localhost:1337",
      "http://[::1]:8080",
    ]);
    expect(
      evaluateOriginGrant("http://localhost:1337", loopbackGrants),
    ).toEqual({
      allowed: true,
      canonicalOrigin: "http://localhost:1337",
      privateOriginApproved: true,
      reasonCode: null,
    });
    expect(
      evaluateOriginGrant("http://[::1]:8080", loopbackGrants),
    ).toMatchObject({ allowed: true, privateOriginApproved: true });
    for (const origin of [
      "http://localhost:1338",
      "http://127.0.0.1:1337",
      "http://[::1]:8081",
    ]) {
      expect(evaluateOriginGrant(origin, loopbackGrants)).toEqual({
        allowed: false,
        canonicalOrigin: origin,
        privateOriginApproved: false,
        reasonCode: PRIVATE_ORIGIN_NOT_APPROVED_CODE,
      });
    }
  });

  it.each([
    ["link-local / metadata", "http://169.254.169.254"],
    ["unspecified", "http://0.0.0.0:8080"],
    ["IPv6 link-local", "http://[fe80::1]:8080"],
    ["IPv6 unspecified", "http://[::]:8080"],
  ])(
    "answers %s with the not-grantable code, not a request to list it (M1)",
    (_label, origin) => {
      expect(evaluateOriginGrant(origin, grants)).toEqual({
        allowed: false,
        canonicalOrigin: origin,
        privateOriginApproved: false,
        reasonCode: PRIVATE_ORIGIN_NOT_GRANTABLE_CODE,
      });
    },
  );
});

describe("redactGrantEntry / describeGrantRejection", () => {
  it("keeps scheme and host, drops userinfo, query and fragment", () => {
    expect(redactGrantEntry("http://user:pw@gotify.lan/?token=x#y")).toBe(
      "http://gotify.lan/",
    );
    expect(redactGrantEntry("https://gotify.example.com")).toBe(
      "https://gotify.example.com",
    );
    expect(redactGrantEntry("not an origin?token=x")).toBe("not an origin");
  });

  it("names the never-grantable class apart from a grammar error", () => {
    expect(describeGrantRejection("http://169.254.169.254")).toMatch(
      /link-local.*cannot be granted/,
    );
    expect(describeGrantRejection("http://[fe80::1]:1337")).toMatch(
      /link-local/,
    );
    expect(describeGrantRejection("https://*.lan")).toMatch(/exact http/);
    expect(describeGrantRejection("http://10.0.0.4/path")).toMatch(
      /exact http/,
    );
  });
});
