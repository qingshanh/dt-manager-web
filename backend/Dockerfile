ARG NODE_IMAGE=docker.hanxi.cc/library/node:22-alpine

FROM ${NODE_IMAGE} AS build

WORKDIR /app

COPY package.json package-lock.json ./
ARG NPM_REGISTRY=https://registry.npmmirror.com
RUN npm config set registry ${NPM_REGISTRY} && npm ci

COPY prisma ./prisma
COPY src ./src
COPY tsconfig.json ./

RUN npx prisma generate && npm run build
RUN npm prune --omit=dev

FROM ${NODE_IMAGE} AS runtime

WORKDIR /app
ENV NODE_ENV=production
ARG APP_COMMIT_SHA=""
ENV APP_COMMIT_SHA=${APP_COMMIT_SHA}

COPY package.json package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY docker-entrypoint.sh /usr/local/bin/dt-manager-entrypoint

RUN mkdir -p /app/data && chmod 755 /usr/local/bin/dt-manager-entrypoint

EXPOSE 5174

STOPSIGNAL SIGTERM
ENTRYPOINT ["dt-manager-entrypoint"]
CMD ["node", "dist/index.js"]
