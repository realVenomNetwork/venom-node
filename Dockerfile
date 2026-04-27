FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY --chown=node:node . .
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "const net=require('net'); const socket=net.connect(Number(process.env.REDIS_PORT||6379), process.env.REDIS_HOST||'redis'); socket.on('connect',()=>process.exit(0)); socket.on('error',()=>process.exit(1)); setTimeout(()=>process.exit(1),4000);"

CMD ["node", "register_and_start.js"]
