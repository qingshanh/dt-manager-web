ARG NODE_IMAGE=docker.hanxi.cc/library/node:22-alpine
ARG NGINX_IMAGE=docker.hanxi.cc/library/nginx:1.27-alpine

FROM ${NODE_IMAGE} AS build

WORKDIR /app

COPY package.json package-lock.json ./
ARG NPM_REGISTRY=https://registry.npmmirror.com
RUN npm config set registry ${NPM_REGISTRY} && npm ci

COPY . .
ARG APP_VERSION=0.2.5
ARG VITE_APP_VERSION=
ENV APP_VERSION=$APP_VERSION
ENV VITE_APP_VERSION=$VITE_APP_VERSION
RUN npm run build

FROM ${NGINX_IMAGE}

COPY nginx.conf /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
