# Third-party notices

HealthLog is licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE). It ships software and data from other projects under their own licences. This file states the policy for what may ship, names the components that come from no package manager, and lists the licences the shipped dependency tree uses.

The full per-package list, with every licence and notice file the packages carry, is written while the container image is built:

- `/app/THIRD_PARTY_LICENSES.txt`: the application's packages (the production dependency tree, plus the build packages whose files end up in the output).
- `/opt/prisma-cli/THIRD_PARTY_LICENSES.txt`: the migration CLI installed from `docker/prisma-cli/package-lock.json`.

Read them from a running container with `docker compose exec app cat /app/THIRD_PARTY_LICENSES.txt`. Every release image also carries an SPDX SBOM attestation (`docker buildx imagetools inspect ghcr.io/mbombeck/healthlog:<tag> --format '{{ json .SBOM }}'`); the release pipeline checks that every npm package the SBOM reports appears in one of the two files.

## Policy

The project licence restricts use to noncommercial purposes. No GPL-family licence permits a combined work to carry such a restriction, so:

- **Allowed:** permissive licences (MIT, MIT-0, ISC, BSD-2-Clause, BSD-3-Clause, 0BSD, Apache-2.0, BlueOak-1.0.0, CC0-1.0, Unlicense, Zlib, Python-2.0, CC-BY-4.0).
- **Allowed for unmodified packages:** file-level copyleft (MPL-2.0, EPL-2.0). The files stay as published, and their source is where the package came from.
- **Allowed by name only:** the LGPL, for native libraries that are loaded dynamically and shipped unmodified, so a user can replace them. Today that is `@img/sharp-libvips-*` (libvips, LGPL-3.0-or-later; source at <https://github.com/libvips/libvips>).
- **Refused:** GPL, AGPL, SSPL, BUSL, non-commercial or share-alike licences on code, `UNLICENSED`, and any package without a readable licence.

A dual licence (`A OR B`) is fine when one alternative is allowed; `A AND B` needs both. `node scripts/third-party-notices.mjs` applies the policy in CI (the Lint, Typecheck & OpenAPI job) and fails when a dependency brings a licence that is refused, or one that is allowed but not yet listed below. A new licence is reviewed, then recorded with `node scripts/third-party-notices.mjs --write`.

## Components from no package manager

| Component                                                               | Where                                                     | Licence                                                                                                                                                                                       |
| ----------------------------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js runtime                                                         | base image `node:22-trixie-slim`                          | MIT, with the licences of its bundled dependencies in the Node.js `LICENSE` (<https://github.com/nodejs/node/blob/main/LICENSE>)                                                              |
| `pg_dump`, `pg_restore`, `libpq`                                        | copied from the official `postgres` image                 | PostgreSQL License (<https://www.postgresql.org/about/licence/>)                                                                                                                              |
| Debian packages of the base image                                       | `/usr/share/doc/<package>/copyright` inside the image     | as stated in each file; the SBOM lists them                                                                                                                                                   |
| Inter typeface                                                          | `src/app/fonts/inter/`                                    | SIL Open Font License 1.1 (`src/app/fonts/inter/OFL.txt`)                                                                                                                                     |
| Report Sans (doctor-report PDF fonts, subset from Noto Sans and Source) | `src/lib/doctor-report-pdf/fonts/`                        | SIL Open Font License 1.1 (`src/lib/doctor-report-pdf/fonts/OFL.txt`)                                                                                                                         |
| Tesseract language data (`deu`, `eng`, `4.0.0_best_int`)                | `public/tesseract/lang/`, from `@tesseract.js-data/*`     | Apache-2.0 (<https://github.com/tesseract-ocr/tessdata_best>)                                                                                                                                 |
| GeoLite2 City and ASN databases                                         | `/opt/geolite2/`, only in images built with a MaxMind key | CC BY-SA 4.0. This product includes GeoLite2 data created by MaxMind, available from <https://www.maxmind.com>. The databases are data the server reads; they are not combined with the code. |

## Licences in use

<!-- generated:begin (scripts/third-party-notices.mjs --write) -->

Licences in the shipped dependency tree:

- `(BSD-3-Clause OR GPL-2.0)`
- `(MIT AND Zlib)`
- `(MIT OR CC0-1.0)`
- `(MPL-2.0 OR Apache-2.0)`
- `0BSD`
- `Apache-2.0`
- `BSD-2-Clause`
- `BSD-3-Clause`
- `BlueOak-1.0.0`
- `CC-BY-4.0`
- `EPL-2.0`
- `ISC`
- `LGPL-3.0-or-later`
- `MIT`
- `MIT AND ISC`
- `MIT AND ISC AND BSD-3-Clause`
- `MIT OR SEE LICENSE IN FEEL-FREE.md`
- `MIT-0`
- `MPL-2.0`
- `Unlicense`

Packages whose licence names anything but a permissive licence:

- `@img/sharp-libvips-*`: `LGPL-3.0-or-later`
- `dompurify`: `(MPL-2.0 OR Apache-2.0)`
- `elkjs`: `EPL-2.0`
- `node-forge`: `(BSD-3-Clause OR GPL-2.0)`
- `rgbcolor`: `MIT OR SEE LICENSE IN FEEL-FREE.md`
- `web-push`: `MPL-2.0`

<!-- generated:end -->
