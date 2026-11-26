# Security Policy

## Supported Versions

Only the latest release on the `main` branch is actively supported with security updates.

| Version | Supported |
| ------- | --------- |
| Latest  | Yes       |
| Older   | No        |

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly.

**Do not open a public GitHub issue for security vulnerabilities.**

Instead, send an email to **security@healthlog.dev** with:

- A description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

## Response Timeline

- **Acknowledgement**: Within 72 hours
- **Initial assessment**: Within 1 week
- **Fix and disclosure**: Coordinated with reporter, typically within 30 days

A high or critical security fix does not wait for the release calendar. It ships as an out-of-schedule patch release as soon as it is ready, with a GitHub Security Advisory published alongside; lower ratings ship with the next Saturday patch. See [docs/contributing/release-policy.md](docs/contributing/release-policy.md).

## Scope

The following are in scope:

- Authentication and session management
- Data encryption and secret handling
- API authorization and access control
- Cross-site scripting (XSS), CSRF, and injection vulnerabilities
- Information disclosure

Out of scope:

- Denial of service attacks
- Social engineering
- Vulnerabilities in third-party dependencies (report upstream)
- Issues requiring physical access to the server

## Security Architecture

HealthLog is designed with security as a core principle:

- **Passkey-first authentication** (WebAuthn/FIDO2) with password fallback
- **AES-256-GCM encryption** for all stored secrets (OAuth tokens, API keys, VAPID keys)
- **Argon2id** password hashing with zxcvbn strength validation
- **HMAC-SHA256** hashed API tokens
- **Server-side sessions** in PostgreSQL (`__Host-` cookie, HttpOnly, Secure, SameSite=Lax, an idle timeout and an absolute lifetime). Lax rather than Strict: the OAuth return of an integration (Withings and the others) is a top-level navigation from another site that needs the session to know whose connection it completes, and an OIDC sign-in reaches the app through a redirect chain that starts at the identity provider; under Strict both would land signed out. Cross-site writes are refused separately by a `Sec-Fetch-Site` / `Origin` check. Ending a user's sessions (password change, admin reset, admin force logout, account deletion) ends the native app's sign-ins and API tokens with them
- **No caching of API answers**: every API response is `Cache-Control: private, no-store` unless the route documents a narrower exception (public static payloads, ETag-revalidated reads)
- **Rate limiting** on authentication and external-facing endpoints
- **Security headers**: CSP with nonces, HSTS, X-Frame-Options DENY, Permissions-Policy
- **Proxy-level route protection** via `proxy.ts` (session cookie validation on all non-public paths)

The session cookie is `SameSite=Lax` rather than `Strict` because a single
sign-on return and links into the app from notifications arrive as cross-site
navigations; state-changing requests from another site or origin are refused
by the server regardless.

The security documentation in this repository:

- [Authentication and sessions](docs/security/authentication.md)
- [Authorization](docs/security/authorization.md)
- [Key management and cryptographic inventory](docs/security/key-management.md)
- [Data classification](docs/security/data-classification.md)
- [Logging](docs/security/logging.md)
- [Network egress](docs/security/network-egress.md)
- [Limits](docs/security/limits.md) and [file handling](docs/security/file-handling.md)
- [Threat model](docs/security/threat-model.md), which also lists the risks that remain

For more details, see the [security documentation](https://docs.healthlog.dev/security/overview/).

## Supply Chain

HealthLog Docker images are built and published from this repository's CI:

- **Source**: [`.github/workflows/docker-publish.yml`](.github/workflows/docker-publish.yml) — publishes on every `v*` tag; pull requests build the image without publishing it
- **Registry**: [`ghcr.io/mbombeck/healthlog`](https://github.com/MBombeck/HealthLog/pkgs/container/healthlog)
- **Architectures**: `linux/amd64` and `linux/arm64`
- **Provenance attestation** (from v1.49.1): the multi-arch image index carries signed [SLSA v1 build provenance](https://slsa.dev/spec/v1.0/provenance) at Build L3, linking it to the GitHub Actions run, the commit and the workflow. It is signed in the isolated reusable workflow [`image-provenance.yml`](.github/workflows/image-provenance.yml), whose path is the certificate identity; the build jobs hold no signing token, and release builds use no shared build cache. BuildKit's own provenance (`mode=max`) also travels in the index, unsigned. Releases up to v1.49.0 carry only BuildKit's unsigned `mode=min` provenance on the image
- **SLSA Build L3** covers the image, the release manifest below (signed by the SLSA generator) and the [push relay](https://github.com/MBombeck/healthlog-push) images
- **Signature**: the multi-arch image index is signed keyless with [cosign](https://docs.sigstore.dev/) by the release workflow; no long-lived signing key exists
- **Release assets** (from v1.49.0): every GitHub release carries `healthlog-<tag>-image.txt` (the image refs with the index and per-platform digests), its Sigstore bundle `healthlog-<tag>-image.sigstore.json`, and SLSA v1 provenance `healthlog-<tag>.intoto.jsonl`
- **SBOM**: each image includes a [Software Bill of Materials](https://docs.docker.com/build/metadata/attestations/sbom/) you can inspect with `docker buildx imagetools inspect ghcr.io/mbombeck/healthlog:latest --format '{{ json .SBOM }}'`

To pin to a specific version in production, replace `:latest` with the released tag in your `docker-compose.yml`, e.g. `ghcr.io/mbombeck/healthlog:1.3.2`. Pinning is recommended for self-hosters who want explicit control over upgrades.

### Verifying a release

```sh
TAG=v1.49.0
gh release download "$TAG" --repo MBombeck/HealthLog --pattern "healthlog-$TAG*"

cosign verify-blob \
  --bundle "healthlog-$TAG-image.sigstore.json" \
  --certificate-identity-regexp '^https://github\.com/MBombeck/HealthLog/\.github/workflows/docker-publish\.yml@refs/tags/v' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  "healthlog-$TAG-image.txt"

slsa-verifier verify-artifact "healthlog-$TAG-image.txt" \
  --provenance-path "healthlog-$TAG.intoto.jsonl" \
  --source-uri github.com/MBombeck/HealthLog \
  --source-tag "$TAG"

cosign verify \
  --certificate-identity-regexp '^https://github\.com/MBombeck/HealthLog/\.github/workflows/docker-publish\.yml@refs/tags/v' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  "$(awk '$2 == "index" { print $1; exit }' "healthlog-$TAG-image.txt")"

# From v1.49.1: the signed build provenance of that image index.
gh attestation verify \
  "oci://$(awk '$2 == "index" { sub(/:[^:@]*@/, "@", $1); print $1; exit }' "healthlog-$TAG-image.txt")" \
  --owner MBombeck \
  --signer-workflow MBombeck/HealthLog/.github/workflows/image-provenance.yml \
  --source-ref "refs/tags/$TAG"
```

The cosign command checks the image the manifest names, pinned by its digest. Older releases have no assets; verify their image with `cosign verify` alone. Details: [docs/ops/deploy.md](docs/ops/deploy.md#verify-a-release-from-its-assets).

If you discover a tampered or unexpected image, please report it as a vulnerability via the email above.
