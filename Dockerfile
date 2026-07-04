# Always-on Discord triage bot. Runs the TypeScript source directly via tsx —
# no build step, matching how `npm run bot` works locally.
FROM node:20-slim

WORKDIR /app

# Install deps from the lockfile first so this layer caches across source edits.
COPY package.json package-lock.json ./
RUN npm ci

# Application source. context/CONTEXT.md is gitignored and supplied at runtime by
# a volume (see docker-compose.yml), so it is not copied here.
COPY tsconfig.json ./
COPY src ./src

CMD ["npm", "run", "bot"]
