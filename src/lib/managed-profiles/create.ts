import { randomBytes } from "node:crypto";

import { Prisma } from "@/generated/prisma/client";
import type { AccountGrant, User } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";

const USERNAME_ATTEMPTS = 4;

export interface CreateManagedProfileInput {
  creatorId: string;
  displayName: string;
  dateOfBirth: Date | null;
  locale: string;
  timezone: string;
  /**
   * `User.gender` — "MALE" | "FEMALE" | "OTHER". Omitted or null both mean not
   * recorded, and the column keeps the NULL an account that never answered
   * carries; nothing is inferred from the name or from the date of birth.
   */
  gender?: string | null;
}

export interface CreatedManagedProfile {
  profile: User;
  creatorGrant: AccountGrant;
}

export class ManagedProfileCreationError extends Error {
  constructor() {
    super("Unable to allocate a managed profile identity");
    this.name = "ManagedProfileCreationError";
  }
}

function managedUsername(): string {
  return `managed-${randomBytes(18).toString("hex")}`;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}

/**
 * Create the credential-less record and its first Guardian grant together.
 *
 * A profile is never useful before the creator can manage it, and a creator
 * grant without its record is invalid by definition. Keeping both writes in
 * one transaction makes a failed grant insert leave no login-less user behind.
 */
export async function createManagedProfile(
  input: CreateManagedProfileInput,
): Promise<CreatedManagedProfile> {
  for (let attempt = 0; attempt < USERNAME_ATTEMPTS; attempt += 1) {
    try {
      return await prisma.$transaction(async (tx) => {
        const now = new Date();
        const profile = await tx.user.create({
          data: {
            username: managedUsername(),
            email: null,
            passwordHash: null,
            displayName: input.displayName,
            dateOfBirth: input.dateOfBirth,
            gender: input.gender ?? null,
            locale: input.locale,
            timezone: input.timezone,
            managedProfileAt: now,
          },
        });
        const creatorGrant = await tx.accountGrant.create({
          data: {
            grantorId: profile.id,
            granteeId: input.creatorId,
            access: "MANAGE",
            scopeJson: Prisma.DbNull,
            invitedAt: now,
            acceptedAt: now,
            expiresAt: null,
          },
        });
        return { profile, creatorGrant };
      });
    } catch (error) {
      if (isUniqueViolation(error) && attempt + 1 < USERNAME_ATTEMPTS) {
        continue;
      }
      throw error;
    }
  }

  throw new ManagedProfileCreationError();
}
