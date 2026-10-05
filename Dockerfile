FROM mcr.microsoft.com/playwright:v1.63.0-noble
USER root
ENV DEBIAN_FRONTEND=noninteractive TZ=Asia/Shanghai DISPLAY=:99 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 TEST_BROWSER_CHANNEL=chromium \
    CONTAINER_PROFILE_PATH=/data/profile
RUN sed -i 's|http://azure.archive.ubuntu.com/ubuntu/|https://archive.ubuntu.com/ubuntu/|;s|http://security.ubuntu.com/ubuntu/|https://security.ubuntu.com/ubuntu/|' /etc/apt/sources.list.d/ubuntu.sources \
    && apt-get -o Acquire::Retries=3 update && apt-get -o Acquire::Retries=3 install -y --no-install-recommends \
    xvfb x11-utils x11vnc novnc websockify openbox fonts-noto-cjk util-linux curl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY config.example.json ./
COPY src ./src
COPY web ./web
COPY test ./test
COPY docker ./docker
RUN mkdir -p /data/profile /app/logs /app/.runtime /app/work /app/data/control \
    && chown -R pwuser:pwuser /data /app/logs /app/.runtime /app/work /app/data \
    && sed -i 's/\r$//' /app/docker/*.sh \
    && chmod +x /app/docker/*.sh
USER pwuser
EXPOSE 6080 7081
ENTRYPOINT ["/app/docker/entrypoint.sh"]
CMD ["node", "src/main.js"]
