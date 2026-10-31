FROM node:22-slim

# yt-dlp handles YouTube / TikTok / Instagram / X style links.
# ffmpeg ships as a static binary via npm, so it is not installed here.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip ca-certificates \
 && pip3 install --no-cache-dir --break-system-packages -U yt-dlp \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data \
    MAX_UPLOAD_MB=6144 \
    MAX_CONCURRENT=1

# Platforms such as Hugging Face Spaces run containers as an unprivileged user
# (uid 1000, which is the image's `node` user). The data directory has to belong
# to that user or the app cannot write its working files.
RUN mkdir -p /data && chown -R node:node /data /app

USER node
WORKDIR /app

EXPOSE 3000
CMD ["node", "server/server.js"]
