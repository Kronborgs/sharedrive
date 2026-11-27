#!/bin/sh
set -e

# Allow the container's user/group to be remapped at runtime.
# Set PUID and PGID in your docker-compose.yml (or -e flags) to match
# the uid/gid that owns your host-mounted /data volume.
# Defaults to 1000:1000 if not set.
PUID=${PUID:-1000}
PGID=${PGID:-1000}

if [ "${PUID}" != "1000" ] || [ "${PGID}" != "1000" ]; then
  groupmod -o -g "${PGID}" sharedrive
  usermod  -o -u "${PUID}" sharedrive
fi

# Pre-create backup subdirectories if BACKUPS_ROOT is set and accessible.
# USB/NAS drives are often mounted as root; creating the subdirs here (before
# dropping to the app process) ensures the sharedrive user can write inside them.
if [ -n "${BACKUPS_ROOT}" ] && [ -d "${BACKUPS_ROOT}" ]; then
  mkdir -p "${BACKUPS_ROOT}/tertiary" "${BACKUPS_ROOT}/buddy" 2>/dev/null || true
  chown -R "${PUID}:${PGID}" "${BACKUPS_ROOT}" 2>/dev/null || true
fi

# Ensure data directories are writable by the sharedrive user.
chown -R "${PUID}:${PGID}" /data 2>/dev/null || true

# Start Gotenberg (LibreOffice PDF converter) in the background.
# It listens on localhost:3000 and is only reachable within this container.
/usr/bin/gotenberg \
  --api-timeout=60s \
  --libreoffice-restart-after=10 \
  --log-level=warn &

# Run the bundled Mailcow service on loopback. An explicitly supplied token
# selects an external companion service, such as the optional Compose overlay.
if [ -z "${SHAREDRIVE_MAILCOW_TOKEN:-}" ]; then
  SHAREDRIVE_MAILCOW_TOKEN=$(/usr/local/bin/sharedrive-node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))')
  export SHAREDRIVE_MAILCOW_TOKEN
  su-exec sharedrive env -i \
    SHAREDRIVE_MAILCOW_TOKEN="$SHAREDRIVE_MAILCOW_TOKEN" \
    SHAREDRIVE_MAILCOW_PORT="${SHAREDRIVE_MAILCOW_PORT:-3025}" \
    SHAREDRIVE_MAILCOW_SMTP_PORT="${SHAREDRIVE_MAILCOW_SMTP_PORT:-465}" \
    DATA_DIR="${SHAREDRIVE_MAILCOW_DATA_DIR:-/data/backups/.mailcow-suite}" \
    /usr/local/bin/sharedrive-node /opt/sharedrive-mailcow/src/index.mjs &
fi

# Drop privileges: exec the app as the non-root sharedrive user.
exec su-exec sharedrive /usr/local/bin/privatedrive "$@"
