FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY --chown=node:node register_and_start.js ./
COPY --chown=node:node aggregator/ ./aggregator/
COPY --chown=node:node rpc/ ./rpc/
COPY --chown=node:node src/ ./src/
COPY --chown=node:node data/ ./data/
COPY --chown=node:node dashboard/ ./dashboard/
COPY --chown=node:node cli/ ./cli/
COPY --chown=node:node vocabulary/ ./vocabulary/
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health || node -e "const net=require('net'); const socket=net.connect(Number(process.env.REDIS_PORT||6379), process.env.REDIS_HOST||'redis'); socket.on('connect',()=>process.exit(0)); socket.on('error',()=>process.exit(1)); setTimeout(()=>process.exit(1),4000);"

CMD ["node", "register_and_start.js"]
