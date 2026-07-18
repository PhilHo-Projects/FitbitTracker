# --- Build stage: install everything and compile Tailwind ---
FROM node:20-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# --- Runtime stage: prod deps + built artifacts only ---
FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/public ./public
COPY --from=build /app/lib ./lib
COPY --from=build /app/db ./db
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/server.js ./server.js
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD curl --fail --silent --show-error http://127.0.0.1:3000/readyz >/dev/null || exit 1
CMD ["npm", "start"]
