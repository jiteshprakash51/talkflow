FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY packages ./packages
COPY apps/api ./apps/api
RUN npm install --workspaces --include-workspace-root=false || npm install -w apps/api || true
RUN npm run build -w @talkflow/llm-router; npm run build -w @talkflow/db; npm run build -w @talkflow/prompts; npm run build -w @talkflow/connectors; npm run build -w talkflow-api
ENV PORT=8787
EXPOSE 8787
CMD ["node", "apps/api/dist/local.js"]
