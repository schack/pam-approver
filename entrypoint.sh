#!/bin/sh
# Render config.js from runtime env, then exec nginx in the foreground.
set -eu

: "${OAUTH_CLIENT_ID:?OAUTH_CLIENT_ID is required}"
: "${PAM_PROJECTS:?PAM_PROJECTS is required (comma-separated GCP project IDs)}"
HOSTED_DOMAIN="${HOSTED_DOMAIN:-}"

# Defence in depth: refuse values that contain characters outside the
# expected set so they cannot escape the JS string literals below.
check_value() {
  name=$1; value=$2; pattern=$3
  case "$value" in
    *[!${pattern}]*) echo "Invalid $name: contains characters outside [${pattern}]" >&2; exit 1 ;;
  esac
}

check_value OAUTH_CLIENT_ID "$OAUTH_CLIENT_ID" 'a-zA-Z0-9._-'
# GCP project IDs are 6-30 chars of [a-z0-9-]; comma-separated, no spaces.
check_value PAM_PROJECTS    "$PAM_PROJECTS"    'a-z0-9,-'
# Reject values that pass the charset check but hold no actual project id
# (e.g. "," or "-,-"), which would render an empty projects list.
case "$PAM_PROJECTS" in
  *[a-z0-9]*) ;;
  *) echo "Invalid PAM_PROJECTS: no project IDs found" >&2; exit 1 ;;
esac
if [ -n "$HOSTED_DOMAIN" ]; then
  check_value HOSTED_DOMAIN "$HOSTED_DOMAIN" 'a-zA-Z0-9.-'
fi

# config.js lives outside the static asset dir so we can run with
# readOnlyRootFilesystem=true (Kubernetes overlays an emptyDir at this path).
# nginx serves it via an alias in default.conf. CONFIG_OUT is overridable so
# tests can render to a temp file instead of the runtime path.
OUT="${CONFIG_OUT:-/var/lib/pam-approver/config.js}"
cat > "$OUT" <<EOF
window.PAM_CONFIG = Object.freeze({
  clientId: "${OAUTH_CLIENT_ID}",
  hostedDomain: "${HOSTED_DOMAIN}",
  projects: "${PAM_PROJECTS}".split(",").map(function (s) { return s.trim(); }).filter(Boolean)
});
EOF

exec nginx -g 'daemon off;'
