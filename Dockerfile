FROM oven/bun:1 AS build
WORKDIR /src
COPY . .
RUN bun run build

FROM oven/bun:1
WORKDIR /app
COPY --from=build /src/dist/* /app
RUN mkdir -p /app/data

ENTRYPOINT ["bun", "/app/index.js"]
