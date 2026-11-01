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
