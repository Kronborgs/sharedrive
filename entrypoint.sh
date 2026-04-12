#!/bin/sh
set -e

# Pre-create backup subdirectories if BACKUPS_ROOT is set and accessible.
# USB/NAS drives are often mounted as root; creating the subdirs here (before
# dropping to the app process) ensures uid 1000 can write inside them.
if [ -n "${BACKUPS_ROOT}" ] && [ -d "${BACKUPS_ROOT}" ]; then
  mkdir -p "${BACKUPS_ROOT}/tertiary" "${BACKUPS_ROOT}/buddy" 2>/dev/null || true
  chown -R 1000:1000 "${BACKUPS_ROOT}" 2>/dev/null || true
fi

# Ensure data directories are writable by the sharedrive user.
chown -R 1000:1000 /data 2>/dev/null || true

# Start Gotenberg (LibreOffice PDF converter) in the background.
# It listens on localhost:3000 and is only reachable within this container.
/usr/bin/gotenberg \
  --api-timeout=60s \
  --libreoffice-restart-after=10 \
  --log-level=warn &

# Drop privileges: exec the app as the non-root sharedrive user (uid 1000).
# This limits any exploit to the sharedrive user's permissions.
exec su-exec sharedrive /usr/local/bin/privatedrive "$@"
