/**
 * Emergency ("Notfalldaten") profile route against a real Postgres.
 *
 * The point of this file is the write half: a PATCH that reports success but
 * never lands looks exactly like one that did. So it PATCHes through the real
 * route, then reads the `user_health_profiles` row DIRECTLY and asserts the
 * columns changed — the plaintext enums by value, the encrypted contact column
 * by decrypting it back. Dropping any field from the handler's data builder
 * turns the matching assertion red.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

process.env.API_TOKEN_HMAC_KEY ??=
  "test-hmac-key-emergency-profile-integration-32-bytes-1234567890";
process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const USER_ID = "user-emergency-profile";

vi.mock("next/headers", async () => {
  const { cookieJar, headerJar } = await import("./mock-next-headers");
  return {
    headers: vi.fn(async () => ({
      get: (name: string) => headerJar.get(name.toLowerCase()) ?? null,
    })),
    cookies: vi.fn(async () => ({
      get: (name: string) => {
        const value = cookieJar.get(name);
        return value ? { name, value } : undefined;
      },
      set: (name: string, value: string) => cookieJar.set(name, value),
      delete: (name: string) => cookieJar.delete(name),
    })),
  };
});

async function loginAs(userId: string): Promise<void> {
  cookieJar.clear();
  headerJar.clear();
  const session = await getPrismaClient().session.create({
    data: { userId, expiresAt: new Date(Date.now() + 60 * 60 * 1000) },
  });
  cookieJar.set("healthlog_session", session.id);
}

function patch(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/anamnesis/emergency", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  await getPrismaClient().user.create({
    data: {
      id: USER_ID,
      username: "emergency-owner",
      email: "emergency-owner@example.test",
      timezone: "UTC",
    },
  });
});

describe("emergency profile route — the write lands in the row", () => {
  it("persists the enums by value and the contacts column as decryptable ciphertext", async () => {
    await loginAs(USER_ID);
    const { PATCH } = await import("@/app/api/anamnesis/emergency/route");
    const { decryptFromBytes } = await import("@/lib/ai/coach/bytes-codec");

    const CONTACTS = "ICE contact, reachable on the recorded number.";
    const res = await PATCH(
      patch({
        bloodType: "O_NEG",
        organDonor: "YES",
        advanceDirective: "EXISTS",
        contacts: CONTACTS,
      }),
    );
    expect(res.status).toBe(200);

    const row = await getPrismaClient().userHealthProfile.findUniqueOrThrow({
      where: { userId: USER_ID },
      select: {
        emergencyBloodType: true,
        organDonorStatus: true,
        advanceDirectiveStatus: true,
        emergencyContactsEncrypted: true,
        emergencyImplantsEncrypted: true,
      },
    });
    expect(row.emergencyBloodType).toBe("O_NEG");
    expect(row.organDonorStatus).toBe("YES");
    expect(row.advanceDirectiveStatus).toBe("EXISTS");
    // The column is genuinely ciphertext (not the plaintext), and it decrypts
    // back to exactly what was sent.
    expect(row.emergencyContactsEncrypted).not.toBeNull();
    expect(decryptFromBytes(row.emergencyContactsEncrypted!)).toBe(CONTACTS);
    // An omitted field stays untouched.
    expect(row.emergencyImplantsEncrypted).toBeNull();
  });

  it("reads the same values back through GET, and an emptied field clears its column", async () => {
    await loginAs(USER_ID);
    const { GET, PATCH } = await import("@/app/api/anamnesis/emergency/route");

    await PATCH(patch({ bloodType: "A_POS", contacts: "first note" }));

    const cleared = await PATCH(patch({ contacts: "" }));
    expect(cleared.status).toBe(200);

    const res = await GET();
    const body = (await res.json()) as {
      data: { bloodType: string | null; contacts: string | null };
    };
    expect(body.data.bloodType).toBe("A_POS");
    expect(body.data.contacts).toBeNull();

    const row = await getPrismaClient().userHealthProfile.findUniqueOrThrow({
      where: { userId: USER_ID },
      select: { emergencyContactsEncrypted: true },
    });
    expect(row.emergencyContactsEncrypted).toBeNull();
  });

  it("a select sent as null goes back to not recorded and leaves the others", async () => {
    // The card sends a cleared select as `null` (and leaves an untouched one
    // out). Until it did, a recorded blood type could be changed but never
    // removed.
    await loginAs(USER_ID);
    const { GET, PATCH } = await import("@/app/api/anamnesis/emergency/route");

    await PATCH(patch({ bloodType: "A_POS", organDonor: "YES" }));
    const cleared = await PATCH(patch({ bloodType: null }));
    expect(cleared.status).toBe(200);

    const row = await getPrismaClient().userHealthProfile.findUniqueOrThrow({
      where: { userId: USER_ID },
      select: { emergencyBloodType: true, organDonorStatus: true },
    });
    expect(row.emergencyBloodType).toBeNull();
    expect(row.organDonorStatus).toBe("YES");

    const body = (await (await GET()).json()) as {
      data: { bloodType: string | null; organDonor: string | null };
    };
    expect(body.data.bloodType).toBeNull();
    expect(body.data.organDonor).toBe("YES");
  });
});
