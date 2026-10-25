/**
 * The accounts the disaster-recovery drill adds beside the demo seed: a
 * Guardian with a password, and a managed profile that Guardian administers.
 * Written through the app's own code (`createManagedProfile`,
 * `hashPassword`), so the rows are the ones a person creating them in the app
 * would leave.
 *
 *   DATABASE_URL=… pnpm dlx tsx scripts/dr-drill-seed.ts
 *
 * Prints one JSON line: `{ "guardianId": …, "profileId": … }`. The drill
 * (`scripts/compose-dr-drill.sh`) checks after the restore that the Guardian
 * still sees that profile. Idempotent: a second run answers the same ids.
 */
import { hashPassword } from "@/lib/auth/password";
import { prisma } from "@/lib/db";
import { createManagedProfile } from "@/lib/managed-profiles/create";

const GUARDIAN = "drill-guardian";
const PASSWORD = "drill-guardian-password-1";

async function main(): Promise<void> {
  let guardian = await prisma.user.findUnique({
    where: { username: GUARDIAN },
  });
  guardian ??= await prisma.user.create({
    data: {
      username: GUARDIAN,
      email: "drill-guardian@example.test",
      passwordHash: await hashPassword(PASSWORD),
      displayName: "Drill Guardian",
      locale: "en",
      timezone: "Europe/Berlin",
      onboardingCompletedAt: new Date(),
    },
  });
  const existing = await prisma.accountGrant.findFirst({
    where: { granteeId: guardian.id, access: "MANAGE" },
    select: { grantorId: true },
  });
  const profileId =
    existing?.grantorId ??
    (
      await createManagedProfile({
        creatorId: guardian.id,
        displayName: "Drill Child",
        dateOfBirth: new Date("2018-05-04T00:00:00Z"),
        locale: "en",
        timezone: "Europe/Berlin",
      })
    ).profile.id;
  console.log(JSON.stringify({ guardianId: guardian.id, profileId }));
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
