FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/server/package.json apps/server/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter server build && pnpm --filter server deploy --prod --legacy /out

FROM node:22-alpine
WORKDIR /app/apps/server
ENV NODE_ENV=production
COPY --from=build /out ./
EXPOSE 3000
USER node
CMD ["node", "dist/index.js"]
