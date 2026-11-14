/**
 * #1371 — the longest note a medication carries. Room for a full set of
 * directions ("on an empty stomach, 30 to 60 minutes before breakfast, not
 * within four hours of calcium or iron") with space to spare. Its own module,
 * free of zod, so the editor can cap its input without pulling the request
 * schemas into the page bundle.
 */
export const MEDICATION_NOTE_MAX_CHARS = 500;
