/**
 * The way back into a setup flow after it sent the person to another page
 * (1.50): an OAuth handshake that ends on Settings › Integrations, the
 * import page, an admin card opened from Admin › Setup. The flow remembers
 * where it was for this tab; the page it sent the person to shows one
 * "Back to setup" link while the mark is there.
 *
 * Per tab and best-effort: storage can be unavailable, and then the person
 * finds the setup again through its card.
 */
const KEY = "hl-setup-return";

/** Remember where to come back to; only setup paths are kept. */
export function markSetupReturn(path: string): void {
  if (!isSetupPath(path)) return;
  try {
    sessionStorage.setItem(KEY, path);
  } catch {
    /* storage unavailable */
  }
}

/** The remembered setup path, or null. */
export function readSetupReturn(): string | null {
  try {
    const path = sessionStorage.getItem(KEY);
    return path && isSetupPath(path) ? path : null;
  } catch {
    return null;
  }
}

export function clearSetupReturn(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* storage unavailable */
  }
}

/** Same-origin setup surfaces only, so the mark cannot become a redirect. */
export function isSetupPath(path: string): boolean {
  return /^\/(onboarding(\/[a-z-]+)*|admin\/setup)$/.test(path);
}
