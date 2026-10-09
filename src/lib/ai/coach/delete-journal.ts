/**
 * Coach conversation deletes sent but not yet confirmed, kept in
 * `sessionStorage` so they outlive a reload. A reload inside the undo window
 * sends the DELETE with `keepalive` from the old page, and the new page's list
 * read can reach the server before it: without the journal that read brings
 * the row back. The new page hides every journaled id and sends its DELETE
 * again; a 404 then means it is already gone.
 *
 * Every entry carries the owner it was sent for: the signed-in account and
 * the record it was reading (`<userId>:<recordScope | "own">`). A tab outlives
 * a logout, another login and a switch into a managed profile, and a delete
 * re-sent in any of those other scopes asks the wrong record: the server
 * answers 404, which would read as "already gone" and drop the entry while the
 * conversation still exists, or the record fence refuses it and a failure
 * toast names a row the person cannot see. So only entries of the current
 * owner are re-sent, which is also what keeps a 404 meaningful, and a session
 * end clears the journal with the rest of the session's state.
 */
const DELETE_JOURNAL_KEY = "healthlog:coach-conversation-deletes";

export interface CoachDeleteJournalEntry {
  id: string;
  owner: string;
}

/** The journal owner for an account reading `recordScope` (null = own). */
export function coachDeleteJournalOwner(
  userId: string,
  recordScope: string | null,
): string {
  return `${userId}:${recordScope ?? "own"}`;
}

function safeSessionStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function readAll(storage: Storage): CoachDeleteJournalEntry[] {
  try {
    const raw = storage.getItem(DELETE_JOURNAL_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    // An entry without an owner (the earlier bare-id shape) cannot be bound
    // to a scope and is dropped rather than re-sent anywhere.
    return parsed.filter(
      (entry): entry is CoachDeleteJournalEntry =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as CoachDeleteJournalEntry).id === "string" &&
        typeof (entry as CoachDeleteJournalEntry).owner === "string",
    );
  } catch {
    return [];
  }
}

/** The ids journaled for `owner`, and only those. */
export function readCoachDeleteJournal(owner: string): string[] {
  const storage = safeSessionStorage();
  if (!storage) return [];
  return readAll(storage)
    .filter((entry) => entry.owner === owner)
    .map((entry) => entry.id);
}

/**
 * Re-send what a previous page of this tab could not confirm, for `owner`
 * only: another account's or another record's entries stay where they are
 * until their own scope comes back or the session ends.
 */
export function resendCoachDeleteJournal(
  owner: string,
  commit: (id: string) => void,
): void {
  for (const id of readCoachDeleteJournal(owner)) commit(id);
}

/** Add (`present`) or remove one delete of `owner`. Best effort. */
export function writeCoachDeleteJournal(
  owner: string,
  id: string,
  present: boolean,
): void {
  const storage = safeSessionStorage();
  if (!storage) return;
  try {
    const entries = readAll(storage).filter(
      (entry) => !(entry.owner === owner && entry.id === id),
    );
    if (present) entries.push({ id, owner });
    if (entries.length === 0) storage.removeItem(DELETE_JOURNAL_KEY);
    else storage.setItem(DELETE_JOURNAL_KEY, JSON.stringify(entries));
  } catch {
    // Storage unavailable: the keepalive request still carries the delete.
  }
}

/** Forget every journaled delete, whoever it belonged to (a session end). */
export function clearCoachDeleteJournal(): void {
  const storage = safeSessionStorage();
  if (!storage) return;
  try {
    storage.removeItem(DELETE_JOURNAL_KEY);
  } catch {
    return;
  }
}
