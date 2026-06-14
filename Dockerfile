# Public Pearlscriptions indexer — read-only API / sync worker.
# Used by the optional "app" compose profile to run the v1.2.1 API/worker split.
FROM node:20-alpine

WORKDIR /app

# Install dependencies first for better layer caching. The project is
# dependency-light (Node's built-in test runner), so this stays small.
COPY package.json package-lock.json ./
COPY apps/indexer-api/package.json apps/indexer-api/package.json
COPY packages/prl20-core/package.json packages/prl20-core/package.json
RUN npm ci --omit=dev || npm install --omit=dev

COPY . .

# Default to the read-only API role. The worker service overrides the command.
ENV PRL20_INDEXER_ROLE=api
EXPOSE 3000
CMD ["npm", "run", "indexer:api"]
