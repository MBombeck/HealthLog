/**
 * Medication request/response validation schemas.
 *
 * Barrel preserving the original `@/lib/validations/medication` import path.
 * The schemas are split by sub-resource into focused sibling modules:
 *  - `base` — shared enums, constants, regexes, code fields, dose windows.
 *  - `schedule` — the per-schedule input schema.
 *  - `create-update` — create / update medication bodies + course window.
 *  - `intake` — intake / external / list / edit / bulk-delete schemas.
 *  - `inventory` — container + GLP-1 schemas.
 */
export * from "./base";
export * from "./schedule";
export * from "./create-update";
export * from "./intake";
export * from "./inventory";
export * from "./course";
