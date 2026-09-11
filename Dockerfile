# Build stage
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# Runtime stage
FROM node:22-slim
COPY --from=litestream/litestream:0.3 /usr/local/bin/litestream /usr/local/bin/litestream
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY litestream.yml /etc/litestream.yml
COPY run.sh ./run.sh
RUN chmod +x run.sh
EXPOSE 8080
CMD ["./run.sh"]
