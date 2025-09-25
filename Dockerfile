FROM oven/bun:1 AS builder

ARG DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
  python3 python3-venv python3-pip ca-certificates \
  python-is-python3

RUN rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir --break-system-packages uv

FROM builder
WORKDIR /app

COPY package.json .
COPY bun.lock .
RUN bun install

COPY . .
RUN mkdir -p /app/data
RUN mkdir -p /app/config
RUN ln -s /app/config/config.yaml /app/config.yaml

ENTRYPOINT ["bun", "/app/index.ts"]
