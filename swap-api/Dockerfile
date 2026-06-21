FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY tsconfig.json ./
COPY src/ src/
COPY public/ public/
COPY assets/ assets/

RUN npx tsc

ENV PORT=3000
ENV DB_PATH=/app/data/orderbook.sqlite
ENV NETWORK=testnet

EXPOSE 3000

CMD ["node", "--experimental-sqlite", "dist/server.js"]
