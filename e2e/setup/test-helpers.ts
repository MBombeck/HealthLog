/**
 * Re-export pin for the seeded test-user identity. The cookie jar that
 * authenticates each spec is captured ONCE in `global-setup.ts` and the
 * specs reach for it via `STORAGE_STATE_PATH` directly. We keep this
 * file (instead of a barrel inside global-setup) only so future helpers
 * specific to the spec-side (e.g. multi-user scenarios that need
 * fresh logins) have a natural home.
 */
export {
  E2E_USER,
  E2E_OWNER,
  E2E_OWNER_FULL_NAME,
  E2E_GUARDIAN,
  E2E_SCOPE_DELEGATE,
  E2E_SCOPE_RECORDS,
  E2E_LEVEL_RECORDS,
  E2E_DELEGATE_MARKER_KG,
  E2E_OWNER_MARKER_KG,
  STORAGE_STATE_PATH,
  OWNER_STORAGE_STATE_PATH,
  DELEGATE_STORAGE_STATE_PATH,
  SCOPE_DELEGATE_STORAGE_STATE_PATH,
  SCOPE_A11Y_STORAGE_STATE_PATH,
  SCOPE_CAPABILITIES_STORAGE_STATE_PATH,
  FENCE_STORAGE_STATE_PATH,
  FENCE_OFFLINE_STORAGE_STATE_PATH,
  CROSS_TAB_STORAGE_STATE_PATH,
  REPORT_DELEGATE_STORAGE_STATE_PATH,
  GUARDIAN_STORAGE_STATE_PATH,
} from "./global-setup";
