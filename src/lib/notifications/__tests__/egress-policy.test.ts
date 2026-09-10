/**
 * `NOTIFICATION_PRIVATE_ORIGINS` (#947): the operator grant for a webhook or
 * ntfy target on a private network.
 *
 * What is pinned here: the variable is read from the server environment and
 * nowhere else, a malformed entry is logged once and grants nothing, a listed
 * origin approves exactly itself, and a target that is not listed keeps the
 * public floor it always had. The dial-time behaviour of an approved origin
 * (pinned resolver, redirect ban, loopback floor) is proven in
 * `safe-fetch.test.ts` and `safe-fetch-dispatcher.test.ts`; the senders'
 * use of the verdict in their own suites.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  configuredNotificationPrivateOrigins,
  evaluateNotificationTarget,
  isAllowedNotificationTarget,
} from "../egress-policy";

const ORIGINAL = process.env.NOTIFICATION_PRIVATE_ORIGINS;

beforeEach(() => {
  delete process.env.NOTIFICATION_PRIVATE_ORIGINS;
});

afterEach(() => {
  vi.restoreAllMocks();
  if (ORIGINAL === undefined) {
    delete process.env.NOTIFICATION_PRIVATE_ORIGINS;
  } else {
    process.env.NOTIFICATION_PRIVATE_ORIGINS = ORIGINAL;
  }
});

describe("configuredNotificationPrivateOrigins", () => {
  it("grants nothing when the variable is unset or blank", () => {
    expect(configuredNotificationPrivateOrigins()).toEqual(new Set());
    process.env.NOTIFICATION_PRIVATE_ORIGINS = " , ";
    expect(configuredNotificationPrivateOrigins()).toEqual(new Set());
  });

  it("parses exact origins and follows a changed value", () => {
    process.env.NOTIFICATION_PRIVATE_ORIGINS =
      "https://gotify.example.com, http://ntfy.lan:8080";
    expect(configuredNotificationPrivateOrigins()).toEqual(
      new Set(["https://gotify.example.com", "http://ntfy.lan:8080"]),
    );

    process.env.NOTIFICATION_PRIVATE_ORIGINS = "http://10.0.0.5:8080";
    expect(configuredNotificationPrivateOrigins()).toEqual(
      new Set(["http://10.0.0.5:8080"]),
    );
  });

  it("logs a malformed entry once, skips it, and keeps the valid ones", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.NOTIFICATION_PRIVATE_ORIGINS =
      "https://gotify.lan, https://*.lan, http://127.0.0.1:8080";

    expect(configuredNotificationPrivateOrigins()).toEqual(
      new Set(["https://gotify.lan"]),
    );
    expect(configuredNotificationPrivateOrigins()).toEqual(
      new Set(["https://gotify.lan"]),
    );

    // One line per malformed entry, written on the first parse only.
    expect(warn).toHaveBeenCalledTimes(2);
    const lines = warn.mock.calls.map((call) => String(call[0]));
    expect(lines[0]).toContain("NOTIFICATION_PRIVATE_ORIGINS");
    expect(lines[0]).toContain("https://*.lan");
    expect(lines[1]).toContain("http://127.0.0.1:8080");
  });

  it("never widens on a wholly malformed value", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.NOTIFICATION_PRIVATE_ORIGINS = "10.0.0.0/8, *.lan, true";
    expect(configuredNotificationPrivateOrigins()).toEqual(new Set());
  });
});

describe("evaluateNotificationTarget", () => {
  it("approves a target under a listed origin, path and all", () => {
    process.env.NOTIFICATION_PRIVATE_ORIGINS = "https://gotify.example.com";
    expect(
      evaluateNotificationTarget("https://gotify.example.com/message?token=x"),
    ).toEqual({
      allowed: true,
      canonicalOrigin: "https://gotify.example.com",
      privateOriginApproved: true,
      reasonCode: null,
    });
  });

  it("approves a listed literal private address the input-time floor would refuse", () => {
    process.env.NOTIFICATION_PRIVATE_ORIGINS = "http://10.0.0.5:8080";
    expect(evaluateNotificationTarget("http://10.0.0.5:8080/message")).toEqual({
      allowed: true,
      canonicalOrigin: "http://10.0.0.5:8080",
      privateOriginApproved: true,
      reasonCode: null,
    });
    expect(isAllowedNotificationTarget("http://10.0.0.5:8080/message")).toBe(
      true,
    );
  });

  it.each([
    ["sibling port", "http://10.0.0.5:9000/message"],
    ["other scheme", "https://10.0.0.5:8080/message"],
    ["neighbouring address", "http://10.0.0.6:8080/message"],
    ["sub-host of a listed name", "https://push.gotify.example.com/message"],
    ["unlisted private literal", "http://192.168.1.9/message"],
  ])("refuses a %s: a grant names one origin only", (_label, url) => {
    process.env.NOTIFICATION_PRIVATE_ORIGINS =
      "http://10.0.0.5:8080, https://gotify.example.com";
    expect(evaluateNotificationTarget(url)).toMatchObject({
      allowed: false,
      privateOriginApproved: false,
      reasonCode: "private_origin_not_approved",
    });
    expect(isAllowedNotificationTarget(url)).toBe(false);
  });

  it("keeps a public target functional and unapproved (the pin stays on)", () => {
    process.env.NOTIFICATION_PRIVATE_ORIGINS = "https://gotify.example.com";
    expect(evaluateNotificationTarget("https://ntfy.sh/topic")).toEqual({
      allowed: true,
      canonicalOrigin: "https://ntfy.sh",
      privateOriginApproved: false,
      reasonCode: null,
    });
  });

  it("keeps the raw-string floor: an octal loopback spelling is refused, not parsed", () => {
    expect(
      evaluateNotificationTarget("http://0177.0.0.1/message"),
    ).toMatchObject({
      allowed: false,
      reasonCode: "private_origin_not_approved",
    });
  });

  it("refuses an unparseable target as invalid", () => {
    expect(evaluateNotificationTarget("not a url")).toEqual({
      allowed: false,
      canonicalOrigin: null,
      privateOriginApproved: false,
      reasonCode: "invalid_origin",
    });
    expect(
      evaluateNotificationTarget("ftp://gotify.lan/message"),
    ).toMatchObject({ allowed: false, reasonCode: "invalid_origin" });
  });

  it("lets an unlisted private DNS name through to the pinned resolver, as before", () => {
    // Nothing widens and nothing narrows for a name the operator did not
    // list: input time cannot tell gotify.lan from a public name, so the
    // verdict is the same as before #947 and the connect-time pin decides.
    expect(evaluateNotificationTarget("https://gotify.lan/message")).toEqual({
      allowed: true,
      canonicalOrigin: "https://gotify.lan",
      privateOriginApproved: false,
      reasonCode: null,
    });
  });
});
