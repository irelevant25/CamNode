# ---------------------------------------------------------------- build deps
FROM node:22-bookworm-slim AS deps
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json* ./
# better-sqlite3 ships prebuilt binaries for common platforms and falls back to
# compiling here when there is none for this architecture.
RUN npm install --omit=dev --no-audit --no-fund

# ------------------------------------------------------------------- runtime
FROM node:22-bookworm-slim AS runtime
# Debian's ffmpeg package ships ffmpeg, ffprobe and ffplay together; the app
# uses the first two. Verifying here fails the build loudly rather than
# producing an image that only breaks when the first recording starts.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg tini ca-certificates tzdata \
 && rm -rf /var/lib/apt/lists/* \
 && ffmpeg -version > /dev/null \
 && ffprobe -version > /dev/null

ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8080

# Stamped by the publish workflow so the running app can report which build it is.
ARG APP_VERSION=
ARG APP_COMMIT=
ARG APP_BUILT_AT=
ARG APP_REPO_URL=
ENV APP_VERSION=${APP_VERSION}
ENV APP_COMMIT=${APP_COMMIT}
ENV APP_BUILT_AT=${APP_BUILT_AT}
ENV APP_REPO_URL=${APP_REPO_URL}

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public

RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/index.js"]
