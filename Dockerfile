# ---- 阶段1：构建前端 ----
FROM node:22-alpine AS build
WORKDIR /app
COPY app/package*.json ./
RUN npm ci
COPY app ./
RUN npm run build

# ---- 阶段2：运行同步服务（同时托管前端）----
FROM node:22-alpine
WORKDIR /srv
COPY server/package*.json ./
RUN npm ci --omit=dev
COPY server ./
COPY --from=build /app/dist ./public-dist
ENV STATIC_DIR=/srv/public-dist
ENV DATA_DIR=/data
ENV PORT=8080
EXPOSE 8080
VOLUME ["/data"]
CMD ["node", "index.js"]
