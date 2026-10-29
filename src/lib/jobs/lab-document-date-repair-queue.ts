/**
 * The queue facts of `lab-document-date-repair.ts`: its name and its one
 * singleton key. They live apart from the job so the worker registry and the
 * boot discovery can read them without loading it.
 */
export const LAB_DOCUMENT_DATE_REPAIR_QUEUE = "lab-document-date-repair";

/** One pass covers every account, so there is only ever one job. */
export const LAB_DOCUMENT_DATE_REPAIR_SINGLETON_KEY =
  "lab-document-date-repair";
