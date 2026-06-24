# Contributing

Thanks for your interest in pam-approver. This is a small, security-sensitive
project, so the process is deliberately lightweight but strict on review and CI.

## Reporting issues

- **Bugs / features:** open a GitHub issue —
  https://github.com/schack/pam-approver/issues
- **Security vulnerabilities:** do **not** open a public issue. Follow
  [SECURITY.md](SECURITY.md) (GitHub private advisory or email).

## Pull requests

`main` is protected: changes land via pull request only.

1. Branch off `main` and open a PR.
2. Every PR must pass the required CI checks before it can merge:
   - **`test`** — hadolint (Dockerfile), shellcheck (`entrypoint.sh`),
     shell tests, JS tests, and container header tests.
   - **`build`** — the image builds cleanly.
3. Keep the branch up to date with `main` (the ruleset requires it).
4. Keep changes focused; explain the *why* in the PR description.

## Tests

Tests live in `tests/` and run in CI, but please run them locally first:

```bash
sh tests/entrypoint_test.sh     # entrypoint.sh env validation / config.js
node --test                     # pure helpers in public/app.js
sh tests/nginx_headers_test.sh  # builds the image, asserts response headers
```

**Policy:** changes to `public/app.js` or `entrypoint.sh` should add or extend a
test that covers the new behaviour. Bug fixes should come with a test that fails
without the fix.

## Style

Match the surrounding code — no new runtime dependencies (the app ships zero JS
deps by design), keep the Dockerfile hadolint-clean and shell shellcheck-clean.
