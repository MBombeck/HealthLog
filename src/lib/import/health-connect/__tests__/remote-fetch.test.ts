import { afterEach, describe, expect, it } from "vitest";

import {
  nextAttemptAfter,
  REMOTE_FAILURE,
  REMOTE_SUCCESS_INTERVAL_MS,
  runWithinBudget,
} from "../remote-fetch";
import {
  configuredWebdavPrivateOrigins,
  evaluateWebdavFolderUrl,
} from "../remote-origin";

const NOW = new Date("2026-11-21T12:00:00Z");
const MIN = 60_000;

afterEach(() => {
  delete process.env.HEALTH_CONNECT_WEBDAV_PRIVATE_ORIGINS;
});

describe("the ledger reading of a failed fetch", () => {
  it("asks for a new password on a refusal and retries the rest", () => {
    const kinds = Object.fromEntries(
      Object.entries(REMOTE_FAILURE).map(([outcome, f]) => [outcome, f.kind]),
    );
    expect(kinds).toEqual({
      unauthorized: "reauth_required",
      not_found: "persistent",
      redirected: "persistent",
      invalid_origin: "persistent",
      private_origin_not_approved: "persistent",
      too_large: "persistent",
      upstream_error: "transient",
      timeout: "transient",
      network: "transient",
      no_worker: "transient",
    });
  });
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

describe("runWithinBudget", () => {
  it("moves the other folders past one that hangs", async () => {
    let release: () => void = () => {};
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    const finished: string[] = [];
    const run = runWithinBudget(
      ["slow", "a", "b", "c", "d"],
      { concurrency: 2, deadline: Number.POSITIVE_INFINITY },
      async (item) => {
        if (item === "slow") await slow;
        finished.push(item);
        return item;
      },
    );
    // Everything else is done while the slow one still holds its lane.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(finished).toEqual(["a", "b", "c", "d"]);
    release();
    expect(await run).toEqual(["a", "b", "c", "d", "slow"]);
  });

  it("never runs more than the concurrency at once", async () => {
    let running = 0;
    let peak = 0;
    await runWithinBudget(
      Array.from({ length: 12 }, (_, i) => i),
      { concurrency: 4, deadline: Number.POSITIVE_INFINITY },
      async () => {
        running++;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 1));
        running--;
      },
    );
    expect(peak).toBe(4);
  });

  it("starts nothing once the deadline has passed and leaves the rest", async () => {
    let clock = 0;
    const ran = await runWithinBudget(
      [1, 2, 3, 4, 5],
      { concurrency: 1, deadline: 3, now: () => clock },
      async (item) => {
        clock++;
        return item;
      },
    );
    expect(ran).toEqual([1, 2, 3]);
  });
});
