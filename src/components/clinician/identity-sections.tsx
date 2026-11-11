/**
 * The `identity` group on the clinician view: who the record belongs to, and
 * the emergency sheet.
 *
 * Both leaves were selectable on a share link long before anything rendered
 * them, so a person who ticked "Emergency information" handed over a link that
 * showed none of it. These are the render halves of those two controls.
 *
 * The third leaf of the group, `INSURANCE`, has no renderer and must not get
 * one: `SHARE_LINK_FORBIDDEN_LEAVES` refuses it at share-link creation, so no
 * link can carry it and the aggregator therefore never fills the fields. The
 * structural guard in `src/__tests__/share-view-leaf-render-guard.test.ts`
 * holds that pair together.
 *
 * A pure server component: no client hooks, no session, no markdown — every
 * value renders as escaped React text.
 */
import type { DoctorReportData } from "@/lib/doctor-report-data";
import {
  LeafSection,
  StatRow,
  type LeafScope,
  type Translate,
} from "./report-sections";
import { EmptyState } from "@/components/ui/empty-state";

/**
 * Only the three stored gender values get a label. A row on a clinical
 * document is a positive claim, so an unrecognised string leaves the line out
 * rather than asserting a value the account never chose — the same rule the
 * PDF cover applies.
 */
const GENDER_LABEL_KEYS: Record<string, string> = {
  MALE: "doctorReport.genderMale",
  FEMALE: "doctorReport.genderFemale",
  OTHER: "doctorReport.genderOther",
};

/**
 * Name, date of birth, gender, height — the cover block of the PDF, as rows.
 *
 * The insurer fields on `report.patient` are NOT read here. They ride the
 * `INSURANCE` leaf, which a share link cannot carry, so they are always null
 * on this surface; naming them would be the beginning of a path by which they
 * one day would not be.
 */
export function PatientIdentitySection({
  t,
  report,
  scope,
  fmtDate,
}: {
  t: Translate;
  report: DoctorReportData;
  scope: LeafScope;
  fmtDate: (iso: string) => string;
}) {
  const patient = report.patient;
  const name = patient.name;
  const genderKey = patient.gender
    ? GENDER_LABEL_KEYS[patient.gender]
    : undefined;
  const rows: Array<{ label: string; value: string }> = [];
  if (name) {
    rows.push({ label: t("clinicianView.identity.name"), value: name });
  }
  if (patient.dateOfBirth) {
    rows.push({
      label: t("doctorReport.dateOfBirth"),
      value: fmtDate(patient.dateOfBirth),
    });
  }
  if (genderKey) {
    rows.push({ label: t("doctorReport.gender"), value: t(genderKey) });
  }
  if (patient.heightCm) {
    rows.push({
      label: t("doctorReport.height"),
      value: `${patient.heightCm} cm`,
    });
  }

  return (
    <LeafSection
      t={t}
      scope={scope}
      leaves={["PATIENT_IDENTITY"]}
      title={t("reportSelection.groupIdentity")}
      empty={rows.length === 0}
    >
      {rows.map((row) => (
        <StatRow key={row.label} label={row.label} value={row.value} />
      ))}
    </LeafSection>
  );
}

/**
 * The emergency sheet. In the PDF this is page one, alone, under a red banner,
 * because it is what somebody reads in an acute situation; here it is the
 * first card on the page and it is framed rather than plain, for the same
 * reason.
 *
 * Three of its rows are composed from OTHER leaves — severe allergies from
 * `ALLERGIES`, the drug list from `MEDICATION_LIST`, chronic conditions from
 * `ILLNESS_EPISODES` and `ANAMNESIS`. Each is included only when its own leaf
 * is on the link. The alternative — printing "Not recorded" for a leaf the
 * owner withheld — states an absence in the record where the truth is an
 * absence in the share, and on this card that particular lie is the dangerous
 * one.
 */
export function EmergencySection({
  t,
  report,
  scope,
}: {
  t: Translate;
  report: DoctorReportData;
  scope: LeafScope;
}) {
  if (!scope.admits("EMERGENCY")) return null;

  const emergency = report.emergency ?? null;
  const unavailable = scope.unavailable("EMERGENCY");
  const notRecorded = t("doctorReport.emergency.none");
  const unreadable = t("doctorReport.emergency.unreadable");

  const rows: Array<{ label: string; value: string; emphasise?: boolean }> = [];

  if (emergency) {
    rows.push({
      label: t("doctorReport.emergency.bloodType"),
      value:
        emergency.bloodType && emergency.bloodType !== "UNKNOWN"
          ? t(`doctorReport.emergency.bloodTypeValues.${emergency.bloodType}`)
          : emergency.bloodType === "UNKNOWN"
            ? t("doctorReport.emergency.bloodTypeUnknown")
            : notRecorded,
      emphasise: true,
    });

    if (scope.admits("ALLERGIES")) {
      const severe = (report.allergies ?? []).filter(
        (a) => a.severity === "SEVERE",
      );
      rows.push({
        label: t("doctorReport.emergency.severeAllergies"),
        value:
          severe.length > 0
            ? severe
                .map((a) => {
                  const reaction = a.reactionUnreadable
                    ? unreadable
                    : a.reaction;
                  return reaction
                    ? `${a.substance} (${reaction})`
                    : a.substance;
                })
                .join("; ")
            : notRecorded,
        emphasise: severe.length > 0,
      });
    }

    if (scope.admits("MEDICATION_LIST")) {
      const meds = report.medications ?? [];
      rows.push({
        label: t("doctorReport.emergency.activeMedications"),
        value:
          meds.length > 0
            ? meds
                .map((m) => (m.dose ? `${m.name} ${m.dose}` : m.name))
                .join("; ")
            : notRecorded,
      });
    }

    const chronic = scope.admits("ILLNESS_EPISODES")
      ? (report.illnessEpisodes ?? [])
          .filter((e) => e.lifecycle === "CHRONIC_ONGOING")
          .map((e) => e.label)
      : [];
    const anamnesisConditions = scope.admits("ANAMNESIS")
      ? (report.anamnesis?.conditions ?? null)
      : null;
    if (scope.admits("ILLNESS_EPISODES") || scope.admits("ANAMNESIS")) {
      const parts = [...chronic];
      if (anamnesisConditions) parts.push(anamnesisConditions);
      rows.push({
        label: t("doctorReport.emergency.chronicConditions"),
        value: parts.length > 0 ? parts.join("; ") : notRecorded,
      });
    }

    rows.push({
      label: t("doctorReport.emergency.implants"),
      value: emergency.implantsUnreadable
        ? unreadable
        : (emergency.implants ?? notRecorded),
    });
    rows.push({
      label: t("doctorReport.emergency.advanceDirective"),
      value: emergency.advanceDirective
        ? t(
            `doctorReport.emergency.advanceDirectiveValues.${emergency.advanceDirective}`,
          )
        : notRecorded,
    });
    rows.push({
      label: t("doctorReport.emergency.organDonor"),
      value: emergency.organDonor
        ? t(`doctorReport.emergency.organDonorValues.${emergency.organDonor}`)
        : notRecorded,
    });
    rows.push({
      label: t("doctorReport.emergency.contacts"),
      value: emergency.contactsUnreadable
        ? unreadable
        : (emergency.contacts ?? notRecorded),
      emphasise: emergency.contacts !== null,
    });
    const note = emergency.noteUnreadable ? unreadable : emergency.note;
    if (note) {
      rows.push({ label: t("doctorReport.emergency.notes"), value: note });
    }
  }

  return (
    <section
      data-leaf="EMERGENCY"
      className="border-destructive/50 bg-destructive/5 rounded-lg border p-4 md:p-6"
    >
      <h2 className="mb-1 text-base font-semibold">
        {t("doctorReport.emergency.title")}
      </h2>
      <p className="text-muted-foreground mb-3 text-xs">
        {t("doctorReport.emergency.subtitle")}
      </p>
      {unavailable ? (
        <p className="text-muted-foreground text-sm">
          {t("clinicianView.sectionUnavailable")}
        </p>
      ) : rows.length === 0 ? (
        <EmptyState
          variant="plain"
          size="compact"
          title={t("clinicianView.sectionEmpty")}
        />
      ) : (
        rows.map((row) => (
          <StatRow
            key={row.label}
            label={row.label}
            value={row.value}
            emphasise={row.emphasise}
          />
        ))
      )}
    </section>
  );
}
