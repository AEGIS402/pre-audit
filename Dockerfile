FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production \
    NODE_OPTIONS=--no-warnings=ExperimentalWarning \
    HOST=0.0.0.0 \
    PORT=13001 \
    ANALYZER_RESPONSE_CACHE_DB_PATH=/data/pre-audit/analyzer-response-cache.sqlite

COPY package.json package-lock.json ./
COPY src ./src

EXPOSE 13001

VOLUME ["/data"]

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -qO- http://127.0.0.1:${PORT}/health >/dev/null 2>&1 || exit 1

CMD ["node", "src/server.js"]
