import {
  findUserIdByEmail,
  findUserIdByUsername,
} from "@/lib/auth/identity-lookup";

/**
 * Whether another account already holds this e-mail address or username,
 * regardless of case. Sign-in matches both case-insensitively and the
 * database keeps them unique the same way (migration 0517), so a check that
 * compared them exactly let a second account through to a unique violation.
 * Shared by registration and the profile claim. The comparison is an exact
 * equality (`@/lib/auth/identity-lookup`), never a pattern.
 */
export async function accountNameTaken(
  email: string,
  username: string,
): Promise<boolean> {
  const [byEmail, byUsername] = await Promise.all([
    findUserIdByEmail(email),
    findUserIdByUsername(username),
  ]);
  return byEmail !== null || byUsername !== null;
}
