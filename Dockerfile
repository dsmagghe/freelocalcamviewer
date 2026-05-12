FROM node:22-alpine

RUN apk add --no-cache python3 make g++ \
 && ln -sf python3 /usr/bin/python

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --build-from-source=better-sqlite3 \
 && apk del python3 make g++ || true

COPY . .

ENV PORT=8088 \
    HOST=0.0.0.0 \
    DB_PATH=/data/cameras.db

EXPOSE 8088
VOLUME ["/data"]

# ONVIF WS-Discovery is multicast — run the container with --network host
# (or pass the multicast address explicitly) for auto-detection to work.
CMD ["node", "server.js"]
