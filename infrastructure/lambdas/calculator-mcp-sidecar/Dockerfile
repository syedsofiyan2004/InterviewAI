# AWS Pricing Calculator MCP server, packaged for Lambda.
#
# Why a container image and not a NodejsFunction (the pattern used everywhere else
# in this stack): the upstream package publishes a *running Express server*, not a
# library — package.json has `main: mcp-server.js`, no `exports`, and `files` ships
# only `dist/mcp-server.js`. There is nothing to import and bundle, so we run it as
# a server and put AWS Lambda Web Adapter (LWA) in front to translate Lambda
# invokes into local HTTP requests.
#
# Upstream is pinned exactly (not ^) on purpose: it talks to undocumented
# calculator.aws CloudFront endpoints, so reproducible builds matter more than
# picking up patches automatically.

FROM public.ecr.aws/awsguru/aws-lambda-adapter:0.9.1 AS lwa

FROM public.ecr.aws/docker/library/node:20-slim

# LWA runs as a Lambda external extension: it boots first, waits for the app to
# answer on AWS_LWA_PORT, then proxies each invoke to it over plain HTTP.
COPY --from=lwa /lambda-adapter /opt/extensions/lambda-adapter

WORKDIR /var/task

# Install deps first so the layer caches independently of any later file changes.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

# The MCP server's own HTTP listener. HOST stays on loopback because the only
# thing that may reach it is LWA inside this same execution environment.
ENV MCP_TRANSPORT=http \
    PORT=8000 \
    HOST=127.0.0.1 \
    AWS_LWA_PORT=8000 \
    AWS_LWA_READINESS_CHECK_PATH=/mcp \
    AWS_LWA_READINESS_CHECK_PROTOCOL=tcp \
    TRACE=on

# ESTIMATES_STORE / ESTIMATES_TABLE / ESTIMATES_TTL_SECONDS are injected by CDK.
# They must be set for anything multi-request: the in-flight estimate created by
# create_estimate has to still exist when a later invoke calls export_estimate,
# and Lambda gives no sticky routing between the two.

CMD ["node", "node_modules/sample-aws-pricing-calculator-mcp/dist/mcp-server.js"]
