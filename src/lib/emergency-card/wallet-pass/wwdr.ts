/**
 * Apple's "Worldwide Developer Relations Certification Authority, G4": the
 * public intermediate that issues every Pass Type ID certificate. A pass's
 * signature carries it next to the pass certificate, and a locally signing
 * operator's certificate must be issued by it.
 *
 * From https://www.apple.com/certificateauthority/AppleWWDRCAG4.cer, valid
 * until 2030-12-10, the same bytes the project's signing service embeds. The
 * SHA-256 below is checked on every read, so a changed copy fails closed.
 */
import { createHash, X509Certificate } from "node:crypto";

export const APPLE_WWDR_G4_SHA256 =
  "ea4757885538dd8cb59ff4556f676087d83c85e70902c122e42c0808b5bce14c";

/** The certificate, DER, base64. */
const APPLE_WWDR_G4_DER_B64 = [
  "MIIEVTCCAz2gAwIBAgIUE9x3lVJx5T3GMujM/+Uh88zFztIwDQYJKoZIhvcNAQELBQAwYjELMAkG",
  "A1UEBhMCVVMxEzARBgNVBAoTCkFwcGxlIEluYy4xJjAkBgNVBAsTHUFwcGxlIENlcnRpZmljYXRp",
  "b24gQXV0aG9yaXR5MRYwFAYDVQQDEw1BcHBsZSBSb290IENBMB4XDTIwMTIxNjE5MzYwNFoXDTMw",
  "MTIxMDAwMDAwMFowdTFEMEIGA1UEAww7QXBwbGUgV29ybGR3aWRlIERldmVsb3BlciBSZWxhdGlv",
  "bnMgQ2VydGlmaWNhdGlvbiBBdXRob3JpdHkxCzAJBgNVBAsMAkc0MRMwEQYDVQQKDApBcHBsZSBJ",
  "bmMuMQswCQYDVQQGEwJVUzCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBANAfeKp6JzKw",
  "Rl/nF3bYoJ0OKY6tPTKlxGs3yeRBkWq3eXFdDDQEYHX3rkOPR8SGHgjov9Y5Ui8eZ/xx8YJtPH4G",
  "UnadLLzVQ+mxtLxAOnhRXVGhJeG+bJGdayFZGEHVD41tQSo5SiHgkJ9OE0/QjJoyuNdqkh4laqQy",
  "ziIZhQVg3AJK8lrrd3kCfcCXVGySjnYB5kaP5eYq+6KwrRitbTOFOCOL6oqW7Z+uZk+jDEAnbZXQ",
  "YojZQykn/e2kv1MukBVlPNkuYmQzHWxq3Y4hqqRfFcYw7V/mjDaSlLfcOQIA+2SM1AyB8j/VNJeH",
  "dSbCb64DYyEMe9QbsWLFApy9/a8CAwEAAaOB7zCB7DASBgNVHRMBAf8ECDAGAQH/AgEAMB8GA1Ud",
  "IwQYMBaAFCvQaUeUdgn+9GuNLkCm90dNfwheMEQGCCsGAQUFBwEBBDgwNjA0BggrBgEFBQcwAYYo",
  "aHR0cDovL29jc3AuYXBwbGUuY29tL29jc3AwMy1hcHBsZXJvb3RjYTAuBgNVHR8EJzAlMCOgIaAf",
  "hh1odHRwOi8vY3JsLmFwcGxlLmNvbS9yb290LmNybDAdBgNVHQ4EFgQUW9n6HeeaGgujmXYiUIY+",
  "kchbd6gwDgYDVR0PAQH/BAQDAgEGMBAGCiqGSIb3Y2QGAgEEAgUAMA0GCSqGSIb3DQEBCwUAA4IB",
  "AQA/Vj2e5bbDeeZFIGi9v3OLLBKeAuOugCKMBB7DUshwgKj7zqew1UJEggOCTwb8O0kU+9h0UoWv",
  "p50h5wESA5/NQFjQAde/MoMrU1goPO6cn1R2PWQnxn6NHThNLa6B5rmluJyJlPefx4elUWY0Gzlx",
  "OSTjh2fvpbFoe4zuPfeutnvi0v/fYcZqdUmVIkSoBPyUuAsuORFJEtHlgepZAE9bPFo22noicwkJ",
  "ac3AfOriJP6YRLj477JxPxpd1F1+M02cHSS+APCQA1iZQT0xWmJArzmoUUOSqwSonMJNsUvSq3xK",
  "X+udO7xPiEAGE/+QF4oIRynoYpgppU8RBWk6z/Kf",
].join("");

/** The embedded intermediate, after its pinned hash is checked. */
export function appleWwdrG4(): X509Certificate {
  const der = Buffer.from(APPLE_WWDR_G4_DER_B64, "base64");
  if (createHash("sha256").update(der).digest("hex") !== APPLE_WWDR_G4_SHA256) {
    throw new Error(
      "the embedded Apple WWDR G4 certificate does not match its pin",
    );
  }
  return new X509Certificate(der);
}
