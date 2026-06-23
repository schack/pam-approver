#!/bin/sh
# Tests for entrypoint.sh: env validation (the JS-string-injection defense in
# check_value) and the rendered config.js. Pure POSIX sh, no dependencies.
#
# entrypoint.sh ends with `exec nginx`, so we put a stub `nginx` on PATH that
# just exits 0, and point CONFIG_OUT at a temp file to inspect what was written.
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENTRYPOINT="$ROOT/entrypoint.sh"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$TMP/bin"
printf '#!/bin/sh\nexit 0\n' > "$TMP/bin/nginx"
chmod +x "$TMP/bin/nginx"

CONFIG_OUT="$TMP/config.js"
export CONFIG_OUT

pass=0
fail=0

# run_entrypoint: runs entrypoint.sh with the currently-exported env, the stub
# nginx first on PATH, into a fresh CONFIG_OUT. Sets $rc to the exit code.
run_entrypoint() {
  rm -f "$CONFIG_OUT"
  PATH="$TMP/bin:$PATH" sh "$ENTRYPOINT" >/dev/null 2>&1
  rc=$?
}

reset_env() {
  unset OAUTH_CLIENT_ID PAM_PROJECTS HOSTED_DOMAIN 2>/dev/null || true
}

ok()   { pass=$((pass + 1)); printf 'ok   - %s\n' "$1"; }
bad()  { fail=$((fail + 1)); printf 'FAIL - %s\n' "$1"; }

expect_exit_zero()    { run_entrypoint; [ "$rc" -eq 0 ] && ok "$1" || bad "$1 (exit $rc)"; }
expect_exit_nonzero() { run_entrypoint; [ "$rc" -ne 0 ] && ok "$1" || bad "$1 (expected failure, got exit 0)"; }

expect_config_contains() {
  if grep -qF "$1" "$CONFIG_OUT" 2>/dev/null; then ok "$2"; else bad "$2 (config.js missing: $1)"; fi
}

# ---- valid inputs -----------------------------------------------------------

reset_env
OAUTH_CLIENT_ID="123-abc.apps.googleusercontent.com"; export OAUTH_CLIENT_ID
PAM_PROJECTS="proj-1,proj-2"; export PAM_PROJECTS
expect_exit_zero "valid minimal (no HOSTED_DOMAIN) renders"
expect_config_contains "window.PAM_CONFIG = Object.freeze({" "config.js is well-formed"
expect_config_contains "clientId: \"123-abc.apps.googleusercontent.com\"" "config.js carries clientId"
expect_config_contains "\"proj-1,proj-2\".split(\",\")" "config.js carries projects"
expect_config_contains "hostedDomain: \"\"" "empty HOSTED_DOMAIN renders as empty string"

reset_env
OAUTH_CLIENT_ID="123-abc.apps.googleusercontent.com"; export OAUTH_CLIENT_ID
PAM_PROJECTS="proj-1"; export PAM_PROJECTS
HOSTED_DOMAIN="sub.example.com"; export HOSTED_DOMAIN
expect_exit_zero "valid with HOSTED_DOMAIN renders"
expect_config_contains "hostedDomain: \"sub.example.com\"" "config.js carries hostedDomain"

# ---- required vars ----------------------------------------------------------

reset_env
PAM_PROJECTS="proj-1"; export PAM_PROJECTS
expect_exit_nonzero "missing OAUTH_CLIENT_ID is rejected"

reset_env
OAUTH_CLIENT_ID="123-abc.apps.googleusercontent.com"; export OAUTH_CLIENT_ID
expect_exit_nonzero "missing PAM_PROJECTS is rejected"

reset_env
OAUTH_CLIENT_ID="123-abc.apps.googleusercontent.com"; export OAUTH_CLIENT_ID
PAM_PROJECTS=",,-,"; export PAM_PROJECTS
expect_exit_nonzero "PAM_PROJECTS with no real project id is rejected"

# ---- injection defense (check_value) ----------------------------------------
# Each value contains a character outside the allowlist and must be rejected
# before it can break out of the JS string literals in config.js.

reset_env
PAM_PROJECTS="proj-1"; export PAM_PROJECTS
OAUTH_CLIENT_ID='abc";evil()//'; export OAUTH_CLIENT_ID
expect_exit_nonzero "OAUTH_CLIENT_ID with quote/paren is rejected"

reset_env
PAM_PROJECTS="proj-1"; export PAM_PROJECTS
OAUTH_CLIENT_ID='abc def'; export OAUTH_CLIENT_ID
expect_exit_nonzero "OAUTH_CLIENT_ID with space is rejected"

reset_env
PAM_PROJECTS="proj-1"; export PAM_PROJECTS
OAUTH_CLIENT_ID='a$b`c'; export OAUTH_CLIENT_ID
expect_exit_nonzero "OAUTH_CLIENT_ID with shell metachars is rejected"

reset_env
OAUTH_CLIENT_ID="123-abc.apps.googleusercontent.com"; export OAUTH_CLIENT_ID
PAM_PROJECTS="$(printf 'proj-1\nevil')"; export PAM_PROJECTS
expect_exit_nonzero "PAM_PROJECTS with newline is rejected"

reset_env
OAUTH_CLIENT_ID="123-abc.apps.googleusercontent.com"; export OAUTH_CLIENT_ID
PAM_PROJECTS='proj/../evil'; export PAM_PROJECTS
expect_exit_nonzero "PAM_PROJECTS with slash is rejected"

reset_env
OAUTH_CLIENT_ID="123-abc.apps.googleusercontent.com"; export OAUTH_CLIENT_ID
PAM_PROJECTS="proj-1"; export PAM_PROJECTS
HOSTED_DOMAIN='evil.com"'; export HOSTED_DOMAIN
expect_exit_nonzero "HOSTED_DOMAIN with quote is rejected"

# ---- summary ----------------------------------------------------------------

printf '\n%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
