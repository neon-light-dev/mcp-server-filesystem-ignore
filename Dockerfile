FROM node:22.12-alpine AS builder

WORKDIR /app

COPY package.json /app/package.json

RUN --mount=type=cache,target=/root/.npm npm install

COPY . /app

RUN npm run build
RUN npm prune --omit=dev

FROM node:22-alpine AS release

WORKDIR /app

COPY --from=builder /app/package.json /app/package.json
COPY --from=builder /app/node_modules /app/node_modules
COPY --from=builder /app/dist /app/dist

ENV NODE_ENV=production

ENTRYPOINT ["node", "/app/dist/index.js"]
