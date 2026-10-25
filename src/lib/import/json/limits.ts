/**
 * Rows per section, and the file as a whole, as the JSON import route has
 * always capped them. A leaf module, so the import card states the same
 * numbers the route enforces without loading the schema.
 */
export const JSON_IMPORT_MAX_ROWS = 10_000;
export const JSON_IMPORT_MAX_BYTES = 16 * 1024 * 1024;
