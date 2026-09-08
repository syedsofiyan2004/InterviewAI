# AWS Pricing Calculator MCP server, packaged for AgentCore Runtime.
#
# AgentCore Runtime differences from the Lambda sidecar:
#   - HOST must be 0.0.0.0 (not 127.0.0.1) — AgentCore reaches the container over
#     the Runtime network, not via a Lambda Web Adapter on loopback.
#   - No Lambda Web Adapter layer — the Runtime calls the HTTP server directly.
#   - ARM64 compatible (AgentCore Runtime requirement).
#   - Endpoint /mcp on port 8000, streamable HTTP MCP transport.
#
# ESTIMATES_STORE / ESTIMATES_TABLE / ESTIMATES_TTL_SECONDS are injected by CDK.
# The upstream server uses DynamoDB to keep in-flight estimate state alive across
# multiple MCP calls in one AgentCore agent iteration.

FROM public.ecr.aws/docker/library/node:20-slim

WORKDIR /var/task

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY http-server.mjs ./

# MCP_TRANSPORT=http: upstream server listens with Express over plain HTTP.
# HOST=0.0.0.0: required for AgentCore Runtime — it reaches the container via
#   the Runtime's private network, not on loopback.
# PORT=8000 / endpoint=/mcp: AgentCore MCP Runtime contract.
ENV MCP_TRANSPORT=http \
    PORT=8000 \
    HOST=0.0.0.0 \
    TRACE=on

EXPOSE 8000

CMD ["node", "http-server.mjs"]
