# syntax=docker/dockerfile:1.7

# Build the CSS bundle. Output is platform-independent so this stage runs
# on the build platform.
# Cooled (>21d), multi-arch, mirror.gcr.io for faster GCP pulls.
# Pin the tag *and* the digest so Dependabot stays on bookworm-slim
# (a bare digest tracks `latest`, which drifts onto the full Debian image).
FROM --platform=$BUILDPLATFORM mirror.gcr.io/library/debian:bookworm-20260824-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171 AS assets

ARG BUILDARCH
ARG TAILWIND_VERSION=4.3.3
ARG TAILWIND_SHA256_AMD64=dc61b3ac6b8c9ca874c0cc4c57b2409791a64c5540404ca5f5367360babc313a
ARG TAILWIND_SHA256_ARM64=55fd0b241214eff3de1e8ee4f22796662f2d2e7a49bcfca7477cfd0bac398195

WORKDIR /work

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# hadolint ignore=DL3008
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       curl \
       ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# This assets stage runs on $BUILDPLATFORM (the builder), not the target
# platform, so the Tailwind CLI must match the *builder's* arch (amd64 on the
# CI runner, arm64 on an Apple Silicon dev machine) or it can't execute. The
# CSS it emits is arch-independent, so it's built once and shared by every
# target platform of the multi-arch runtime image.
RUN set -eux; \
    case "${BUILDARCH:-amd64}" in \
      amd64) tw_arch=x64;   tw_sha=${TAILWIND_SHA256_AMD64} ;; \
      arm64) tw_arch=arm64; tw_sha=${TAILWIND_SHA256_ARM64} ;; \
      *) echo "Unsupported BUILDARCH: ${BUILDARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /usr/local/bin/tailwindcss \
      "https://github.com/tailwindlabs/tailwindcss/releases/download/v${TAILWIND_VERSION}/tailwindcss-linux-${tw_arch}"; \
    echo "${tw_sha}  /usr/local/bin/tailwindcss" | sha256sum -c -; \
    chmod +x /usr/local/bin/tailwindcss

COPY tailwind.input.css ./
COPY public ./public

RUN tailwindcss -i tailwind.input.css -o /work/styles.css --minify


# Runtime: stock nginx alpine-slim, non-root, custom config.
# Cooled (>21d), multi-arch, mirror.gcr.io for faster GCP pulls.
# The -slim variant drops the bundled dynamic modules (xslt, geoip,
# image-filter, njs, acme) and their image libs (libgd, libavif, ...) plus
# curl — none of which this static site uses. That alone cuts the runtime
# image from ~93 MB to ~21 MB. Healthcheck uses BusyBox wget below since
# slim ships no curl.
# Pin the tag *and* the digest: a bare digest gives Dependabot no variant
# to preserve, so it tracks `latest` and drifts onto the larger Debian
# image. Keep the suffix at the floating `-alpine-slim`, never an explicit
# `-alpine3.N-slim`: Dependabot only offers candidates whose tag suffix
# matches exactly, and nginx moves to the next Alpine minor on release, so
# a pinned Alpine minor strands this line with no update and no warning.
FROM mirror.gcr.io/library/nginx:1.31.3-alpine-slim@sha256:45b82ed5f285b90d63df07ba70430fdd8f25624b416617d9e6dc93412b2006dc AS runtime

# Patch OS packages against the current Alpine repo. The official nginx
# image is only rebuilt on an nginx release, so it can ship a stale
# libssl3/libcrypto3 for weeks after Alpine publishes the fix; pinning a
# newer nginx tag does not help because every tag lags the same way.
# Also drop the upstream default site config so our config.d/default.conf
# is the only server. Both in one RUN to satisfy hadolint DL3059.
RUN apk --no-cache upgrade \
    && rm /etc/nginx/conf.d/default.conf

COPY nginx/nginx.conf /etc/nginx/nginx.conf
COPY nginx/default.conf /etc/nginx/conf.d/default.conf
COPY nginx/security-headers.conf /etc/nginx/snippets/security-headers.conf

COPY public/index.html /usr/share/nginx/html/index.html
COPY public/app.js public/theme-init.js /usr/share/nginx/html/
COPY --from=assets /work/styles.css /usr/share/nginx/html/styles.css

# Bookmark / home-screen icons + web app manifest (Android add-to-home).
COPY public/favicon.ico public/favicon-16x16.png public/favicon-32x32.png public/apple-touch-icon.png public/icon-192.png public/icon-512.png public/site.webmanifest /usr/share/nginx/html/

COPY --chmod=0755 entrypoint.sh /usr/local/bin/entrypoint.sh

# nginx:1.29-alpine already ships an unprivileged "nginx" user (uid 101).
# Static content stays root-owned and world-readable (mode 644): the worker
# process can serve it but never modify it — defence in depth against a
# compromised worker rewriting the JS/HTML it serves.
# The only path that must be writable is /var/lib/pam-approver, where
# entrypoint.sh renders config.js (overlaid by an emptyDir under Kubernetes
# when readOnlyRootFilesystem=true). All nginx temp paths are redirected to
# /tmp in nginx.conf, so /var/cache/nginx is never written.
RUN install -d -o nginx -g nginx /var/lib/pam-approver

# Numeric UID:GID so Kubernetes `runAsNonRoot: true` can verify the image is
# non-root at admission without a redundant runAsUser in the securityContext.
USER 101:101

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD ["wget", "-q", "-T", "3", "-O", "/dev/null", "http://127.0.0.1:8080/healthz"]

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
