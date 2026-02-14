FROM node:22-alpine
WORKDIR /app
COPY services/transcript-room/package.json services/transcript-room/package-lock.json* ./
RUN npm ci --omit=dev
COPY services/transcript-room/server.js services/transcript-room/viewer.html ./
EXPOSE 8790
CMD ["node", "server.js"]
