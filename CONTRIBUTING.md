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

## Releases

Releases are **draft-then-publish**, so you decide when a batch of merges
becomes a version. You never write a version number or a changelog by hand.

**How it works**

- On every merge to `main`, the `Release Drafter` workflow updates a single
  *draft* release (private to maintainers; discoverers never see it). It lists
  each merged PR under a category and proposes the next version.
- Versions are **CalVer `YEAR.MONTH.SEQUENCE`**, computed automatically: the
  third number counts releases already cut this month, so a batch of merges
  keeps the same proposed version until one is published, then the next bumps.
  Example: first release in June 2026 is `2026.6.0`, the next is `2026.6.1`,
  the first in July is `2026.7.0`.

**Getting a PR into the right category**

Categories come from PR **labels**, which the autolabeler applies from the
branch name or PR title, so usually you do nothing:

| Category        | Label          | Triggered by                                   |
|-----------------|----------------|------------------------------------------------|
| Features        | `enhancement`  | branch `feat/…` or title `feat: …`             |
| Fixes           | `fix`          | branch `fix/…` or title `fix: …`               |
| Security        | `security`     | branch `security/…` or "security" in the title |
| Dependencies    | `dependencies` | added automatically on Dependabot PRs          |

If a PR lands with no matching label, just add one of the labels above and the
draft updates. (Config: `.github/release-drafter.yml`.)

**Cutting a release**

1. Go to the repo's **Releases**, open the draft, and check the notes.
2. Click **Publish**. That creates the CalVer tag and triggers the CD pipeline
   to build, sign, and push the image as `:X.Y.Z`, `:X.Y`, and `:latest` (see
   [Container image](README.md#container-image)).

## Style

Match the surrounding code — no new runtime dependencies (the app ships zero JS
deps by design), keep the Dockerfile hadolint-clean and shell shellcheck-clean.
