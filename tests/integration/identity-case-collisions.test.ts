/**
 * An identity held in another case is the same identity.
 *
 * Migration 0517 put the unique keys on `lower(email)` and `lower(username)`
 * and left existing spellings as they were. A check that compares the column
 * exactly then says "free" for a name the key refuses:
 *
 *   1. A first single sign-on login derives its username from the address.
 *      With `alice` on file, `Alice@…` derived `Alice`, the insert failed on
 *      the key, and the callback answered `oidc_failed` on every retry.
 *   2. An address change onto `anna@example.com` while another account holds
 *      `Anna@Example.com` found nothing, and the write failed with 500
 *      instead of the published 409.
 *
 * Mutations that must turn these red: compare exactly again in
 * `provision` (`resolve-account.ts`) or in `applyProfileUpdate`.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { applyProfileUpdate } from "@/lib/auth/profile-update";
import { resolveOidcAccount } from "@/lib/auth/oidc-callback/resolve-account";

import { getPrismaClient, truncateAllTables } from "./setup";

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
});

describe("identities that differ only in case", () => {
  it("provisions a first SSO login whose name is held in another case", async () => {
    const prisma = getPrismaClient();
    await prisma.user.create({
      data: { username: "alice", email: "alice@home.test", role: "ADMIN" },
    });

    const resolution = await resolveOidcAccount({
      issuer: "https://idp.example.test",
      sub: "sub-alice-2",
      email: "Alice@corp.example",
      emailVerified: true,
      ip: "127.0.0.1",
    });

    expect(resolution.kind).toBe("user");
    if (resolution.kind !== "user") return;
    expect(resolution.user.username.toLowerCase()).toBe("alice1");
    expect(resolution.user.role).toBe("USER");
    expect(await prisma.user.count()).toBe(2);
  });

  it("answers 409 for an address held in another case", async () => {
    const prisma = getPrismaClient();
    // Written as typed, the way accounts before 0517 hold their address.
    await prisma.$executeRaw`
      INSERT INTO "users" ("id", "username", "email", "role", "updated_at")
      VALUES ('holder', 'holder', 'Anna@Example.com', 'USER', now())`;
    const mover = await prisma.user.create({
      data: { username: "mover", email: "mover@example.com" },
    });

    const result = await applyProfileUpdate(
      mover.id,
      { email: "anna@example.com" },
      null,
      { authorizeEmailChange: async () => "ok" },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);
    expect(result.errorCode).toBe("profile.update.emailInUse");
    const after = await prisma.user.findUniqueOrThrow({
      where: { id: mover.id },
    });
    expect(after.email).toBe("mover@example.com");
  });
});
