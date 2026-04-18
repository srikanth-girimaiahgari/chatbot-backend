# syntax=docker/dockerfile:1

FROM node:20-alpine

WORKDIR /app

# Railway (and most platforms) set PORT; default matches local dev.
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 3000

# Drop privileges for runtime.
USER node

CMD ["node", "index.js"]
