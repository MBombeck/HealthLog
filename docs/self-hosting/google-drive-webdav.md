# A Google Drive folder as the Health Connect source

HealthLog can fetch the scheduled Health Connect export from a WebDAV folder
on its own, about every six hours (see
[the Health Connect import](../integrations/health-connect.md#fetching-the-scheduled-export-from-a-folder)).
Google Drive does not speak WebDAV, but one rclone container next to
HealthLog can serve a Drive folder as WebDAV. HealthLog then reads the file
from that container exactly as from a Nextcloud folder; nothing in HealthLog
changes.

The container is reachable only from the HealthLog containers. It publishes
no port, and it gets a read-only view of one folder.

## 1. Export to Drive on the phone

In Health Connect, set up a **Scheduled export** into Google Drive and pick a
folder for it, for example `Health Connect`. The file it writes is
`Health Connect.zip` unless the phone names it differently.

## 2. Create the rclone remote

rclone keeps the Drive login in a config file. Create it once, in a
directory beside the HealthLog `docker-compose.yml`:

```sh
mkdir -p rclone
docker run --rm -it -v "$PWD/rclone:/config/rclone" rclone/rclone config
```

In the prompts:

1. `n` for a new remote, name it `gdrive`.
2. Storage: `drive` (Google Drive).
3. `client_id` and `client_secret`: leave empty, or enter your own OAuth
   client from the Google Cloud console (Google throttles the shared one).
4. Scope: `drive.readonly`. HealthLog only reads the file.
5. `root_folder_id`: leave empty; the folder is chosen when serving.
6. Advanced config: `n`.
7. "Use web browser to automatically authenticate": on a server without a
   browser answer `n`, run the `rclone authorize "drive" ...` line it prints
   on a computer that has rclone and a browser, sign in with the Google
   account that holds the export, and paste the token back.
8. Shared drive: `n`, then `y` to keep the remote.

Check that rclone sees the file:

```sh
docker run --rm -v "$PWD/rclone:/config/rclone" rclone/rclone ls "gdrive:Health Connect"
```

The config file holds the Drive token. Keep it readable only by the account
that runs Docker (`chmod 600 rclone/rclone.conf`).

## 3. Add the container

Put this in a `docker-compose.override.yml` next to the HealthLog
`docker-compose.yml`, so Compose starts it in the same project and network:

```yaml
services:
  rclone:
    image: rclone/rclone:latest # pin a release tag once it works
    restart: unless-stopped
    command:
      - serve
      - webdav
      - "gdrive:Health Connect"
      - --addr=:8080
      - --read-only
    environment:
      RCLONE_USER: healthlog
      RCLONE_PASS: ${RCLONE_WEBDAV_PASSWORD:?set RCLONE_WEBDAV_PASSWORD in .env}
    volumes:
      - ./rclone:/config/rclone
```

Then add two lines to `.env` and run `docker compose up -d`:

```env
RCLONE_WEBDAV_PASSWORD=<a long random value, e.g. from openssl rand -base64 32>
HEALTH_CONNECT_WEBDAV_PRIVATE_ORIGINS=http://rclone:8080
```

`HEALTH_CONNECT_WEBDAV_PRIVATE_ORIGINS` is needed because `rclone` resolves
to an address inside the Docker network, which HealthLog refuses unless its
exact origin is listed. Plain `http` is acceptable here: the traffic never
leaves the Docker network. If the variable is already set, append the origin
with a comma.

## 4. Enter it in HealthLog

Open **Settings > Integrations > Health Connect from a folder** and enter:

- Folder address: `http://rclone:8080/`
- File name: `Health Connect.zip`
- User name: `healthlog`
- Password: the value of `RCLONE_WEBDAV_PASSWORD`

Save, then press **Fetch now** once to see the first import. After that
HealthLog reads the file about every six hours; a file it has already
imported is skipped.

## When it does not work

- **Not found:** the folder or file name differs. Run the `rclone ls` check
  above and match the names exactly, spaces included.
- **Address not allowed:** the origin in
  `HEALTH_CONNECT_WEBDAV_PRIVATE_ORIGINS` does not match the folder address
  (scheme, host and port), or the app container was not recreated after the
  change.
- **Server error after weeks of working:** the Drive token expired or was
  revoked. Run `rclone config reconnect gdrive:` in the same way as step 2,
  then restart the container.
