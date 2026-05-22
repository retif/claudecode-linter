# syntax=docker/dockerfile:1

# ---- Build stage ----
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- Runtime stage ----
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

# Production-only dependencies.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Application artifacts.
COPY --from=build /app/dist ./dist
COPY contracts ./contracts
COPY .claudecode-lint.defaults.yaml ./.claudecode-lint.defaults.yaml

# Run as an unprivileged user. node:bookworm-slim ships a "node" UID 1000.
USER node

WORKDIR /work
ENTRYPOINT ["node", "/app/dist/index.js"]
CMD ["/work"]
