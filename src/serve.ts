import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Database } from "bun:sqlite";
import { openAvisosReadOnlyDb } from "./avisos/db";
import { countContracts, getMeta, openReadOnlyDb } from "./contracts/db";
import { createServer } from "./server";

const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];
export const MAX_BODY_BYTES = 64 * 1024;

export interface HttpOptions {
  avisos?: Database | Error;
  allowedOrigins?: string[];
  // Nomes pelos quais o servidor pode ser chamado, além do loopback (ex.: o domínio público atrás do proxy).
  allowedHosts?: string[];
}

// Host = nome-DNS | IPv4 | "[" IPv6 "]", com porta opcional (RFC 9110 §7.2, sem userinfo).
// Devolve o nome em minúsculas (IPv6 com parênteses retos) ou null se o valor não for uma autoridade válida.
export function parseHostHeader(value: string | null): string | null {
  if (!value) return null;
  const m = /^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(?::(\d{1,5}))?$/.exec(value);
  if (!m) return null;
  if (m[2] !== undefined && Number(m[2]) > 65535) return null;
  return m[1]!.toLowerCase();
}

const text = (body: string, status: number, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", ...headers } });

const jsonRpcError = (status: number, code: number, message: string) =>
  Response.json({ jsonrpc: "2.0", error: { code, message }, id: null }, { status });

// Lê o corpo até ao limite, sem confiar só no Content-Length. null = acima do limite.
async function readCappedBody(req: Request, maxBytes: number): Promise<string | null> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function health(db: Database): Response {
  try {
    const contracts = countContracts(db);
    const last_ingest = getMeta(db, "last_ingest");
    const ok = contracts > 0;
    return Response.json({ ok, contracts, last_ingest }, { status: ok ? 200 : 503 });
  } catch (error) {
    console.error(`health: ${error instanceof Error ? error.message : String(error)}`);
    return Response.json({ ok: false, contracts: null, last_ingest: null }, { status: 503 });
  }
}

// Modo stateless: cada pedido HTTP cria o seu servidor MCP e o seu transporte.
// Não há sessões em memória, por isso o serviço pode reiniciar ou correr em várias
// instâncias atrás de um balanceador sem perder nada. As tools são só de leitura.
export function createHttpHandler(db: Database, { allowedOrigins = [], allowedHosts = [], avisos }: HttpOptions = {}) {
  const hosts = new Set([...LOOPBACK_HOSTS, ...allowedHosts.map((h) => h.toLowerCase())]);

  return async (req: Request): Promise<Response> => {
    // Segunda camada contra DNS rebinding: depois do rebinding, o browser continua a mandar
    // o nome do atacante no Host (é um forbidden header, o JS não o muda). Compara-se só o nome, sem a porta.
    // Corre antes de qualquer parse do URL: um Host malformado leva 421 e nunca chega a new URL().
    const hostname = parseHostHeader(req.headers.get("host"));
    if (!hostname || !hosts.has(hostname)) return text("Host not allowed", 421);

    const pathname = URL.parse(req.url)?.pathname;
    if (pathname === "/health") {
      if (req.method !== "GET") return text("Method not allowed", 405, { Allow: "GET" });
      return health(db);
    }
    if (pathname !== "/mcp") return text("Not found", 404);

    // Um browser num site qualquer pode tentar falar com um servidor local (DNS rebinding).
    // Clientes MCP fora do browser não mandam Origin; os browsers mandam sempre.
    // Um Origin vazio conta como presente.
    if (req.headers.has("origin") && !allowedOrigins.includes(req.headers.get("origin")!)) {
      return text("Origin not allowed", 403);
    }

    // Sem sessões não há stream GET nem DELETE de sessão para servir.
    if (req.method !== "POST") return text("Method not allowed", 405, { Allow: "POST" });

    // O corpo é lido aqui, com limite, para recusar lotes JSON-RPC antes do transporte:
    // um lote multiplicaria o trabalho de um só pedido.
    const body = await readCappedBody(req, MAX_BODY_BYTES);
    if (body === null) return jsonRpcError(413, -32000, `Corpo acima de ${MAX_BODY_BYTES} bytes`);
    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(body);
    } catch {
      return jsonRpcError(400, -32700, "Parse error: Invalid JSON");
    }
    if (Array.isArray(parsedBody)) return jsonRpcError(400, -32600, "Invalid Request: batch requests are not supported");

    const server = createServer(db, avisos);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      maxRequestBodySize: MAX_BODY_BYTES,
    });
    await server.connect(transport);
    try {
      return await transport.handleRequest(req, { parsedBody });
    } finally {
      await server.close();
    }
  };
}

// Erros não tratados viram um 500 em texto simples: sem stack, sem página de debug.
export function serveHttp(handler: (req: Request) => Promise<Response>, { port, hostname }: { port: number; hostname: string }) {
  return Bun.serve({
    port,
    hostname,
    development: false,
    fetch: handler,
    error(error) {
      console.error(`serve: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      return text("Internal Server Error", 500);
    },
  });
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? 3000);
  const hostname = process.env.HOST ?? "127.0.0.1";
  const list = (name: string) => (process.env[name] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  let db: Database;
  try {
    db = openReadOnlyDb();
  } catch (error) {
    console.error(`joraa-mcp: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  let avisos: Database | Error;
  try {
    avisos = openAvisosReadOnlyDb();
  } catch (e) {
    avisos = e instanceof Error ? e : new Error(String(e));
    console.error(`joraa-mcp: ${avisos.message}`);
  }
  const handler = createHttpHandler(db, {
    avisos,
    allowedOrigins: list("JORAA_MCP_ALLOWED_ORIGINS"),
    allowedHosts: list("JORAA_MCP_ALLOWED_HOSTS"),
  });
  const srv = serveHttp(handler, { port, hostname });
  console.error(`joraa-mcp a servir MCP em http://${srv.hostname}:${srv.port}/mcp`);
}
