FROM node:22-bookworm-slim
ENV NODE_ENV=production PUPPETEER_SKIP_DOWNLOAD=true PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    SESSION_DATA_PATH=/state/whatsapp SPLITMATE_DATA_DIR=/state/data TZ=Australia/Sydney
RUN apt-get update && apt-get install -y --no-install-recommends chromium ca-certificates fonts-liberation tini \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --chown=node:node server ./server
COPY --chown=node:node scripts/worker-health.cjs ./scripts/worker-health.cjs
COPY --chown=node:node scripts/worker-pair.cjs ./scripts/worker-pair.cjs
RUN mkdir -p /state/whatsapp /state/data /state/run && chown -R node:node /state
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 CMD ["node", "scripts/worker-health.cjs"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server/worker-sync.cjs"]
