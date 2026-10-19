ARG NODE_IMAGE=node:22-bookworm
FROM ${NODE_IMAGE} AS base
RUN rm -rf /app && mkdir -p /app && if command -v soffice >/dev/null 2>&1; then apt-get purge -y 'libreoffice*' && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*; fi
WORKDIR /app
COPY package*.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm install
FROM base AS api
COPY . .
RUN npm --workspace @matrix/api run db:generate && npm --workspace @matrix/api run build
CMD ["sh", "-c", "npm --workspace @matrix/api run db:migrate && node apps/api/dist/seed.js && node apps/api/dist/main.js"]
FROM base AS worker
COPY . .
RUN npm --workspace @matrix/worker run build
CMD ["npm", "--workspace", "@matrix/worker", "run", "start"]
FROM base AS web-build
COPY . .
RUN npm --workspace @matrix/web run build
FROM nginx:1.27-alpine AS web
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=web-build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
