/**
 * One-time hints are put away on the account: `PATCH
 * /api/auth/me/dismissed-hints` stores the ids, `/api/auth/me` publishes them
 * as `dismissedHints`, a second session (another device) reads the same list,
 * restoring a family takes its members with it, and an unknown id is 422.
 *
 * `callRoute` checks every answer against the published contract.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { GET as readMe } from "@/app/api/auth/me/route";
import { PATCH as patchHints } from "@/app/api/auth/me/dismissed-hints/route";

import { callRoute, type RouteAuth } from "../kit/call-route";
import { makeSession, makeUser } from "../kit/factories";
import { getPrismaClient, truncateAllTables } from "./setup";

const prisma = getPrismaClient();

let phone: RouteAuth;
let laptop: RouteAuth;

beforeEach(async () => {
  await truncateAllTables(prisma);
  const user = await makeUser();
  phone = await makeSession(user);
  laptop = await makeSession(user);
});

function patch(body: unknown, auth: RouteAuth = phone) {
  return callRoute<{ dismissedHints: string[] }>(patchHints, {
    method: "PATCH",
    route: "/api/auth/me/dismissed-hints",
    body,
    auth,
  });
}

async function listOn(auth: RouteAuth) {
  const res = await callRoute<{ dismissedHints: string[] }>(readMe, {
    method: "GET",
    route: "/api/auth/me",
    auth,
  });
  expect(res.status).toBe(200);
  return res.data.dismissedHints;
}

describe("dismissed hints", () => {
  it("start empty", async () => {
    expect(await listOn(phone)).toEqual([]);
  });

  it("a hint closed on one device is closed on the other", async () => {
    const res = await patch({ dismiss: ["timeline-readiness"] });
    expect(res.status).toBe(200);
    expect(res.data.dismissedHints).toEqual(["timeline-readiness"]);
    expect(await listOn(laptop)).toEqual(["timeline-readiness"]);
  });

  it("is idempotent", async () => {
    await patch({ dismiss: ["ai-setup"] });
    const res = await patch({ dismiss: ["ai-setup"] }, laptop);
    expect(res.data.dismissedHints).toEqual(["ai-setup"]);
  });

  it("restoring a family brings back its members, and nothing else", async () => {
    await patch({
      dismiss: [
        "getting-started.profile",
        "getting-started.extra:visit",
        "getting-started",
        "i18n-banner.fr",
      ],
    });
    const res = await patch({ restore: ["getting-started"] });
    expect(res.data.dismissedHints).toEqual(["i18n-banner.fr"]);
  });

  it("refuses an unknown hint and an empty change", async () => {
    expect((await patch({ dismiss: ["not-a-hint"] })).status).toBe(422);
    expect((await patch({ dismiss: ["ai-setup.<script>"] })).status).toBe(422);
    expect((await patch({})).status).toBe(422);
    expect(await listOn(phone)).toEqual([]);
  });
});
