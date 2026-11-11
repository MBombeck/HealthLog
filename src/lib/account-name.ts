/**
 * The name the app shows and addresses an account by: the display name when
 * one is set, the username otherwise. Greetings, the top bar and the sidebar
 * all read it here, so the display name edited on the profile card reaches
 * every surface that names the account.
 */
export function accountName(user: {
  username: string;
  displayName?: string | null;
}): string {
  const displayName = user.displayName?.trim();
  return displayName ? displayName : user.username;
}

/**
 * The name a clinical document gives a person: the full name when one is
 * set, the display name next, the login last. A managed record's login is a
 * handle generated when the record was created (`managed-<hex>`), not a name
 * anybody chose, so it never prints; with no other name the line is left out.
 */
export function patientName(user: {
  username: string;
  displayName: string | null;
  fullName: string | null;
  managedProfileAt: Date | null;
}): string | null {
  const fullName = user.fullName?.trim();
  if (fullName) return fullName;
  const displayName = user.displayName?.trim();
  if (displayName) return displayName;
  return user.managedProfileAt ? null : user.username;
}

/** Up to two letters for an avatar, from a name such as `accountName()`. */
export function nameInitials(name: string): string {
  return name
    .split(/[\s._-]+/)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase() ?? "")
    .join("");
}
