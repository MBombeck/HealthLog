# Security documentation

How HealthLog protects the data it holds, written for operators, reviewers
and contributors. Each page names the code that implements what it says;
where a page and the code disagree, the code is right and the page is a bug.

| Page                                                  | Covers                                                                                                                                                                |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Authentication and sessions](authentication.md)      | Every sign-in pathway and its strength, guessing and credential-stuffing controls, the first account, second-factor policy, step-up, session lifetimes and the cookie |
| [Authorization](authorization.md)                     | Roles, Bearer scopes, sharing grants and managed profiles, URL credentials, module and AI gating, field-level rules, a function-by-role table                         |
| [Key management](key-management.md)                   | Every key and secret, who holds it, rotation and what it breaks, compromise response, the cryptographic inventory, credential formats                                 |
| [Data classification](data-classification.md)         | Data kinds and protection levels, what each level requires (encryption, logging, retention, access, browser storage, backups)                                         |
| [Logging](logging.md)                                 | The log inventory per layer, what is never logged, the audit log and its protection, the security events, shipping logs off the host                                  |
| [Network egress](network-egress.md)                   | Every outbound destination with its trigger and off switch, the fields that take an address, an operator allowlist                                                    |
| [Limits](limits.md)                                   | Rate limits, size caps, quotas and AI budgets                                                                                                                         |
| [File handling](file-handling.md)                     | Accepted file types and sizes per upload, archive limits, how files are served, the residual risk without a virus scanner                                             |
| [Cycle-data threat model](cycle-data-threat-model.md) | What self-hosting and encryption at rest do and do not protect for reproductive-health data                                                                           |

Related elsewhere:

- [`SECURITY.md`](../../SECURITY.md): reporting a vulnerability, supported
  versions, verifying a release image.
- [`contributing/release-policy.md`](../contributing/release-policy.md#third-party-updates):
  how fast fixes and dependency updates ship.
- Operator runbooks: [`ops/security-recovery.md`](../ops/security-recovery.md),
  [`ops/encryption-key-rotation.md`](../ops/encryption-key-rotation.md),
  [`ops/backup-restore.md`](../ops/backup-restore.md),
  [`ops/disaster-recovery.md`](../ops/disaster-recovery.md),
  [`ops/mfa-enforcement.md`](../ops/mfa-enforcement.md).
- Operator setup: [`self-hosting/reverse-proxy.md`](../self-hosting/reverse-proxy.md),
  [`self-hosting/database-role.md`](../self-hosting/database-role.md),
  [`self-hosting/secrets.md`](../self-hosting/secrets.md),
  [`self-hosting/sso.md`](../self-hosting/sso.md),
  [`self-hosting/account-sharing.md`](../self-hosting/account-sharing.md).
