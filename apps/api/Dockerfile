FROM node:22-alpine
WORKDIR /app
# Lockfile first for reproducible installs
COPY package.json package-lock.json ./
COPY packages ./packages
COPY apps/api ./apps/api
# Scoped to the API workspace only (skips web's react/vite tree)
RUN npm install -w talkflow-api --no-audit --no-fund
RUN npm run build -w @talkflow/llm-router && npm run build -w @talkflow/db && npm run build -w @talkflow/prompts && npm run build -w @talkflow/connectors && npm run build -w talkflow-api
ENV PORT=8787
EXPOSE 8787
CMD ["node", "apps/api/dist/local.js"]
