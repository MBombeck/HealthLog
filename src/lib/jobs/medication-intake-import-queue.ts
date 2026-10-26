/**
 * The queue facts of `medication-intake-import.ts`: its name and, where it has them, its
 * schedule and concurrency. They live apart from the handler so the worker
 * registry and every sender can read them without loading the job.
 */
export const MEDICATION_INTAKE_IMPORT_QUEUE = "medication-intake-import";

export const MEDICATION_INTAKE_IMPORT_CONCURRENCY = 2;
