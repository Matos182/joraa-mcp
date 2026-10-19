import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Database } from "bun:sqlite";
import { openDb } from "./contracts/db";
import { createServer } from "./server";

const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

export interface HttpOptions {
  allowedOrigins?: string[];
  // Nomes pelos quais o servidor pode ser chamado, além do loopback (ex.: o domínio público atrás do proxy).
  allowedHosts?: string[];
}

// Modo stateless: cada pedido HTTP cria o seu servidor MCP e o seu transporte.
// Não há sessões em memória, por isso o serviço pode reiniciar ou correr em várias
// instâncias atrás de um balanceador sem perder nada. As tools são só de leitura.
export function createHttpHandler(db: Database, { allowedOrigins = [], allowedHosts = [] }: HttpOptions = {}) {
  const hosts = new Set([...LOOPBACK_HOSTS, ...allowedHosts.map((h) => h.toLowerCase())]);

  return async (req: Request): Promise<Response> => {
    const { pathname } = new URL(req.url);

    // Segunda camada contra DNS rebinding: depois do rebinding, o browser continua a mandar
    // o nome do atacante no Host (é um forbidden header, o JS não o muda). Compara-se só o nome, sem a porta.
    const host = req.headers.get("host");
    const hostname = host ? URL.parse(`http://${host}`)?.hostname : undefined;
    if (!hostname || !hosts.has(hostname)) {
      return new Response("Host not allowed", { status: 421 });
    }

    if (pathname === "/health") return Response.json({ ok: true });
    if (pathname !== "/mcp") return new Response("Not found", { status: 404 });

    // Um browser num site qualquer pode tentar falar com um servidor local (DNS rebinding).
    // Clientes MCP fora do browser não mandam Origin; os browsers mandam sempre.
    const origin = req.headers.get("origin");
    if (origin && !allowedOrigins.includes(origin)) {
      return new Response("Origin not allowed", { status: 403 });
    }

    // Sem sessões não há stream GET nem DELETE de sessão para servir.
    if (req.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
    }

    const server = createServer(db);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      maxRequestBodySize: 64 * 1024,
    });
    await server.connect(transport);
    try {
      return await transport.handleRequest(req);
    } finally {
      await server.close();
    }
  };
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? 3000);
  const hostname = process.env.HOST ?? "127.0.0.1";
  const list = (name: string) => (process.env[name] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const handler = createHttpHandler(openDb(), {
    allowedOrigins: list("JORAA_MCP_ALLOWED_ORIGINS"),
    allowedHosts: list("JORAA_MCP_ALLOWED_HOSTS"),
  });
  const srv = Bun.serve({ port, hostname, fetch: handler });
  console.error(`joraa-mcp a servir MCP em http://${srv.hostname}:${srv.port}/mcp`);
}
