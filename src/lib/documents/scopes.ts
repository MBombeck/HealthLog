/**
 * The Bearer scope for pushing documents into the vault from another system.
 *
 * A zero-import leaf for the reason `MEASUREMENTS_WRITE_SCOPE` is one (see
 * `@/lib/measurements/scopes`): the mint route, the upload route, the settings
 * card and the guards all read it, and none of them should inherit an import
 * graph for a string.
 *
 * Deliberately alone. There is no read counterpart and must not be one: the
 * list, detail, original, thumbnail, bulk and AI legs of the vault stay
 * cookie-equivalent, so a credential pasted into a Paperless workflow or an
 * import script can add a file and learn nothing about the vault it lands in.
 */

/** The scope a narrow token must carry to upload a document. */
export const DOCUMENTS_WRITE_SCOPE = "documents:write";
