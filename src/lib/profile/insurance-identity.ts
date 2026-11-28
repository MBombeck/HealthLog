/**
 * The stored insurance identity, read one way for every surface that shows
 * or exports it: the profile, the account payload, the doctor's report and
 * the FHIR export. The number is decrypted fail-soft (a
 * key-rotation gap omits it rather than failing the read), the country
 * resolves NULL to DE, and the group number exists only for a US number.
 */
import { decrypt } from "@/lib/crypto";
import {
  countryHasGroupNumber,
  isIsoCountryCode,
  resolveInsuranceNumberCountry,
} from "@/lib/validations/insurance-number";

/** The columns {@link readInsuranceIdentity} reads, for a Prisma `select`. */
export const INSURANCE_IDENTITY_SELECT = {
  insuranceNumberEncrypted: true,
  insuranceNumberCountry: true,
  insuranceGroupNumber: true,
} as const;

export interface InsuranceIdentityRow {
  insuranceNumberEncrypted: string | null;
  insuranceNumberCountry: string | null;
  insuranceGroupNumber: string | null;
}

export interface InsuranceIdentity {
  /** The number as stored (compact for a strict country), or null. */
  insuranceNumber: string | null;
  /**
   * The country the number follows: the stored one, DE for a number stored
   * without one, null when there is neither.
   */
  insuranceNumberCountry: string | null;
  /** The US plan's group number, null for every other country. */
  insuranceGroupNumber: string | null;
}

export const EMPTY_INSURANCE_IDENTITY: InsuranceIdentity = {
  insuranceNumber: null,
  insuranceNumberCountry: null,
  insuranceGroupNumber: null,
};

export function readInsuranceIdentity(
  row: InsuranceIdentityRow | null | undefined,
): InsuranceIdentity {
  if (!row) return EMPTY_INSURANCE_IDENTITY;
  let insuranceNumber: string | null = null;
  if (row.insuranceNumberEncrypted) {
    try {
      insuranceNumber = decrypt(row.insuranceNumberEncrypted);
    } catch {
      insuranceNumber = null;
    }
  }
  const stored = isIsoCountryCode(row.insuranceNumberCountry)
    ? row.insuranceNumberCountry
    : null;
  const insuranceNumberCountry =
    stored ?? (insuranceNumber ? resolveInsuranceNumberCountry(null) : null);
  const insuranceGroupNumber =
    insuranceNumberCountry && countryHasGroupNumber(insuranceNumberCountry)
      ? (row.insuranceGroupNumber ?? null)
      : null;
  return { insuranceNumber, insuranceNumberCountry, insuranceGroupNumber };
}
