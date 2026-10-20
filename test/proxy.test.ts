import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const base = (process.env.JORAA_PROXY_URL ?? "https://127.0.0.1:8443").replace(/\/$/, "");
if (new URL(base).protocol !== "https:") throw new Error("JORAA_PROXY_URL tem de usar HTTPS.");
// Mesma pasta que deploy/gen-cert.ts usa: JORAA_CERT_DIR ou deploy/certs.
const cert = join(process.env.JORAA_CERT_DIR ?? resolve(import.meta.dir, "../deploy/certs"), "joraa.crt");
const certExists = existsSync(cert);
const ca = certExists ? readFileSync(cert, "utf8") : "";
const allowedHost = "mcp.example.test";
let up = false;
if (!certExists) {
  console.error(`Testes do proxy ignorados: falta ${cert}.`);
} else {
  if (!ca.trim()) throw new Error(`O ficheiro de CA está vazio: ${cert}`);
  try {
    const probe = await fetch(`${base}/health`, { headers: { host: allowedHost }, tls: { ca }, signal: AbortSignal.timeout(1500) });
    await probe.arrayBuffer();
    // Qualquer resposta, incluindo 502 com o Bun desligado, obriga a executar os testes.
    up = true;
  } catch (error) {
    const connectionError = error instanceof Error && (
      error.name === "TimeoutError" || error.name === "AbortError" ||
      ("code" in error && ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH"].includes(String(error.code)))
    );
    if (!connectionError) throw new Error(`Falha na sondagem TLS do proxy em ${base}`, { cause: error });
    console.error(`Testes do proxy ignorados: sem ligação a ${base} (${error.message}).`);
  }
}

function proxyFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}${path}`, { ...init, tls: { ca }, signal: AbortSignal.timeout(5000) });
}

const headers = { host: allowedHost, "content-type": "application/json", accept: "application/json, text/event-stream" };
const initialize = JSON.stringify({
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "proxy-test", version: "0" } },
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

test.skipIf(!up)("/health responde por TLS com o Host permitido", async () => {
  const response = await proxyFetch("/health", { headers: { host: allowedHost } });
  expect(response.status).toBe(200);
  const body: unknown = await response.json();
  if (!isRecord(body)) throw new Error("Resposta /health sem um objeto JSON.");
  expect(body.ok).toBe(true);
  expect(typeof body.contracts).toBe("number");
  expect(body.contracts as number).toBeGreaterThan(0);
});

test.skipIf(!up)("initialize atravessa o proxy TLS e identifica o servidor MCP", async () => {
  const response = await proxyFetch("/mcp", { method: "POST", headers, body: initialize });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("application/json");
  const body: unknown = await response.json();
  if (!isRecord(body) || !isRecord(body.result) || !isRecord(body.result.serverInfo)) {
    throw new Error("Resposta initialize sem a estrutura JSON-RPC esperada.");
  }
  expect(body.jsonrpc).toBe("2.0");
  expect(body.id).toBe(1);
  expect(body.result.serverInfo.name).toBe("joraa-mcp");
  expect(typeof body.result.protocolVersion).toBe("string");
});

test.skipIf(!up)("um Host fora do server_name é fechado pelo nginx sem resposta (444)", async () => {
  const outcome = await proxyFetch("/mcp", { method: "POST", headers: { ...headers, host: "mau.example" }, body: initialize })
    .then((response) => `HTTP ${response.status}`, (error: unknown) => error);
  expect(outcome).toBeInstanceOf(Error);
});

test.skipIf(!up)("a outra rota também fica atrás do limite e responde 404", async () => {
  const response = await proxyFetch("/nada", { headers: { host: allowedHost } });
  await response.arrayBuffer();
  expect(response.status).toBe(404);
});

test.skipIf(!up)("um Origin proibido atravessa o proxy intacto e leva 403", async () => {
  const response = await proxyFetch("/mcp", {
    method: "POST", headers: { ...headers, origin: "https://mau.example" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
  });
  const body = await response.text();
  expect(response.status).toBe(403);
  expect(body).toBe("Origin not allowed");
});

test.skipIf(!up)("GET em /mcp leva 405 e anuncia POST", async () => {
  const response = await proxyFetch("/mcp", { headers: { host: allowedHost } });
  await response.arrayBuffer();
  expect(response.status).toBe(405);
  expect(response.headers.get("allow")).toBe("POST");
});

test.skipIf(!up)("o nginx recusa um corpo de 70 000 bytes com 413", async () => {
  const response = await proxyFetch("/mcp", { method: "POST", headers, body: "x".repeat(70_000) });
  await response.arrayBuffer();
  expect(response.status).toBe(413);
});

test.skipIf(!up)("uma rajada de 60 pedidos inclui sucessos e recusas 429", async () => {
  // 10 pedidos/s + burst 20 nodelay admitem cerca de 21 de imediato e recusam o resto.
  // Todos partilham a chave 127.0.0.1: este teste fica no fim e burst=20 dá margem aos testes 1–6.
  const results = await Promise.allSettled(Array.from({ length: 60 }, async () => {
    const response = await proxyFetch("/mcp", { method: "POST", headers, body: initialize });
    await response.arrayBuffer();
    return response.status;
  }));
  const statuses = results.map((result) => {
    if (result.status === "rejected") throw new Error("Falhou um pedido da rajada TLS.", { cause: result.reason });
    return result.value;
  });
  expect(statuses).toContain(429);
  expect(statuses).toContain(200);
  expect(statuses.every((status) => status === 200 || status === 429)).toBe(true);
}, 10_000);
