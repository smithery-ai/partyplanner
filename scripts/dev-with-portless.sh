#!/bin/sh
set -e

if [ "$PORTLESS" = "0" ]; then
  exec turbo run dev --ui=tui
fi

cat <<'EOF'
Starting Portless for local HTTPS dev URLs.
If macOS asks for sudo, it is so Portless can bind the HTTPS proxy on port 443
and trust its local development certificate. This keeps https://hylo.localhost
and https://api.hylo.localhost working without any global installs.
EOF

portless proxy start
exec turbo run dev --ui=tui
