/**
 * v1.4.25 W21 Fix-N — shared client-side error reader.
 *
 * The four onboarding components (WelcomeCarousel, GoalsChipPicker,
 * SourceCardGrid, BaselineForm) all hand-rolled the same helper to
 * extract the `error` string from a non-OK `apiError` envelope, with an
 * identical fall-through to `Request failed (<status>)`. Hoisting the
 * helper keeps the four call sites honest — the envelope shape only
 * needs to evolve once.
 *
 * Contract:
 *   - The server-side `apiError` helper writes `{ data: null, error: "<msg>" }`.
 *   - On parse failure (network error, non-JSON body, malformed shape)
 *     fall back to a stable string the toast can surface.
 *   - Never throw — the caller is already in a catch / setError path.
 */
export async function readError(res: Response): Promise<string> {
  try {
    const json = (await res.json()) as { error?: string };
    if (typeof json.error === "string" && json.error.length > 0) {
      return json.error;
    }
  } catch {
    /* fall through */
  }
  return `Request failed (${res.status})`;
}
