/**
 * The Bearer scope of the Android Health Connect sync.
 *
 * A leaf module with no imports, like `@/lib/measurements/scopes`: the pair
 * route that mints it, the two routes that accept it and the guards all read
 * it. It opens two doors, `POST /api/health-connect/batch` and
 * `GET /api/health-connect/state`, both on the holder's own record. It reads
 * no health data back, reaches no export and mints nothing; every other route
 * refuses it through the fail-closed default.
 */

/** The scope the token a paired Android device holds carries. */
export const HEALTH_CONNECT_WRITE_SCOPE = "health-connect:write";
