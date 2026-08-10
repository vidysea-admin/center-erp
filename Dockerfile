# ---- build stage ----
FROM node:22-alpine AS builder
WORKDIR /app
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
RUN addgroup -S app && adduser -S app -G app
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
# uploads live on a mounted volume (see docker-compose.yml)
RUN mkdir -p /app/uploads && chown -R app:app /app
USER app
EXPOSE 3000
ENV PORT=3000 HOSTNAME=0.0.0.0
CMD ["node", "server.js"]
