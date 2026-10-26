/**
 * Typed fixture factories for tests that run against the real database.
 *
 * Every factory writes through the application's Prisma client and returns
 * the stored row, so a fixture has the shape production stores, checked by
 * the compiler: a renamed or retyped column is a type error here, once, and
 * not a silent mismatch in a hundred hand-written row literals cast past the
 * type checker. Overrides are the Prisma create input for that model, so a
 * test names only what it is about and takes a valid default for the rest.
 *
 * Credentials are minted the way the server mints them: a session through
 * `createSession` and a Bearer token through `issueApiToken`, so a fixture
 * cannot drift into a shape the authentication path no longer accepts.
 *
 * Only for files under `tests/integration/`; importing this anywhere else
 * opens a connection to whatever `DATABASE_URL` points at.
 */
import { randomBytes } from "node:crypto";

import type {
  AccountGrant,
  Medication,
  MedicationSchedule,
  Measurement,
  Prisma,
  User,
  Workout,
} from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { createSession } from "@/lib/auth/session";
import { sessionCookieName } from "@/lib/auth/session-cookie";
import { issueApiToken } from "@/lib/auth/issue-token";

import { cookieJar } from "../integration/mock-next-headers";

let counter = 0;

/** A short unique suffix, so fixtures never collide on a unique column. */
export function uniqueSuffix(): string {
  counter += 1;
  return `${counter.toString(36)}${randomBytes(3).toString("hex")}`;
}

type UserOverrides = Partial<Prisma.UserUncheckedCreateInput>;

/**
 * An onboarded account with a password-less sign-in identity. Onboarding is
 * marked complete because an account that has not finished it is redirected
 * by the proxy and refused by a handful of write routes; a test about
 * onboarding sets `onboardingCompletedAt: null` itself.
 */
export async function makeUser(overrides: UserOverrides = {}): Promise<User> {
  const suffix = uniqueSuffix();
  return prisma.user.create({
    data: {
      username: `user-${suffix}`,
      email: `user-${suffix}@example.test`,
      onboardingCompletedAt: new Date("2026-01-01T00:00:00Z"),
      ...overrides,
    },
  });
}

/** An administrator account; admin routes also need a cookie session. */
export async function makeAdmin(overrides: UserOverrides = {}): Promise<User> {
  return makeUser({ role: "ADMIN", ...overrides });
}

export interface SessionFixture {
  kind: "session";
  userId: string;
  sessionId: string;
  /** The cookie value: the secret, never stored, exactly as a browser holds it. */
  cookie: string;
}

/**
 * A browser session minted by the real `createSession`. The secret is read
 * off the cookie the function sets, and the jar is left as it was found, so
 * minting a second session for another account does not sign the first one
 * out of a request in flight.
 */
export async function makeSession(
  user: Pick<User, "id">,
  options: { mfaVerifiedAt?: Date | null } = {},
): Promise<SessionFixture> {
  const before = new Map(cookieJar);
  const sessionId = await createSession(
    user.id,
    false,
    "203.0.113.10",
    "healthlog-kit",
    options.mfaVerifiedAt ?? null,
  );
  const cookie = cookieJar.get(sessionCookieName());
  cookieJar.clear();
  for (const [name, value] of before) cookieJar.set(name, value);
  if (!cookie) {
    throw new Error("createSession did not set the session cookie");
  }
  return { kind: "session", userId: user.id, sessionId, cookie };
}

export interface BearerFixture {
  kind: "bearer";
  userId: string;
  tokenId: string;
  /** The raw `hlk_…` value, which the server stores only as an HMAC. */
  token: string;
  permissions: string[];
}

/** A Bearer token minted by the real `issueApiToken`. Wildcard by default. */
export async function makeToken(
  user: Pick<User, "id">,
  options: {
    permissions?: string[];
    name?: string;
    expiresInDays?: number;
  } = {},
): Promise<BearerFixture> {
  const permissions = options.permissions ?? ["*"];
  const issued = await issueApiToken({
    userId: user.id,
    name: options.name ?? `kit-${uniqueSuffix()}`,
    permissions,
    expiresInDays: options.expiresInDays,
  });
  return {
    kind: "bearer",
    userId: user.id,
    tokenId: issued.tokenId,
    token: issued.token,
    permissions,
  };
}

export async function makeMeasurement(
  user: Pick<User, "id">,
  overrides: Partial<
    Omit<Prisma.MeasurementUncheckedCreateInput, "userId">
  > = {},
): Promise<Measurement> {
  return prisma.measurement.create({
    data: {
      userId: user.id,
      type: "WEIGHT",
      value: 72.5,
      unit: "kg",
      measuredAt: new Date("2026-03-02T07:30:00Z"),
      ...overrides,
    },
  });
}

export async function makeMedication(
  user: Pick<User, "id">,
  overrides: Partial<
    Omit<Prisma.MedicationUncheckedCreateInput, "userId">
  > = {},
  schedules: ReadonlyArray<
    Partial<Omit<Prisma.MedicationScheduleUncheckedCreateInput, "medicationId">>
  > = [{}],
): Promise<Medication & { schedules: MedicationSchedule[] }> {
  return prisma.medication.create({
    data: {
      userId: user.id,
      name: `Medication ${uniqueSuffix()}`,
      dose: "10mg",
      ...overrides,
      schedules: {
        create: schedules.map((schedule) => ({
          windowStart: "08:00",
          windowEnd: "10:00",
          ...schedule,
        })),
      },
    },
    include: { schedules: true },
  });
}

export async function makeWorkout(
  user: Pick<User, "id">,
  overrides: Partial<Omit<Prisma.WorkoutUncheckedCreateInput, "userId">> = {},
): Promise<Workout> {
  const startedAt = new Date("2026-03-02T17:00:00Z");
  return prisma.workout.create({
    data: {
      userId: user.id,
      sportType: "running",
      startedAt,
      endedAt: new Date(startedAt.getTime() + 30 * 60 * 1000),
      durationSec: 30 * 60,
      ...overrides,
    },
  });
}

/**
 * A grant from `grantor` to `grantee`, accepted unless the override says
 * otherwise. Read access by default; `access: "WRITE"` for a delegate who
 * edits.
 */
export async function makeGrant(
  grantor: Pick<User, "id">,
  grantee: Pick<User, "id">,
  overrides: Partial<
    Omit<Prisma.AccountGrantUncheckedCreateInput, "grantorId" | "granteeId">
  > = {},
): Promise<AccountGrant> {
  return prisma.accountGrant.create({
    data: {
      grantorId: grantor.id,
      granteeId: grantee.id,
      acceptedAt: new Date(),
      ...overrides,
    },
  });
}
