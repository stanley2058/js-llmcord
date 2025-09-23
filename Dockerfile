FROM oven/bun:1
WORKDIR /app

COPY package.json .
COPY bun.lock .
RUN bun install

COPY . .
RUN mkdir -p /app/data

ENTRYPOINT ["bun", "/app/index.ts"]
