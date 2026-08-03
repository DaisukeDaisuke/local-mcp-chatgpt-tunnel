FROM node:24.17.0-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    OPENAI_AGENTS_DISABLE_TRACING=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl gnupg openssh-client openssl python3 python3-venv \
    && install -d -m 0755 /etc/apt/keyrings \
    && curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /etc/apt/keyrings/google-chrome.gpg \
    && echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends google-chrome-stable \
    && rm -rf /var/lib/apt/lists/*

RUN npm install --global --no-audit --no-fund chrome-devtools-mcp@1.1.1

RUN python3 -m venv /opt/ghidra-mcp-venv
COPY mcp/ghidra/requirements.txt /tmp/ghidra-requirements.txt
RUN /opt/ghidra-mcp-venv/bin/pip install --no-cache-dir -r /tmp/ghidra-requirements.txt \
    && rm /tmp/ghidra-requirements.txt

RUN groupadd --gid 10001 app \
    && useradd --uid 10001 --gid app --create-home --shell /bin/bash app \
    && install -d -o app -g app /app /workspace /runtime/dq9-test /runtime/ssh /home/app/.cache

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY --chown=app:app . /app
RUN chmod 0755 /app/scripts/entrypoint.sh /app/scripts/start-ghidra-tunnel.sh /app/scripts/new-openai-mtls-certificates.sh

USER app
ENTRYPOINT ["/app/scripts/entrypoint.sh"]
CMD ["node", "app/doctor.mjs"]
