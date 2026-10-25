# W06 staging image (web, worker, migrate, deploy-sandbox and fake-github all run from this one image).
# NOT a production image: it contains the simulated GitHub and the sandbox deployer, and it is only ever
# started by docker-compose.staging.yml on an internal network with no route to the Internet.
#
# Build context = repository root:  docker build -f ops/staging/Dockerfile -t forge-staging:local .

# ── 1. contracts: the same pinned Foundry the CI uses ────────────────────────────────────────────────
FROM ghcr.io/foundry-rs/foundry:v1.8.5 AS contracts
WORKDIR /repo
COPY foundry.toml foundry.lock ./
COPY contractsV1 contractsV1
COPY contractsV2 contractsV2
COPY contractsV2-deployed contractsV2-deployed
COPY contractsV2-forge contractsV2-forge
COPY pons-beta pons-beta
COPY script script
COPY test test
COPY test-forge test-forge
RUN forge build --profile forge

# ── 2. app build (production Next.js build) ──────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /repo/apps/forge-web
COPY apps/forge-web/package.json apps/forge-web/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY apps/forge-web ./
COPY release /repo/release
COPY security /repo/security
RUN pnpm build

# ── 3. runtime ───────────────────────────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate \
 && apt-get update && apt-get install -y --no-install-recommends postgresql-client tini && rm -rf /var/lib/apt/lists/*
WORKDIR /repo
COPY --from=build /repo /repo
COPY --from=build /root/.cache/node/corepack /corepack-cache
COPY --from=contracts /repo/out /repo/out
COPY ops/staging/entrypoint.sh /usr/local/bin/forge-entrypoint
RUN chmod +x /usr/local/bin/forge-entrypoint && useradd --system --uid 10001 --create-home --home-dir /home/forge forge \
 && mkdir -p /sandbox && chown -R forge /sandbox /home/forge /corepack-cache /repo/apps/forge-web/.next
# The runtime user needs a writable HOME: corepack writes its cache under $HOME/.cache at
# `pnpm exec` time, and without it every role crashed with EACCES (W07 compose smoke finding).
ENV HOME=/home/forge COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# Ship the build stage's corepack store: the backend network is internal (no
# registry route), so the runtime user's first `pnpm exec` must resolve pnpm
# 10.28.0 (the packageManager pin) from a local cache, never the network.
ENV COREPACK_HOME=/corepack-cache
USER forge
WORKDIR /repo/apps/forge-web
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/forge-entrypoint"]
CMD ["web"]
