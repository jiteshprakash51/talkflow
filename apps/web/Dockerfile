FROM node:22-alpine AS build
WORKDIR /app
ARG VITE_API_URL=""
ENV VITE_API_URL=$VITE_API_URL
COPY package.json package-lock.json ./
COPY apps/web ./apps/web
RUN npm install -w talkflow-web --no-audit --no-fund && npm run build -w talkflow-web
FROM nginx:alpine
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
