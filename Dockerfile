# --- Build stage: install everything and compile Tailwind ---
FROM node:20-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

# --- Runtime stage: prod deps + built artifacts only ---
FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY --from=build /app/public ./public
COPY --from=build /app/lib ./lib
COPY --from=build /app/server.js ./server.js
EXPOSE 3000
CMD ["node", "server.js"]
