import { beforeEach, describe, expect, it } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";
import { acceptGrant, inviteGrant } from "@/lib/sharing/grants";
import { grantCoversDomain } from "@/lib/sharing/grant-access";
import { SHARE_DOMAINS } from "@/lib/sharing/scope";

let counter = 0;

async function makeUser(label: string) {
  const suffix = `${label}-${counter++}`;
  return getPrismaClient().user.create({
    data: {
      username: `scope-route-${suffix}`,
      email: `scope-route-${suffix}@example.test`,
      timezone: "Europe/Berlin",
    },
  });
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
});

describe("scoped sharing route contract", () => {
  it("persists the closed route-family set and excludes record-wide routes", async () => {
    expect(SHARE_DOMAINS.length).toBeGreaterThan(0);
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");

    const invitation = await inviteGrant({
      grantorId: owner.id,
      granteeId: delegate.id,
      access: "READ",
      scope: [...SHARE_DOMAINS],
    });
    const accepted = await acceptGrant({
      grantId: invitation.id,
      granteeId: delegate.id,
    });
    const stored = await getPrismaClient().accountGrant.findUniqueOrThrow({
      where: { id: accepted.id },
    });

    expect(stored.scopeJson).toEqual([...SHARE_DOMAINS]);
    for (const domain of SHARE_DOMAINS) {
      expect(grantCoversDomain(stored, domain)).toBe(true);
    }
    expect(grantCoversDomain(stored, "record")).toBe(false);
  });
});
