#!/bin/sh
# Integration test: build the image, run it, and assert each route returns
# exactly ONE correct Content-Type header. Guards against the `add_header
# Content-Type` anti-pattern, which appends a second Content-Type (and, for
# unmapped types like .webmanifest, leaves the octet-stream fallback first —
# which browsers reject under nosniff).
#
# Self-contained: builds its own throwaway image and cleans up. Skips cleanly
# when docker is unavailable so the rest of the suite still runs.
set -u

if ! command -v docker >/dev/null 2>&1; then
  echo "SKIP - docker not available"
  exit 0
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE="pam-approver:headers-test"
NAME="pam-approver-headers-test"
PORT="18080"
BASE="http://127.0.0.1:$PORT"

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

echo "building image…"
DOCKER_BUILDKIT=1 docker build -q -t "$IMAGE" "$ROOT" >/dev/null

docker run -d --name "$NAME" -p "$PORT:8080" \
  -e OAUTH_CLIENT_ID=123-abc.apps.googleusercontent.com \
  -e PAM_PROJECTS=proj-1,proj-2 \
  "$IMAGE" >/dev/null

# Wait for readiness.
i=0
while [ "$i" -lt 30 ]; do
  curl -fsS -o /dev/null "$BASE/healthz" 2>/dev/null && break
  i=$((i + 1)); sleep 1
done

pass=0
fail=0

# Asserts the route returns exactly one Content-Type and it equals $2.
assert_single_ct() {
  path=$1; want=$2
  cts="$(curl -fsSI "$BASE$path" 2>/dev/null | tr -d '\r' \
         | awk -F': ' 'tolower($1)=="content-type"{print $2}')"
  n="$(printf '%s\n' "$cts" | grep -c .)"
  if [ "$n" -eq 1 ] && [ "$cts" = "$want" ]; then
    pass=$((pass + 1)); printf 'ok   - %s -> %s\n' "$path" "$cts"
  else
    fail=$((fail + 1))
    printf 'FAIL - %s: want single %s, got [%s]\n' "$path" "$want" "$(printf '%s' "$cts" | tr '\n' '|')"
  fi
}

assert_single_ct /config.js        application/javascript
assert_single_ct /site.webmanifest application/manifest+json
assert_single_ct /healthz          text/plain
assert_single_ct /app.js           application/javascript
assert_single_ct /styles.css       text/css

printf '\n%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
