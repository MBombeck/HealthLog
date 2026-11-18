/**
 * The error code a GLP-1 dose step POST answers when its client id belongs to
 * a step that was removed (`medication_dose_change_tombstones`, migration
 * 0507). Shared by the route and the published error catalogue.
 */
export const GLP1_DOSE_CHANGE_DELETED_ERROR_CODE = "glp1.doseChange.deleted";
