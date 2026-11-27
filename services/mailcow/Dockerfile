FROM node:22.22.0-alpine
WORKDIR /app
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY --chown=node:node src/ ./src/
USER node
CMD ["node", "src/index.mjs"]
