FROM node:22.22.0-alpine
WORKDIR /app
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY --chown=node:node src/ ./src/
COPY suite/src/ ./suite/src/
RUN npm run build:suite && npm prune --omit=dev --ignore-scripts
USER node
CMD ["node", "src/index.mjs"]
