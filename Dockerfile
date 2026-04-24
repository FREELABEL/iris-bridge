FROM node:20-slim

# CLI tools the agent can use (not our core — agent installs more as needed)
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl git wget vim nano openssh-client openssl \
    build-essential python3 python3-pip \
    php-cli php-mbstring php-xml php-curl php-zip php-sqlite3 php-mysql unzip \
    && rm -rf /var/lib/apt/lists/* \
    && curl -sS https://getcomposer.org/installer | php -- --install-dir=/usr/local/bin --filename=composer

# PM2 — persistent process manager for long-running bots/services
RUN npm install -g pm2

# IRIS Code (OpenCode fork)
RUN curl -fsSL https://raw.githubusercontent.com/FREELABEL/iris-opencode/main/install | bash \
    && mv /root/.iris/bin/iris /usr/local/bin/iris || true

# Bridge code
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --production
COPY index.js daemon.js .bridge-config.json entrypoint.sh ./
COPY daemon/ ./daemon/
COPY channels/ ./channels/
COPY drivers/ ./drivers/
COPY lib/ ./lib/
RUN chmod +x entrypoint.sh

# Persistent data volume
RUN mkdir -p /data/workspace /data/memory /data/skills /data/pm2
VOLUME /data

# Environment defaults (overridable at runtime)
ENV IRIS_API_URL=https://web.heyiris.io
ENV PM2_HOME=/data/pm2
ENV BRIDGE_PORT=3200
ENV OLLAMA_HOST=http://host.docker.internal:11434

EXPOSE 3200

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3200/health || exit 1

ENTRYPOINT ["./entrypoint.sh"]
