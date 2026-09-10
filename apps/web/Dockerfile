FROM node:22-alpine AS build
WORKDIR /app
COPY package.json ./
COPY apps/web ./apps/web
RUN npm install -w apps/web 2>&1 | tail -5; npm run build -w talkflow-web || npx -w apps/web tsc -p apps/web/tsconfig.json
FROM nginx:alpine
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
