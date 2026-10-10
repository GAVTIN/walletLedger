FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY migrations ./migrations
COPY src ./src
COPY scripts ./scripts
# Run TypeScript directly with tsx (simple for a learning project; a production image would compile first).
CMD ["npx", "tsx", "src/server.ts"]
