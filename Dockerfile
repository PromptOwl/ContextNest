# Context Nest MCP server over stdio — for Glama.ai and any MCP client that
# runs servers as containers.
#
#   docker build -t contextnest-mcp .
#   docker run -i --rm contextnest-mcp                       # demo vault baked in
#   docker run -i --rm -v "$PWD:/vault" contextnest-mcp      # serve your own vault
#
# Pass --build-arg SEED_DEMO_VAULT=false for an image that only ever serves a
# mounted vault.
#
# A mounted vault is the directory that contains `.context/config.yaml`. The
# server runs as uid 1000; add `--user "$(id -u):$(id -g)"` if your vault is
# owned by a different uid.

# --- build stage ------------------------------------------------------------
# pnpm workspace repo: `npm ci` cannot resolve the `workspace:^` deps, and the
# build needs devDependencies (tsup/typescript), so no --omit=dev here.
# Version pinned to match CI (.github/workflows/ci.yml).
FROM node:20-alpine AS build
RUN npm i -g pnpm@9
WORKDIR /app

# Manifests before sources so editing a doc or a test doesn't bust the install
# layer. Every workspace package.json is needed for the lockfile to be honoured.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/engine/package.json packages/engine/
COPY packages/cli/package.json packages/cli/
COPY packages/mcp-server/package.json packages/mcp-server/
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

# Vault root for both the seed below and the server at runtime. Set explicitly
# because resolveVaultPath()'s cwd walk-up (precedence 5) would otherwise depend
# on how the client invokes the container.
ENV CONTEXTNEST_VAULT_PATH=/vault

# Note: demo vault baked into the image so the Glama inspector has documents
# to read. Seeded here rather than in the runtime stage so the CLI (and its
# deps) never ship in the final image.
ARG SEED_DEMO_VAULT=true
RUN mkdir -p /vault && \
    if [ "$SEED_DEMO_VAULT" = "true" ]; then \
      node packages/cli/dist/index.js init --name ContextNest --starter developer; \
    fi

# Prune the dev toolchain (tsup, typescript, vitest, esbuild) out of the tree
# the runtime stage copies.
RUN pnpm install --frozen-lockfile --prod

# --- runtime stage ----------------------------------------------------------
FROM node:20-alpine
WORKDIR /app

# Only the built server, the engine it imports at runtime (tsup leaves it
# external), and the pruned dependency tree — no monorepo source, no toolchain.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/engine/package.json ./packages/engine/
COPY --from=build /app/packages/engine/dist ./packages/engine/dist
COPY --from=build /app/packages/engine/node_modules ./packages/engine/node_modules
COPY --from=build /app/packages/mcp-server/package.json ./packages/mcp-server/
COPY --from=build /app/packages/mcp-server/dist ./packages/mcp-server/dist
COPY --from=build /app/packages/mcp-server/node_modules ./packages/mcp-server/node_modules

# The write tools (create/update/delete/publish_document) touch the vault, so
# don't run them as root: files created in a bind-mounted host vault would come
# back root-owned. `node` (uid 1000) ships with the base image.
COPY --from=build --chown=node:node /vault /vault
USER node

ENV CONTEXTNEST_VAULT_PATH=/vault
ENTRYPOINT ["node", "/app/packages/mcp-server/dist/index.js"]
