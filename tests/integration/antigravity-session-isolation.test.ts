/**
 * Antigravity session isolation, with real child processes.
 *
 * Each completion starts its own `agy acp` process. The fake `agy` in
 * `antigravity-fake-agy.ts` records how it was started, so these tests check
 * the arguments, the environment and the workspace the CLI really receives.
 */
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  AntigravityClient,
  antigravityProfileLocation,
} from "@/lib/ai/antigravity-client";
import { singleUserTurn } from "@/lib/ai/types";

import {
  installFakeAgy,
  type FakeAgy,
  type FakeAgyRecord,
} from "./antigravity-fake-agy";

const USER_A = "user-a";
const USER_B = "user-b";

function startsOf(records: FakeAgyRecord[]) {
  return records.filter(
    (r): r is Extract<FakeAgyRecord, { kind: "start" }> => r.kind === "start",
  );
}

describe("Antigravity session isolation", () => {
  let fake: FakeAgy;

  beforeAll(() => {
    fake = installFakeAgy();
    mkdirSync(path.join(fake.profileRoot, USER_A));
    mkdirSync(path.join(fake.profileRoot, USER_B));
  });

  afterAll(() => {
    fake.cleanup();
  });

  beforeEach(() => {
    fake.reset();
  });

  function clientFor(profileId: string) {
    const profile = antigravityProfileLocation(profileId);
    if (!profile) throw new Error(`no profile ${profileId}`);
    return new AntigravityClient({ profile });
  }

  it("runs each user's completion under that user's profile", async () => {
    const a = await clientFor(USER_A).generateCompletion(
      singleUserTurn({ system: "s", user: "hello" }),
    );
    const b = await clientFor(USER_B).generateCompletion(
      singleUserTurn({ system: "s", user: "hello" }),
    );

    expect(a.content).toBe(`profile:${USER_A}`);
    expect(b.content).toBe(`profile:${USER_B}`);

    // Each user's CLI state lives in that user's own folder: the per-user
    // gemini-dir is the isolation, so no second flag is passed.
    const starts = startsOf(fake.records());
    expect(starts.map((s) => s.geminiDir)).toEqual([
      path.join(fake.profileRoot, USER_A),
      path.join(fake.profileRoot, USER_B),
    ]);
  });

  it("does not pass application secrets to the agent", async () => {
    await clientFor(USER_A).generateCompletion(
      singleUserTurn({ system: "s", user: "hello" }),
    );

    const [start] = startsOf(fake.records());
    expect(start.envKeys).toContain("PATH");
    expect(start.envKeys).not.toContain("DATABASE_URL");
    expect(start.envKeys).not.toContain("ENCRYPTION_KEY");
    expect(start.envKeys).not.toContain("SESSION_SECRET");
  });

  it("refuses the permission request the agent sends", async () => {
    await clientFor(USER_A).generateCompletion(
      singleUserTurn({ system: "s", user: "hello" }),
    );

    const permission = fake.records().find((r) => r.kind === "permission");
    expect(permission).toEqual({
      kind: "permission",
      outcome: { outcome: "selected", optionId: "reject-once" },
    });
  });

  it("runs in an empty workspace that is removed after the call", async () => {
    await clientFor(USER_A).generateCompletion(
      singleUserTurn({ system: "s", user: "hello" }),
    );

    const [start] = startsOf(fake.records());
    expect(start.cwd).not.toBe(fake.profileRoot);
    expect(start.cwd.startsWith(fake.profileRoot)).toBe(false);
    expect(existsSync(start.cwd)).toBe(false);
  });

  it("does not start a profile that was never set up", () => {
    expect(antigravityProfileLocation("user-never-set-up")).toBeNull();
    expect(startsOf(fake.records())).toEqual([]);
  });

  it("does not resolve a profile id that escapes the profile root", () => {
    expect(antigravityProfileLocation("../user-a")).toBeNull();
    expect(antigravityProfileLocation("user-a/../user-b")).toBeNull();
    expect(startsOf(fake.records())).toEqual([]);
  });
});
