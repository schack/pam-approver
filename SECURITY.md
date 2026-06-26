# Security Policy

## Supported versions

This project ships a single rolling container image. Security fixes are applied
to the latest release only; always run the most recent `:latest` (or a pinned
digest of it). Older tags are not patched.

## Reporting a vulnerability

Please report security issues privately — do **not** open a public issue.

- Preferred: GitHub private vulnerability reporting via the **Security** tab →
  **Report a vulnerability** (https://github.com/schack/pam-approver/security/advisories/new).
- Alternatively, email henrik@schack.dk.

Please include reproduction steps and the affected version/digest. You can
expect an acknowledgement within a few days. Once a fix is available, a new
image is published and the advisory disclosed.

## Security model

pam-approver is a static single-page app — nginx serves HTML/JS/CSS and the
browser talks directly to the Google Privileged Access Manager API. There is no
backend and no server-side state.

- **No long-lived secrets.** No client secret is used (SPA OAuth) and there are
  no refresh tokens. The Google OAuth **client ID is public** by design (it
  ships in `/config.js`) and is not a secret.
- **Access tokens stay in the browser.** Sign-in yields a ~1h access token held
  in `sessionStorage` (cleared when the tab closes); it is sent only as a Bearer
  header to `*.googleapis.com`, never logged, and never written to the image.
- **Authorization is enforced by Google IAM**, not by this app — approvers can
  only act on grants their account already has `pam.grants.approve` on.
- **Hardened runtime.** The image runs as a non-root user (uid 101) on a
  read-only root filesystem, drops all Linux capabilities, and sets a strict
  Content-Security-Policy plus the usual hardening headers. `entrypoint.sh`
  validates its environment to prevent breaking out of the rendered `config.js`.
  The sample Kubernetes manifests in [`k8s/`](k8s/) add pod-level hardening on
  top (seccomp `RuntimeDefault`, no ServiceAccount token mounted, and a posture
  that satisfies the Restricted Pod Security Standard).

## Maintainers and access to sensitive resources

pam-approver is maintained by a single person, Henrik Schack (@schack), who
holds admin access to the GitHub repository and publish access to the GHCR
container package.

As the sole maintainer, @schack is responsible for all project roles: reviewing
and merging pull requests, cutting and signing releases, keeping dependencies
current, and triaging and resolving bug and security reports. There are no other
members or delegated roles at this time.

There are no long-lived secrets or signing keys to manage: release images are
signed keyless via GitHub OIDC (Sigstore cosign), the OAuth client ID is public
by design (not a secret), and no client secret or deployment credential is
stored in the repository or the image.

## Verifying the image

Release images are signed with Sigstore **cosign** (keyless) and ship **SBOM**
and **SLSA provenance** attestations. Verify the signature with:

```bash
cosign verify ghcr.io/schack/pam-approver:latest \
  --certificate-identity-regexp '^https://github.com/schack/pam-approver/' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

Inspect the embedded provenance/SBOM attestations with:

```bash
docker buildx imagetools inspect ghcr.io/schack/pam-approver:latest
```
