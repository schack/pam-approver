# Sample Kubernetes manifests

Example manifests for deploying pam-approver on **GKE** behind the
[Gateway API](https://gateway-api.sigs.k8s.io/) with
[Identity-Aware Proxy (IAP)](https://cloud.google.com/iap/docs) in front.
They are a starting point, not a drop-in: sanitise the placeholder values
below before applying.

## What's here

| File | Purpose |
|------|---------|
| `namespace.yaml` | The `pam-approver` namespace. |
| `deployment.yaml` | The nginx pod. Runs non-root (uid/gid 101), read-only root filesystem, all caps dropped, `seccompProfile: RuntimeDefault`, no ServiceAccount token mounted; writable state is on `emptyDir` mounts. |
| `service.yaml` | `ClusterIP` Service on port 8080. |
| `http-route.yaml` | Gateway API `HTTPRoute` binding the hostname to the Service. |
| `backend-policy.yaml` | GKE `GCPBackendPolicy` enabling IAP + access logging. |
| `healthchecks.yaml` | GKE `HealthCheckPolicy` pointing the LB health check at `/healthz`. |
| `kustomization.yaml` | Ties it together and generates the runtime-config ConfigMap. |

`backend-policy.yaml` and `healthchecks.yaml` use GKE-specific CRDs
(`networking.gke.io/v1`). On another platform, drop them and gate access
with your own auth proxy / Ingress instead — but note IAP is what
authenticates users in front of the pod, so don't expose this app
unauthenticated.

## Before you apply

Edit `kustomization.yaml`, `http-route.yaml` and `deployment.yaml`:

- `OAUTH_CLIENT_ID` — the **prod** OAuth Web client ID (see the repo README,
  "OAuth client setup"). It ships in `/config.js` so it's not secret, but keep
  it out of git via your secret manager if you prefer.
- `HOSTED_DOMAIN` — your Google Workspace domain, or empty to allow any
  Google account.
- `PAM_PROJECTS` — comma-separated GCP project IDs to scan for entitlements.
- `hostnames` in `http-route.yaml` — your real hostname (e.g. `pam.example.com`).
- `parentRefs` in `http-route.yaml` — the name/namespace of your existing
  GKE Gateway.
- `image` in `deployment.yaml` — pin by digest for production
  (`ghcr.io/schack/pam-approver@sha256:...`); see the repo README for cosign
  verification.

## Apply

Run from the repo root (the paths below are relative to it):

```bash
# Preview the rendered manifests
kubectl kustomize k8s/

# Apply
kubectl apply -k k8s/
```
