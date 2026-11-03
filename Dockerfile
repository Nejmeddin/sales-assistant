FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/server/package.json apps/server/
COPY apps/dashboard/package.json apps/dashboard/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build && pnpm --filter server deploy --prod --legacy /out

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app/apps/server
COPY --from=build /out ./
# The server serves the dashboard SPA from ../dashboard/dist
COPY --from=build /app/apps/dashboard/dist /app/apps/dashboard/dist
EXPOSE 3000
USER node
CMD ["node", "dist/index.js"]
