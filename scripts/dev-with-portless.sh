#!/bin/sh
set -e

run_turbo() {
  if [ "${INFISICAL:-1}" != "0" ] && command -v infisical >/dev/null 2>&1; then
    exec infisical run -- turbo run dev --ui=tui
  fi

  exec turbo run dev --ui=tui
}

if [ "$PORTLESS" = "0" ]; then
  run_turbo
fi

cat <<'EOF'
Starting Portless for local HTTPS dev URLs.
If macOS asks for sudo, it is so Portless can bind the HTTPS proxy on port 443
and trust its local development certificate. This keeps https://hylo.localhost
and https://api-worker.hylo.localhost working without any global installs.
EOF

portless proxy start
run_turbo
