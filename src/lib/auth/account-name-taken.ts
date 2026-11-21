import { prisma } from "@/lib/db";

/**
 * Whether another account already holds this e-mail address or username,
 * regardless of case. Sign-in matches both case-insensitively and the
 * database keeps them unique the same way (migration 0517), so a check that
 * compared them exactly let a second account through to a unique violation.
 * Shared by registration and the profile claim.
 */
export async function accountNameTaken(
  email: string,
  username: string,
): Promise<boolean> {
  const [byEmail, byUsername] = await Promise.all([
    prisma.user.findFirst({
      where: { email: { equals: email, mode: "insensitive" } },
      select: { id: true },
    }),
    prisma.user.findFirst({
      where: { username: { equals: username, mode: "insensitive" } },
      select: { id: true },
    }),
  ]);
  return byEmail !== null || byUsername !== null;
}
