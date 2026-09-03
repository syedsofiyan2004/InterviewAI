/**
 * Minimal MCP client for the AWS Pricing Calculator sidecar.
 *
 * The sidecar is a container-image Lambda running the upstream server with
 * MCP_TRANSPORT=http behind Lambda Web Adapter. We reach it by *invoking the
 * function directly* with a Function-URL-shaped event, which LWA translates into
 * the HTTP request its Express app expects. There is no Function URL and no
 * public endpoint.
 *
 * Why invoke rather than sign an HTTPS Function URL request:
 *  - SigV4 signing needed four packages (@smithy/signature-v4,
 *    @smithy/protocol-http, @aws-crypto/sha256-js,
 *    @aws-sdk/credential-provider-node) that were never declared in
 *    package.json. They only resolved because the AWS SDK hoists them as
 *    transitive deps — a phantom dependency that compiles today and breaks on any
 *    dependency-tree change. @aws-sdk/client-lambda is already a declared dep.
 *  - It removes a public internet endpoint from the design entirely.
 *  - A Lambda invoke returns one complete payload, so there is no response body
 *    left streaming after the headers arrive. The signed-HTTPS version cleared its
 *    abort timer as soon as fetch resolved (on headers), leaving the SSE body read
 *    unguarded — an open risk on this design, since it is unverified whether LWA
 *    closes an SSE response cleanly. Structurally impossible here.
 *
 * Four non-obvious things about the sidecar itself, all verified by reading the
 * upstream entry point and the MCP SDK it pins (@modelcontextprotocol/sdk 1.30):
 *
 *  1. It is *stateless*. The server constructs the transport with
 *     `sessionIdGenerator: undefined`, and the SDK documents that mode as
 *     "no session validation is performed" — so there is no session to
 *     establish and no `Mcp-Session-Id` to echo back. The upstream server reads
 *     that header only to tag its trace logs.
 *
 *  2. No `initialize` handshake is required. The SDK's Server never gates
 *     request dispatch on initialization (there is no "not initialized" path in
 *     server/index.js), so a cold container answers `tools/list` on the first
 *     request.
 *
 *  3. Responses are Server-Sent Events, not plain JSON. The upstream server does
 *     not pass `enableJsonResponse`, so the SDK replies `text/event-stream` and
 *     frames the JSON-RPC response inside `data:` lines. Hence parseSseJsonRpc below.
 *
 *  4. The `Accept` header must offer *both* `application/json` and
 *     `text/event-stream`; the streamable-HTTP transport rejects anything else
 *     with 406 before the request ever reaches a tool.
 */

import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: number | string;
  result?: any;
  error?: { code: number; message: string; data?: unknown };
}

/** Text payload of a tools/call result, plus whether the tool flagged an error. */
export interface McpToolResult {
  text: string;
  isError: boolean;
}

export interface CalculatorGateway {
  /** The tool surface the installed MCP exposes; the executor discovers roles from it. */
  listTools(): Promise<Array<{ name: string }>>;
  /** One tool call. Tool-level refusals come back as `isError`, never thrown. */
  callTool(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<McpToolResult>;
  getServiceCatalog(serviceCode: string): Promise<McpToolResult>;
  saveEstimate(name: string, services: Array<{ service: string; group: string; config: Record<string, unknown> }>): Promise<McpToolResult>;
  readEstimate(savedKeyOrUrl: string): Promise<McpToolResult>;
  deleteEstimate?(savedKeyOrUrl: string): Promise<{ supported: boolean; deleted: boolean; message?: string }>;
  validateLink(url: string): Promise<{
    validUrl: boolean;
    reason?: string;
    title?: string;
    monthly?: number;
    upfront?: number;
    total12Months?: number;
    services?: Array<{ service: string; monthly: number | null; upfront: number | null; configSummary?: string }>;
  }>;
}

const REGION = process.env.AWS_REGION || 'ap-south-1';

/**
 * Pulls the JSON-RPC payload out of an SSE body.
 *
 * A streamable-HTTP response for a single request looks like:
 *   event: message\n
 *   data: {"jsonrpc":"2.0","id":1,...}\n
 *   \n
 * Multi-line `data:` is legal per the SSE spec (concatenate with newlines), and
 * the stream may carry comment/heartbeat lines beginning with ':' which we skip.
 * We take the last complete JSON object, which is the response to our request.
 */
function parseSseJsonRpc(body: string): JsonRpcResponse {
  const trimmed = body.trimStart();

  // Defensive: if a future upstream version flips on enableJsonResponse, the body
  // is already plain JSON and there is nothing to unframe.
  if (trimmed.startsWith('{')) return JSON.parse(trimmed);

  const payloads: string[] = [];
  let current: string[] = [];

  for (const rawLine of body.split(/\r?\n/)) {
    if (rawLine === '') {
      // Blank line terminates an SSE event.
      if (current.length) payloads.push(current.join('\n'));
      current = [];
      continue;
    }
    if (rawLine.startsWith(':')) continue; // comment / heartbeat
    if (rawLine.startsWith('data:')) {
      current.push(rawLine.slice(5).replace(/^ /, ''));
    }
    // `event:` / `id:` / `retry:` fields carry no payload we need.
  }
  if (current.length) payloads.push(current.join('\n'));

  for (let i = payloads.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(payloads[i]);
    } catch {
      // Partial or non-JSON frame — keep looking backwards.
    }
  }
  throw new Error(`MCP sidecar returned no parsable JSON-RPC frame. Body: ${body.slice(0, 400)}`);
}

export class McpSidecarClient implements CalculatorGateway {
  private readonly lambda: LambdaClient;
  private readonly functionName: string;
  private readonly browserValidatorFunctionName?: string;
  private nextId = 1;

  constructor(functionName: string, browserValidatorFunctionName?: string) {
    if (!functionName) throw new Error('CALCULATOR_SIDECAR_FUNCTION_NAME is not set');
    this.functionName = functionName;
    this.browserValidatorFunctionName = browserValidatorFunctionName;
    this.lambda = new LambdaClient({ region: REGION });
  }

  /**
   * The event shape Lambda Web Adapter translates into an HTTP request.
   *
   * LWA reads the Function URL / HTTP API payload format 2.0, so the fields it
   * needs are `requestContext.http` (method + path), `headers`, and `body`. The
   * MCP server mounts its route at /mcp.
   */
  private event(payload: string): Record<string, unknown> {
    return {
      version: '2.0',
      routeKey: '$default',
      rawPath: '/mcp',
      rawQueryString: '',
      headers: {
        'content-type': 'application/json',
        // See note 4 above — both media types are mandatory or the transport 406s.
        accept: 'application/json, text/event-stream',
      },
      requestContext: {
        http: { method: 'POST', path: '/mcp', protocol: 'HTTP/1.1', sourceIp: '127.0.0.1' },
      },
      body: payload,
      isBase64Encoded: false,
    };
  }

  private async rpc(method: string, params?: Record<string, unknown>, timeoutMs = 30_000): Promise<any> {
    const payload = JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method, params });

    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    let raw: string;
    try {
      const response = await this.lambda.send(
        new InvokeCommand({
          FunctionName: this.functionName,
          InvocationType: 'RequestResponse',
          Payload: new TextEncoder().encode(JSON.stringify(this.event(payload))),
        }),
        { abortSignal: abort.signal },
      );

      // A container fault (unhandled exception, OOM, timeout) arrives as a 200
      // invoke carrying FunctionError — it is not an SDK error, so it has to be
      // checked explicitly or it would be parsed as if it were a response.
      const decoded = response.Payload ? new TextDecoder().decode(response.Payload) : '';
      if (response.FunctionError) {
        throw new Error(`MCP sidecar failed (${response.FunctionError}): ${decoded.slice(0, 400)}`);
      }
      raw = decoded;
    } finally {
      // Safe to clear here: unlike an HTTP response, the invoke resolves with the
      // complete payload already in hand — there is no body still arriving.
      clearTimeout(timer);
    }

    let envelope: { statusCode?: number; body?: string; isBase64Encoded?: boolean };
    try {
      envelope = JSON.parse(raw);
    } catch {
      throw new Error(`MCP sidecar returned a non-JSON invoke payload: ${raw.slice(0, 400)}`);
    }

    const body = envelope.isBase64Encoded && envelope.body
      ? Buffer.from(envelope.body, 'base64').toString('utf8')
      : envelope.body || '';

    const status = envelope.statusCode ?? 0;
    if (status < 200 || status >= 300) {
      throw new Error(`MCP sidecar HTTP ${status}: ${body.slice(0, 400)}`);
    }

    const rpcResponse = parseSseJsonRpc(body);
    if (rpcResponse.error) {
      throw new Error(`MCP error ${rpcResponse.error.code}: ${rpcResponse.error.message}`);
    }
    return rpcResponse.result;
  }

  /**
   * Optional warmup. Dispatch does not depend on it (note 2), and the caller must
   * treat a failure here as non-fatal — `listTools()` is the real readiness check
   * and it is mandatory anyway, so failing the whole estimate on an unnecessary
   * handshake would be self-inflicted.
   */
  async initialize(): Promise<void> {
    await this.rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'minfy-mimo-cost-calculator', version: '1.0.0' },
    });
  }

  /** The sidecar's tool catalogue, shaped for Anthropic's `tools` parameter. */
  async listTools(): Promise<McpTool[]> {
    const result = await this.rpc('tools/list');
    return (result?.tools ?? []) as McpTool[];
  }

  /**
   * Invokes one tool. A tool that fails is *not* thrown: MCP reports tool-level
   * failures as `isError` with explanatory text, and that text is exactly what
   * the model needs to correct itself on the next turn (upstream writes
   * actionable `next_step` hints into it). Only transport/protocol faults throw.
   */
  async callTool(name: string, args: Record<string, unknown>, timeoutMs = 60_000): Promise<McpToolResult> {
    const result = await this.rpc('tools/call', { name, arguments: args }, timeoutMs);
    const text = (result?.content ?? [])
      .filter((block: any) => block?.type === 'text')
      .map((block: any) => block.text)
      .join('\n');
    return { text: text || '(tool returned no text)', isError: Boolean(result?.isError) };
  }

  async getServiceCatalog(serviceCode: string): Promise<McpToolResult> {
    return this.callTool('get_service_fields', { service: serviceCode });
  }

  private parseEstimateId(result: McpToolResult): string | undefined {
    try {
      const parsed = JSON.parse(result.text);
      return String(parsed?.estimate_id || parsed?.aws_estimate_id || '').trim() || undefined;
    } catch {
      return /"estimate_id"\s*:\s*"([^"]+)"/.exec(result.text)?.[1]
        || /"aws_estimate_id"\s*:\s*"([^"]+)"/.exec(result.text)?.[1];
    }
  }

  private parseEstimateUrl(result: McpToolResult): string | undefined {
    try {
      const parsed = JSON.parse(result.text);
      return String(parsed?.sharable_url || parsed?.shareable_url || parsed?.url || '').trim() || undefined;
    } catch {
      return /https:\/\/[^\s"'\\]*calculator\.aws[^\s"'\\]*/.exec(result.text)?.[0];
    }
  }

  async saveEstimate(
    name: string,
    services: Array<{ service: string; group: string; config: Record<string, unknown> }>,
  ): Promise<McpToolResult> {
    const create = await this.callTool('create_estimate', { name, partition: 'aws' }, 60_000);
    if (create.isError) return create;
    const estimateId = this.parseEstimateId(create);
    if (!estimateId) return {
      text: `create_estimate returned no estimate_id: ${create.text.slice(0, 500)}`,
      isError: true,
    };

    const add = await this.callTool('add_service', { estimate_id: estimateId, services: JSON.stringify(services) }, 180_000);
    if (add.isError || /"error"\s*:/.test(add.text)) return {
      text: `add_service failed for ${estimateId}: ${add.text.slice(0, 2000)}`,
      isError: true,
    };

    const validate = await this.callTool('validate_estimate', { estimate_id: estimateId }, 120_000);
    if (validate.isError) return validate;
    try {
      const parsed = JSON.parse(validate.text);
      if (parsed?.lint_verdict && parsed.lint_verdict !== 'editable') return {
        text: `validate_estimate refused ${estimateId}: ${validate.text.slice(0, 2000)}`,
        isError: true,
      };
    } catch {
      return { text: `validate_estimate returned invalid JSON: ${validate.text.slice(0, 500)}`, isError: true };
    }

    const exported = await this.callTool('export_estimate', { estimate_id: estimateId }, 180_000);
    if (exported.isError) return exported;
    const url = this.parseEstimateUrl(exported);
    if (!url) return {
      text: `export_estimate returned no calculator.aws URL: ${exported.text.slice(0, 500)}`,
      isError: true,
    };
    return {
      text: JSON.stringify({
        sharable_url: url,
        aws_estimate_id: this.parseEstimateId(exported) || estimateId,
        mcp_workflow: ['create_estimate', 'add_service', 'validate_estimate', 'export_estimate'],
        services,
      }),
      isError: false,
    };
  }

  async readEstimate(savedKeyOrUrl: string): Promise<McpToolResult> {
    return this.callTool('import_estimate', { estimate_id: savedKeyOrUrl, format: 'json' }, 180_000);
  }

  async deleteEstimate(savedKeyOrUrl: string): Promise<{ supported: boolean; deleted: boolean; message?: string }> {
    const tools = await this.listTools();
    const tool = tools.find((entry) => [
      'delete_estimate',
      'deleteEstimate',
      'remove_estimate',
      'removeEstimate',
    ].includes(entry.name));
    if (!tool) {
      return {
        supported: false,
        deleted: false,
        message: 'The installed AWS Pricing Calculator MCP does not expose a remote estimate deletion tool.',
      };
    }
    const result = await this.callTool(tool.name, { estimate_id: savedKeyOrUrl, url: savedKeyOrUrl }, 60_000);
    return {
      supported: true,
      deleted: !result.isError,
      ...(result.text ? { message: result.text.slice(0, 500) } : {}),
    };
  }

  async validateLink(url: string): Promise<{
    validUrl: boolean;
    reason?: string;
    title?: string;
    monthly?: number;
    upfront?: number;
    total12Months?: number;
    services?: Array<{ service: string; monthly: number | null; upfront: number | null; configSummary?: string }>;
  }> {
    try {
      const parsed = new URL(url);
      const validUrl = parsed.protocol === 'https:' && parsed.hostname.endsWith('calculator.aws');
      if (!validUrl) return { validUrl: false, reason: 'The URL is not an HTTPS calculator.aws link.' };
    } catch {
      return { validUrl: false, reason: 'The returned shareable link is not a valid URL.' };
    }
    if (!this.browserValidatorFunctionName) {
      return { validUrl: false, reason: 'The isolated Calculator browser validator is not configured.' };
    }
    const response = await this.lambda.send(new InvokeCommand({
      FunctionName: this.browserValidatorFunctionName,
      InvocationType: 'RequestResponse',
      Payload: new TextEncoder().encode(JSON.stringify({ url })),
    }));
    const decoded = response.Payload ? new TextDecoder().decode(response.Payload) : '';
    if (response.FunctionError) {
      return { validUrl: false, reason: `Calculator browser validator failed (${response.FunctionError}): ${decoded.slice(0, 300)}` };
    }
    try {
      return JSON.parse(decoded);
    } catch {
      return { validUrl: false, reason: `Calculator browser validator returned invalid JSON: ${decoded.slice(0, 300)}` };
    }
  }
}
