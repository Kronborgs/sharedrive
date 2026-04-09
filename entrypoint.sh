#!/bin/sh
set -e

# Start Gotenberg (LibreOffice PDF converter) in the background.
# It listens on localhost:3000 and is only reachable within this container.
/usr/bin/gotenberg \
  --api-timeout=60s \
  --libreoffice-restart-after=10 \
  --log-level=warn &

# Exec Sharedrive as the main process — receives Docker signals (SIGTERM etc.)
exec /usr/local/bin/privatedrive "$@"
