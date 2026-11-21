import { afterEach, describe, expect, it } from "vitest";

import { nextAttemptAfter, REMOTE_SUCCESS_INTERVAL_MS } from "../remote-fetch";
import {
  configuredWebdavPrivateOrigins,
  evaluateWebdavFolderUrl,
} from "../remote-origin";

const NOW = new Date("2026-11-21T12:00:00Z");
const MIN = 60_000;

afterEach(() => {
  delete process.env.HEALTH_CONNECT_WEBDAV_PRIVATE_ORIGINS;
});

describe("nextAttemptAfter", () => {
  it("waits six hours after a pass that found nothing new or imported", () => {
    for (const outcome of ["imported", "unchanged"] as const) {
      expect(nextAttemptAfter(outcome, 0, NOW).getTime() - NOW.getTime()).toBe(
        REMOTE_SUCCESS_INTERVAL_MS,
      );
    }
  });

  it("backs off from thirty minutes, doubling, up to a day", () => {
    const wait = (failures: number) =>
      (nextAttemptAfter("network", failures, NOW).getTime() - NOW.getTime()) /
      MIN;
    expect([1, 2, 3, 4].map(wait)).toEqual([30, 60, 120, 240]);
    expect(wait(20)).toBe(24 * 60);
  });

  it("retries a busy account in thirty minutes without counting a failure", () => {
    expect(nextAttemptAfter("busy", 5, NOW).getTime() - NOW.getTime()).toBe(
      30 * MIN,
    );
  });
});

describe("evaluateWebdavFolderUrl", () => {
  it("takes a public folder without configuration", () => {
    const target = evaluateWebdavFolderUrl(
      "https://cloud.example.com/remote.php/dav/files/me/Health/",
      configuredWebdavPrivateOrigins(),
    );
    expect(target).toMatchObject({
      allowed: true,
      folderUrl: "https://cloud.example.com/remote.php/dav/files/me/Health",
      privateOriginApproved: false,
    });
  });

  it("refuses a private folder unless its exact origin is granted", () => {
    const url = "http://192.168.1.20:8080/remote.php/dav/files/me";
    expect(
      evaluateWebdavFolderUrl(url, configuredWebdavPrivateOrigins()).allowed,
    ).toBe(false);
    process.env.HEALTH_CONNECT_WEBDAV_PRIVATE_ORIGINS =
      "http://192.168.1.20:8080";
    expect(
      evaluateWebdavFolderUrl(url, configuredWebdavPrivateOrigins()),
    ).toMatchObject({ allowed: true, privateOriginApproved: true });
    // A sibling port is not the granted origin.
    expect(
      evaluateWebdavFolderUrl(
        "http://192.168.1.20:9090/dav",
        configuredWebdavPrivateOrigins(),
      ).allowed,
    ).toBe(false);
  });

  it("refuses a public folder over plain http, the password would travel in clear", () => {
    expect(
      evaluateWebdavFolderUrl(
        "http://cloud.example.com/remote.php/dav/files/me",
        configuredWebdavPrivateOrigins(),
      ),
    ).toMatchObject({
      allowed: false,
      folderUrl: null,
      reasonCode: "https_required",
    });
    // An http grant names the scheme: it opens that private origin only.
    process.env.HEALTH_CONNECT_WEBDAV_PRIVATE_ORIGINS =
      "http://192.168.1.20:8080";
    expect(
      evaluateWebdavFolderUrl(
        "http://cloud.example.com/dav",
        configuredWebdavPrivateOrigins(),
      ).reasonCode,
    ).toBe("https_required");
  });

  it("refuses credentials, a query or a fragment in the address", () => {
    for (const url of [
      "https://me:secret@cloud.example.com/dav",
      "https://cloud.example.com/dav?x=1",
      "https://cloud.example.com/dav#f",
    ]) {
      expect(
        evaluateWebdavFolderUrl(url, configuredWebdavPrivateOrigins()),
      ).toMatchObject({ allowed: false, reasonCode: "invalid_origin" });
    }
  });
});
