/**
 * Every `meta.errorCode` the API emits, grouped by the surface that emits it.
 *
 * `meta.errorCode` is the mechanism this API chose for machine-readable errors
 * — the envelope's own description tells a client to branch on it rather than
 * on the prose — and until this file existed a client could not enumerate it.
 * When this file was written, sixteen of its two hundred and forty-two codes
 * appeared somewhere in `docs/api/openapi.yaml`; the rest existed only in
 * server source, so the only way to learn one was to trigger the error in
 * testing and the only way to learn a new one had appeared was to trigger
 * that too.
 *
 * The list is generated from the code and then committed as a literal, so it is
 * reviewable in a diff and stable across a release. `error-code-catalogue.test.ts`
 * re-derives it from the tree on every run and fails in both directions: a code
 * emitted and not listed, and a code listed and no longer emitted.
 *
 * Naming: four conventions coexist here — dot.case (the majority and the one
 * to use), bare snake_case, a camelCase segment, and a hyphen. Nothing is
 * renamed: a code is a wire value and a shipped client branches on it. New
 * codes are dot.case.
 *
 * Not in this list, and deliberately:
 *
 *   - `assistant.disabled.<surface>` is built from a template at runtime
 *     (`src/lib/feature-flags/index.ts`), so the surface segment is open.
 *     `assistant.disabled.coach` is the one the iOS contract names.
 *   - The integration-probe classes — `credentials_rejected`, `rate_limited`,
 *     `upstream_error`, `timeout`, `connection_failed`, and the per-provider
 *     additions beside them — are chosen by each `/test` route's own
 *     categoriser and are already enumerated in those operations'
 *     descriptions, where the per-provider differences can be stated.
 *   - `IntegrationStatus.errorCode` is a different field with the same name: it
 *     records an upstream HTTP status in the sync ledger and never reaches a
 *     response envelope.
 */
export const ERROR_CODE_CATALOGUE: Readonly<Record<string, readonly string[]>> =
  {
    ai_provider: ["ai_provider.invalid", "ai_provider.no_fields"],
    allergy: ["allergy.invalid"],
    analytics: ["analytics.invalid_query"],
    anamnesis: [
      "anamnesis.fact.conflict",
      "anamnesis.fact.currentExists",
      "anamnesis.fact.invalidValue",
    ],
    auth: [
      "auth.admin.required",
      "auth.mfa.code_invalid",
      "auth.missing",
      "auth.refresh.invalid",
      "auth.refresh.reuse",
      "auth.refresh.revoked",
      "auth.scope.insufficient",
      "auth.stepup.required",
      "auth.token.expired",
      "auth.token.invalid",
    ],
    backup: ["backup.payload.undecryptable", "backup.section.missing"],
    coach: [
      "coach.conversation.invalidTitle",
      "coach.conversation.notFound",
      "coach.fenced.attachmentConflict",
      "coach.fenced.attachmentLimit",
      "coach.fenced.attachmentNotFound",
      "coach.fenced.attachmentNotIndexed",
      "coach.fenced.attachmentRequired",
      "coach.fenced.attachmentUnavailable",
      "coach.fenced.invalid",
      "coach.request.invalid",
    ],
    "coach-prefs": [
      "coach-prefs.body.invalid_json",
      "coach-prefs.body.invalid_shape",
    ],
    consent: ["consent.ai.required"],
    cycle: [
      "cycle.bulk.invalid",
      "cycle.bulk.too_large",
      "cycle.calendar.invalid",
      "cycle.calendar.range",
      "cycle.cycles.invalid",
      "cycle.day-log.conflict",
      "cycle.day-log.invalid",
      "cycle.disabled",
      "cycle.period.invalid",
      "cycle.symptom.custom.invalid",
      "cycle.symptom.custom.limit",
    ],
    "cycle-prefs": ["cycle-prefs.body.invalid_json", "cycle-prefs.invalid"],
    "disable-coach": ["disable-coach.body.invalid_json"],
    documents: [
      "documents.chat.conversationNotFound",
      "documents.chat.invalid",
      "documents.inbound.alreadyConfirmed",
      "documents.inbound.alreadyPartlyConfirmed",
      "documents.inbound.budgetExceeded",
      "documents.inbound.decryptFailed",
      "documents.inbound.encounterNotFound",
      "documents.inbound.episodeNotFound",
      "documents.inbound.extractFailed",
      "documents.inbound.factNotFound",
      "documents.inbound.factNotPending",
      "documents.inbound.factTypeMismatch",
      "documents.inbound.fileTooLarge",
      "documents.inbound.fileType",
      "documents.inbound.invalidMetadata",
      "documents.inbound.invalidQuery",
      "documents.inbound.invalidUpdate",
      "documents.inbound.localOcrDisabled",
      "documents.inbound.notFound",
      "documents.inbound.notIndexed",
      "documents.inbound.pdfNeedsAnthropic",
      "documents.inbound.providerUnsupported",
      "documents.inbound.quotaExceeded",
      "documents.inbound.rateLimited",
      "documents.inbound.restoreDuplicate",
      "documents.inbound.restoreGone",
      "documents.inbound.uploadBusy",
      "documents.inbound.uploadTimeout",
    ],
    encounter: [
      "encounter.invalid",
      "encounter.link.invalid",
      "encounter.practitioner-not-found",
      "encounter.reminder-conflict",
      "encounter.reminder-not-found",
    ],
    environment: [
      "environment.invalid",
      "environment.no_home",
      "environment.range_too_large",
      "environment.travel.not_found",
    ],
    export: ["export.selection.empty", "export.selection.unknown_leaf"],
    familyHistory: ["familyHistory.invalid"],
    feedback: ["feedback.body.invalid"],
    health_score_config: [
      "health_score_config.invalid",
      "health_score_config.too_narrow",
    ],
    illness: [
      "illness.day-log.invalid",
      "illness.disabled",
      "illness.episode.chronic-no-resolve",
      "illness.episode.invalid",
      "illness.episode.invalid-window",
      "illness.episode.parent-not-found",
      "illness.insights.invalid",
    ],
    import: ["import.write_failed"],
    ingest: ["ingest.rate_limited"],
    insights: [
      "insights.generate.budgetExceeded",
      "insights.generate.outboundScreened",
      "insights.generate.profileScopeChanged",
      "insights.generate.scopeChanged",
    ],
    labs: [
      "labs.biomarker.create.invalid",
      "labs.biomarker.duplicate",
      "labs.biomarker.notFound",
      "labs.biomarker.update.invalid",
      "labs.biomarker.update.referenceRangeInvalid",
      "labs.create.invalid",
      "labs.ocr.budgetExceeded",
      "labs.ocr.extractFailed",
      "labs.ocr.fileTooLarge",
      "labs.ocr.fileType",
      "labs.ocr.localOcrDisabled",
      "labs.ocr.pdfNeedsAnthropic",
      "labs.ocr.providerUnsupported",
      "labs.ocr.rateLimited",
      "labs.restore.invalid",
      "labs.result.notFound",
      "labs.update.invalid",
      "labs.update.linkedFieldsImmutable",
      "labs.update.numericExpected",
      "labs.update.qualitativeExpected",
      "labs.update.referenceRangeInvalid",
      "labs.update.sourceReferenceRangeInvalid",
    ],
    managed_profile: [
      "managed_profile.guardian.duplicate",
      "managed_profile.guardian.managed_invitee",
      "managed_profile.guardian.required",
      "managed_profile.not_found",
    ],
    measurement: [
      "measurement.batch.source_not_permitted",
      "measurement.batch.too_large",
      "measurement.bulk-delete.invalid",
      "measurement.create.invalid",
      "measurement.create.source_not_permitted",
      "measurement.delete.too_large",
      "measurement.duplicate_timestamp",
      "measurement.restore.invalid",
      "measurement.update.server_owned_source",
    ],
    medication: ["medication.intake.import.invalid_format"],
    medications: [
      "medications.intake.bulk.apple_health_not_mirrored",
      "medications.intake.bulk.invalid",
      "medications.intake.bulk.too_large",
      "medications.intake.force_slot.invalid",
      "medications.intake.force_slot.occupied",
      "medications.intake.injection_site.disallowed",
      "medications.intake.taken_at.before_start",
      "medications.mirror.limit_exceeded",
    ],
    mentalHealth: ["mentalHealth.rateLimited"],
    module: ["module.disabled"],
    modules: ["modules.body.invalid_json", "modules.invalid"],
    mood: [
      "mood.bulk-delete.invalid",
      "mood.bulk.invalid",
      "mood.bulk.too_large",
      "mood.create.external_id_not_delegable",
      "mood.create.invalid",
      "mood.duplicate_timestamp",
      "mood.linkedContext.invalid",
      "mood.list.invalid",
      "mood.not_found",
      "mood.ratedFactor.out_of_range",
      "mood.restore.invalid",
      "mood.update.invalid",
    ],
    "notification-prefs": ["notification-prefs.body.invalid_json"],
    nutrient: [
      "nutrient.batch.invalid",
      "nutrient.batch.too_large",
      "nutrient.daily.invalid",
      "nutrient.read.invalid",
      "nutrient.water.invalid",
      "nutrient.water.invalid_day",
    ],
    onboarding: [
      "onboarding.answers.invalid",
      "onboarding.answers.rateLimited",
      "onboarding.complete.invalid",
      "onboarding.complete.recordNotFound",
      "onboarding.complete.recordTargetMismatch",
      "onboarding.disclaimer.invalid",
      "onboarding.restart.invalid",
      "onboarding.restart.rateLimited",
      "onboarding.tour.invalid",
    ],
    personal_records: ["personal_records.invalid_query"],
    practitioner: ["practitioner.invalid"],
    profile: [
      "profile.update.emailInUse",
      "profile.update.invalidBody",
      "profile.update.nothingSaved",
    ],
    record_write: ["record_write.rate_limited"],
    "report-selection": [
      "report-selection.body.invalid_json",
      "report-selection.body.invalid_shape",
      "report-selection.leaves.unknown",
    ],
    route: ["route.retired"],
    "share-link": [
      "share-link.document.decryptFailed",
      "share-link.document.notFound",
      "share-link.document.rateLimited",
      "share-link.documents.invalid",
      "share-link.report.notFound",
      "share-link.report.rateLimited",
      "share-link.selection.forbidden_leaf",
      "share-link.selection.unknown_leaf",
    ],
    sharing: [
      "sharing.accept.expired",
      "sharing.accept.not_found",
      "sharing.accept.not_pending",
      "sharing.accept.revoked",
      "sharing.access.denied",
      "sharing.invite.duplicate",
      "sharing.invite.invalid",
      "sharing.invite.invalid_scope",
      "sharing.invite.manage_browser_only",
      "sharing.invite.refused",
      "sharing.invite.self",
      "sharing.not_permitted",
      "sharing.renounce.already_ended",
      "sharing.renounce.not_found",
      "sharing.revoke.already_ended",
      "sharing.revoke.not_found",
      "sharing.session.changed",
      "sharing.switch.invalid",
      "sharing.switch.wrong_transport",
    ],
    "source-priority": [
      "source-priority.body.invalid_json",
      "source-priority.body.invalid_shape",
    ],
    tokens: ["tokens.measurements.ceiling_reached"],
    vaccination: [
      "vaccination.booster-invalid",
      "vaccination.booster-no-antigen",
      "vaccination.booster-out-of-scope",
      "vaccination.encounter-not-found",
      "vaccination.identity-required",
      "vaccination.invalid",
      "vaccination.link.invalid",
      "vaccination.not-found",
      "vaccination.practitioner-not-found",
    ],
    workout: [
      "workout.batch.invalid",
      "workout.batch.payload_too_large",
      "workout.batch.too_large",
    ],
    "(unprefixed)": [
      "about_me_conflict",
      "ai_response_truncated",
      "coach_prefs_conflict",
      "dashboard_layout_conflict",
      "empty_file",
      "health_score_config_conflict",
      "insights_layout_conflict",
      "invalid_base_updated_at",
      "json_carries_no_intake_time",
      "json_not_an_array",
      "medication_layout_conflict",
      "missing_required_columns",
      "modules_conflict",
      "mood_tag_layout_conflict",
      "not_configured",
      "notification_prefs_conflict",
      "oidc_only",
      "private_origin_not_approved",
      "private_origin_not_grantable",
      "rate_limited_self",
      "too_many_rows",
      "unreadable_json",
      "upstream_invalid_json",
      "vapid_not_configured",
    ],
  } as const;

/**
 * The catalogue as one sentence for the published `meta.errorCode` description.
 *
 * Rendered rather than hand-written so the document cannot drift from the list
 * the guard checks: there is one source, and it is the object above.
 */
export function renderErrorCodeCatalogue(): string {
  return Object.entries(ERROR_CODE_CATALOGUE)
    .map(([surface, codes]) => `${surface} — ${codes.join(", ")}`)
    .join("; ");
}
