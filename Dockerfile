# ---- build stage ----
FROM node:22-alpine AS builder
WORKDIR /app
# -249 (QA-1202): declared here too so `--build-arg GIT_COMMIT=...` is accepted without a warning
# even though only the runtime stage needs the value.
ARG GIT_COMMIT=""
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Dummy env so `next build` can evaluate config; real values come at runtime
ENV MONGODB_URL=mongodb://build-placeholder:27017 \
    AUTH_SECRET=build-placeholder
RUN npm run build

# ---- runtime stage ----
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
# -249 (QA-1202): the commit this image was built from, surfaced by /api/public/version.
# .dockerignore excludes .git, so the image CANNOT work this out for itself - it has to be handed in.
# ARG does not cross stages, hence the re-declaration here rather than only in the builder.
# Nothing breaks when it is absent: the endpoint reports commit:null and falls back to build_id,
# which is derived from .next/BUILD_ID and is always present.
# To wire it, CodeBuild needs ONE line in its buildspec:
#     docker build --build-arg GIT_COMMIT=$CODEBUILD_RESOLVED_SOURCE_VERSION ...
# That buildspec lives in AWS, not in this repo, so it is a devops action and not a code change.
ARG GIT_COMMIT=""
ENV GIT_COMMIT=$GIT_COMMIT
RUN addgroup -S app && adduser -S app -G app
# -87 (QA-157): Ghostscript compresses scanned PDFs (certificates, documents) at the storage
# door; sharp (npm) does images. Both are optional at runtime — the app records "none:gs
# unavailable" instead of failing — but production should have them.
RUN apk add --no-cache ghostscript
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
# -93: Workload Identity Federation config (NO private key — the container proves itself with its
# AWS task role; Google returns a token for the impersonated service account). Non-secret, baked in.
COPY --from=builder /app/config ./config
# uploads live on a mounted volume (see docker-compose.yml)
RUN mkdir -p /app/uploads && chown -R app:app /app
USER app
EXPOSE 3000
ENV PORT=3000 HOSTNAME=0.0.0.0
CMD ["node", "server.js"]
