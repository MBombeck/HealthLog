# Coolify env audit — v1.4.34 IW-A

Read-only audit of HealthLog application environment variables on
both Coolify control planes. No deletes were performed — operator
action only. Captured via `mcp__coolify-apps01__env_vars` (list) and
attempted on `mcp__coolify-edge01__env_vars`.

## apps-01

- Application UUID: `pg8wggwogo8c4gc4ks0kk4ss`
- MCP listing: 56 entries returned — **two distinct sections** with
  heavy overlap. Section 1 holds the live values; section 2 is the
  Compose-default leftover documented in `CHANGELOG.md` against
  v1.3.0 / v1.3.1.

### Duplicate-key inventory

The following keys appear twice in the listing. Runtime reads the
first match (section 1) so all containers are healthy; the second
entry is dead state that should be cleaned by the operator. For
each pair the **first** UUID is the live entry (section 1, keep)
and the **second** is the leftover (section 2, candidate for
delete).

| Key | Live UUID (keep) | Leftover UUID (delete candidate) | Section 2 value status |
| --- | --- | --- | --- |
| `SESSION_SECRET` | `l4oos4w4gsss40wc8swckgs8` | `e0k08w4so4o0s04o4ssgs40o` | duplicate of live |
| `ENCRYPTION_KEY` | `w4oogk8coo8cs0woso48wcko` | `lk4g8ccgss4g848oo0c4sssc` | duplicate of live |
| `NEXT_PUBLIC_APP_URL` | `owo0wcgsg4k8kwocgo4sgo8o` | `rogwgso0ggoowkok00ccs88k` | duplicate of live |
| `APP_URL` | `rw0gw8o40kcg00w0wgkg0sg4` | `cg4k8o4g4o40c8gk84cokg44` | duplicate of live |
| `SERVICE_URL_APP` | `x8kowg808s8swc4gsgg8s0ok` | `bgc0gwosgo0ogkc0cgk00sgc` | duplicate of live |
| `SERVICE_FQDN_APP` | `c4wwo0ows4sccww8w4008goc` | `ic480gggsscocogwgookc08w` | duplicate of live |
| `NODE_ENV` | `bcsocssk44k0gk8ogk8kgwgg` | `z000ck0c80gw04s44wo0kc4g` | duplicate of live |
| `DATABASE_URL` | `w8w8gc08sgo48o8008ww04gk` | `rsssgk044kk0o88s808c0oss` | duplicate of live |
| `WITHINGS_WEBHOOK_SECRET` | `ukg48co804wgc8cg0owoc08w` | `ggw8g8cck08g4g0c8wgoss8w` | duplicate of live |
| `TELEGRAM_WEBHOOK_SECRET` | `t4kcsoos0owos0s88gk8048c` | `j88w800c0okoccs4o4cosc8k` | duplicate of live |
| `API_TOKEN_HMAC_KEY` | `okc8oc0040o0osgwkw8skw84` | `nkwskw4sg0kocs0g88oos8k8` | duplicate of live |
| `POSTGRES_PASSWORD` | `psjxz586keglg80frlc0hilg` | `d3r4k1lryj6n0z7dfj4hhc8t` | **placeholder** (`"POSTGRES_PASSWORD is required"`) |
| `ENCRYPTION_KEYS` | `at1c0vull7e7vk9523hcc80t` | `kjayo0cxdln9fch16nu6wu7e` | duplicate empty |
| `ENCRYPTION_ACTIVE_KEY_ID` | `n1epx7zsil59ccqoq4n5uqid` | `h11b5osnw7v529y8z24qth62` | duplicate empty |
| `HEALTHLOG_PROCESS_TYPE` | `hfqzybbaampdzopgpt7p1xg9` | `o122uz9phhwsm2kvjrxrlr66` | duplicate of live |
| `BACKUP_ENCRYPTION_KEY` | `g6vv1spge11o4tt1fkyigyjb` | `fzlrbd36vge73ew7bb8ku6nn` | duplicate empty |
| `BACKUP_S3_ENDPOINT` | `crbvrnkwpcykeiv27lafvm8s` | `o11i3plndsierpyryorxfilu` | duplicate empty |
| `BACKUP_S3_BUCKET` | `tq14klo5gdlezx8brzylv6iq` | `t13mnd7es5hh7cw9qfqsskyw` | duplicate empty |
| `BACKUP_S3_ACCESS_KEY` | `faf5cv9ofqkisue7106ny9kc` | `jl19emxjg2cf0m856ki6kph6` | duplicate empty |
| `BACKUP_S3_SECRET_KEY` | `pwcwgxf7zb1jpezdfm0f0kc7` | `dnkkfod9u40tbdn9linus5c6` | duplicate empty |
| `BACKUP_S3_REGION` | `w6pm5zcm0qxwue4l2nufik50` | `l26b630so2pnbeavrq7ds0f7` | duplicate (`auto`) |
| `BACKUP_RETENTION_DAYS` | `oy6nmqqeu4pdxm0e8cpannmo` | `uvinu9y7ccpgmfxxec0aw9t3` | duplicate (`30`) |
| `CODEX_MODEL` | `exg1hw68rfmgna36jwaic5xb` | `i9cv9whl6s3w9qry16of1hyh` | duplicate (`gpt-5.3-codex`) |
| `APNS_KEY_ID` | `jrvtf052djniva8ifmtiuhoq` | `r131ykziuu424ctdvapgypp5` | duplicate of live |
| `APNS_TEAM_ID` | `a6l55syi75dajt64ygbotjpl` | `lq8v02r1y0am43mr6l72q2vm` | duplicate of live |
| `APNS_BUNDLE_ID` | `hivufuvt7fedc72agdqkgfh0` | `jjp9okfgdjzugo1ujbwht700` | duplicate (`dev.healthlog.app`) |
| `APNS_PRODUCTION` | `qwhtb9mq0vi11nnz3smtqed5` | `tpr8eii2w2tqfbmvewombyds` | duplicate (`true`) |
| `APNS_KEY` | `bg530oqhr0uq5xvgn11d1mtk` | `oi3pjtwxoqh1pdov5x62hior` | duplicate of live |

### Section-2-only keys

One key sits in section 2 only — no section-1 counterpart:

- `CODEX_OAUTH_CLIENT_ID` — UUID `tb13v6mxr9ablewuyljzulx1`,
  value `app_EMoamEEZ73f0CkXaXp7hrann`. Operator decision whether
  this is the live source for the CLI client ID or a leftover.

### Recommended operator action

Highest priority: delete UUID `d3r4k1lryj6n0z7dfj4hhc8t`
(`POSTGRES_PASSWORD` placeholder). The other duplicates are
value-identical so they're functionally inert, but they clutter
the Coolify env-vars UI and make root-cause debugging harder on
the next deploy regression. Optional follow-up: bulk delete every
section-2 UUID listed above (excluding the unique
`CODEX_OAUTH_CLIENT_ID` entry which needs an operator decision
first).

No deletes were performed from this audit — the brief restricts
IW-A to read-only inspection.

## edge-01

MCP unreachable at audit time:

```
mcp__coolify-edge01__list_applications
 → Failed to connect to Coolify server at http://46.225.114.153:8000.
   Please check if the server is running and accessible.
```

Matches the iceberg note in `.planning/round-v1433-closure-report.md`
("edge-01 Coolify MCP unreachable"). Operator action: restart the
Coolify MCP daemon on edge-01 so the next round can reach env vars
via MCP. Until then the env audit on edge-01 must run over SSH:

```
ssh edge-01 'docker compose --project-directory \
  /data/coolify/applications/ck8cs4osswg8w440gskw08w8 \
  config --no-interpolate' | grep -E "^      [A-Z_]+:"
```

## Operator follow-ups seeded

1. Restart Coolify MCP daemon on edge-01.
2. Delete apps-01 env-var UUID `d3r4k1lryj6n0z7dfj4hhc8t` (the
   placeholder `POSTGRES_PASSWORD` leftover from v1.3.1).
3. Decide whether to bulk-prune the remaining section-2 duplicates
   listed in the inventory above.
4. Confirm intent for `CODEX_OAUTH_CLIENT_ID` (section-2-only
   entry); promote to section 1 or delete.
