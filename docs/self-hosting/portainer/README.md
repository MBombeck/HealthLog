# HealthLog on Portainer

HealthLog ships a Portainer **app template** that deploys the app and its
PostgreSQL 18 database as one stack from the project `docker-compose.yml`.

## Add the template

1. In Portainer, go to **Settings → App Templates**.
2. Set the URL to the raw template file:

   ```
   https://raw.githubusercontent.com/MBombeck/HealthLog/main/docs/self-hosting/portainer/templates.json
   ```

3. Save. **HealthLog** now appears under **App Templates**.

## Deploy

1. Open **App Templates → HealthLog**.
2. Fill in the variables. Generate each secret with `openssl rand -hex 32` (a
   64-character hex string):
   - `POSTGRES_PASSWORD`
   - `ENCRYPTION_KEY` — back this up; losing it makes encrypted data
     unrecoverable
   - `API_TOKEN_HMAC_KEY`
   - `SESSION_COOKIE_SECURE` — **set to `false` for plain-HTTP / LAN access**, or
     login silently fails. Set to `true` only behind an HTTPS reverse proxy.
   - `NEXT_PUBLIC_APP_URL` and `APP_URL` — how you reach the app, e.g.
     `http://nas:3000` or `https://healthlog.example.com`.
3. **Deploy the stack**. The app waits for PostgreSQL, runs database migrations
   on first boot, then starts serving.
4. Open the app URL. The first registered user becomes the admin.

Verify the running version:

```bash
curl -s http://<host>:3000/api/version
```

## Notes

- Persistent state lives in one named volume (`postgres-data`, the Postgres data);
  the app container is stateless. Back up the database to back up everything.
- Pin a release tag (`HEALTHLOG_IMAGE_REF=:vX.Y.Z`) for deliberate upgrades, or
  track `:latest`. Skim the
  [CHANGELOG](https://github.com/MBombeck/HealthLog/blob/main/CHANGELOG.md) and
  back up before upgrading. Migrations are forward-only.
- For passive discovery you can also submit this template to the community
  aggregator at https://github.com/Lissy93/portainer-templates.
