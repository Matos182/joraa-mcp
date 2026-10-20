import { afterAll, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Contract } from "../src/contracts/base";
import { openWritableDb, replaceYear } from "../src/contracts/db";
import { createHttpHandler, MAX_BODY_BYTES, parseHostHeader, serveHttp } from "../src/serve";
import { seededDb } from "./fixtures";

const db = seededDb();
const srv = serveHttp(createHttpHandler(db, { allowedOrigins: ["https://permitido.example"], allowedHosts: ["mcp.example.pt"] }), { port: 0, hostname: "127.0.0.1" });
const base = `http://127.0.0.1:${srv.port}`;
const emptySrv = serveHttp(createHttpHandler(openWritableDb(":memory:")), { port: 0, hostname: "127.0.0.1" });
afterAll(() => { srv.stop(true); emptySrv.stop(true); });

const mcpHeaders = { "content-type": "application/json", accept: "application/json, text/event-stream" };
const call = (id: number, args: Record<string, unknown>) =>
  ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "contracts_search", arguments: args } });
const post = (body: string, headers: Record<string, string> = {}, url = `${base}/mcp`) =>
  fetch(url, { method: "POST", headers: { ...mcpHeaders, ...headers }, body });

// Pedido HTTP/1.1 em bruto, para cabeçalhos que o fetch não deixa mandar.
async function raw(request: string, port: number = srv.port!): Promise<{ status: number; text: string }> {
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    Bun.connect({
      hostname: "127.0.0.1", port,
      socket: {
        open(s) { s.write(request); },
        data(_s, d) { chunks.push(Buffer.from(d)); },
        close() { resolve(); },
        error(_s, e) { reject(e); },
      },
    }).catch(reject);
    setTimeout(() => resolve(), 2000);
  });
  const text = Buffer.concat(chunks).toString("latin1");
  return { status: Number(/^HTTP\/1\.1 (\d{3})/.exec(text)?.[1] ?? 0), text };
}

test("um cliente MCP real liga-se por HTTP, lista a tool e pesquisa", async () => {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  expect(client.getServerVersion()).toMatchObject({ name: "joraa-mcp" });
  const { tools } = await client.listTools();
  expect(tools.map((t) => t.name)).toContain("contracts_search");
  const res: any = await client.callTool({ name: "contracts_search", arguments: { entity: "EDA" } });
  expect(res.isError).toBeFalsy();
  expect(res.structuredContent.results[0].id).toBe("1001");
  await client.close();
});

test("rotas e métodos fora do contrato são recusados", async () => {
  expect((await fetch(`${base}/health`)).status).toBe(200);
  expect((await fetch(`${base}/outra`)).status).toBe(404);
  const get = await fetch(`${base}/mcp`);
  expect(get.status).toBe(405);
  expect(get.headers.get("allow")).toBe("POST");
});

test("/health diz se está pronto, com o número de contratos e a data do ingest", async () => {
  const res = await fetch(`${base}/health`);
  expect(res.status).toBe(200);
  const body: any = await res.json();
  expect(body.ok).toBe(true);
  expect(body.contracts).toBe(2);
  expect(body.last_ingest).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  const empty = await fetch(`http://127.0.0.1:${emptySrv.port}/health`);
  expect(empty.status).toBe(503);
  expect(await empty.json()).toEqual({ ok: false, contracts: 0, last_ingest: null });
});

test("/health só aceita GET", async () => {
  for (const method of ["POST", "PUT", "DELETE"]) {
    const res = await fetch(`${base}/health`, { method });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET");
  }
});

test("/health com a base inacessível dá 503 e não 500", async () => {
  const closed = openWritableDb(":memory:");
  closed.close();
  const res = await createHttpHandler(closed)(new Request("http://localhost/health", { headers: { host: "localhost" } }));
  expect(res.status).toBe(503);
  expect(await res.json()).toEqual({ ok: false, contracts: null, last_ingest: null });
});

test("um Origin de browser não autorizado leva 403, um autorizado passa", async () => {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  expect((await post(body, { origin: "https://mau.example" })).status).toBe(403);
  expect((await post(body, { origin: "https://permitido.example" })).status).toBe(200);
});

test("um Origin vazio conta como presente e leva 403", async () => {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const r = await raw(`POST /mcp HTTP/1.1\r\nHost: localhost\r\nOrigin: \r\nContent-Type: application/json\r\n` +
    `Accept: application/json, text/event-stream\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`);
  expect(r.status).toBe(403);
  expect(r.text).toContain("Origin not allowed");
});

test("um Host fora da lista leva 421 (DNS rebinding), o domínio configurado passa", async () => {
  const health = (host: string) => fetch(`${base}/health`, { headers: { host } });
  expect((await health("mau.example:3000")).status).toBe(421);
  expect((await health("mcp.example.pt")).status).toBe(200);
  expect((await health("MCP.example.pt:443")).status).toBe(200);
  expect((await health("localhost:3000")).status).toBe(200);
  expect((await health("[::1]:3000")).status).toBe(200);
});

test("parseHostHeader aceita só autoridades válidas", () => {
  expect(parseHostHeader("Example.PT:8443")).toBe("example.pt");
  expect(parseHostHeader("[::1]")).toBe("[::1]");
  expect(parseHostHeader("192.0.2.10:443")).toBe("192.0.2.10");
  for (const bad of [null, "", "[::1", "a b", "user@host", "host:99999", "host:", "host:-1", "host/x", "::1", "a:1:2"]) {
    expect(parseHostHeader(bad)).toBeNull();
  }
});

test("Host em falta ou malformado leva 421 em texto, nunca 500", async () => {
  const cases = ["", "Host: [::1\r\n", "Host: localhost:99999\r\n", "Host: user@localhost\r\n", "Host: a b\r\n", "Host: \r\n"];
  const seen: Record<string, number> = {};
  for (const h of cases) {
    const r = await raw(`GET /health HTTP/1.1\r\n${h}Connection: close\r\n\r\n`);
    seen[JSON.stringify(h)] = r.status;
    // O Bun pode recusar ele próprio pedidos inválidos com 400; o que nunca pode haver é 500 ou uma resposta 200.
    expect([400, 421]).toContain(r.status);
    if (r.status === 421) expect(r.text).toContain("Host not allowed");
  }
  console.error(`Host malformado -> estado: ${JSON.stringify(seen)}`);
});

test("HTTP/1.0 sem Host chega ao servidor e leva 421", async () => {
  // Em HTTP/1.1 o Bun responde 400 antes do handler; em HTTP/1.0 o Host é opcional e a verificação é nossa.
  const r = await raw(`GET /health HTTP/1.0\r\n\r\n`);
  expect(r.status).toBe(421);
  expect(r.text).toContain("Host not allowed");
});

test("lotes JSON-RPC são recusados com 400 antes do transporte", async () => {
  const batch = JSON.stringify([call(1, { entity: "EDA" }), call(2, { entity: "EDA" })]);
  const res = await post(batch);
  expect(res.status).toBe(400);
  const body: any = await res.json();
  expect(body.error.code).toBe(-32600);
  expect((await post("[]")).status).toBe(400);
});

test("JSON inválido dá 400 -32700 e um corpo acima do limite dá 413", async () => {
  const bad = await post("{ partido");
  expect(bad.status).toBe(400);
  expect(((await bad.json()) as any).error.code).toBe(-32700);
  expect((await post("x".repeat(MAX_BODY_BYTES + 1))).status).toBe(413);
  // Sem Content-Length: o limite é aplicado ao ler o stream.
  const stream = new ReadableStream({
    start(c) { for (let i = 0; i < 70; i++) c.enqueue(new Uint8Array(1024).fill(32)); c.close(); },
  });
  const res = await fetch(`${base}/mcp`, { method: "POST", headers: mcpHeaders, body: stream });
  expect(res.status).toBe(413);
});

test("o resultado de uma pesquisa leva structuredContent e um resumo curto, não o JSON duas vezes", async () => {
  const res = await post(JSON.stringify(call(1, { query: "rede" })));
  expect(res.status).toBe(200);
  const body: any = await res.json();
  expect(body.result.structuredContent.count).toBe(1);
  expect(body.result.content).toHaveLength(1);
  expect(body.result.content[0].text).not.toContain('"results"');
});

test("erros não tratados viram 500 em texto simples, sem stack", async () => {
  const boom = serveHttp(async () => { throw new Error("segredo interno /caminho/x"); }, { port: 0, hostname: "127.0.0.1" });
  const original = console.error;
  console.error = () => {};
  try {
    const res = await fetch(`http://127.0.0.1:${boom.port}/`);
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const text = await res.text();
    expect(text).toBe("Internal Server Error");
  } finally {
    console.error = original;
    boom.stop(true);
  }
});

// Pior caso do custo de pesquisa num índice de 20 000 contratos com vocabulário de prefixos curtos partilhados.
test("o pior pedido de pesquisa termina bem abaixo de 1 s com 20 000 contratos", async () => {
  const big = openWritableDb(":memory:");
  const syllables = ["ab", "ac", "ad", "ae", "af", "ag", "ah", "ai", "aj", "al", "am", "an", "ap", "ar", "as", "at"];
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const word = () => Array.from({ length: 2 + Math.floor(rnd() * 3) }, () => syllables[Math.floor(rnd() * syllables.length)]).join("");
  const words = (n: number) => Array.from({ length: n }, word).join(" ");
  const rows: Contract[] = Array.from({ length: 20_000 }, (_, i) => ({
    id: `s${i}`, entity: `Entidade ${words(3)}`, entity_nif: null, contractors: [], object: words(12),
    description: words(40), contract_type: null, procedure: null, value_eur: i, signed_on: `2026-01-${String(1 + (i % 28)).padStart(2, "0")}`,
    published_on: null, location: null, nuts: null, cpv: null, source_url: `https://example.org/${i}`,
  }));
  replaceYear(big, 2026, rows);
  const bigSrv = serveHttp(createHttpHandler(big), { port: 0, hostname: "127.0.0.1" });
  try {
    const url = `http://127.0.0.1:${bigSrv.port}/mcp`;
    const time = async (body: string) => {
      const t0 = performance.now();
      const res = await post(body, {}, url);
      const json: any = await res.json();
      return { ms: performance.now() - t0, status: res.status, json };
    };
    // (a) 64 KiB, o maior corpo aceite: a validação da tool recusa o texto acima de 200 caracteres.
    const filler = "ab ".repeat(30_000);
    let huge = JSON.stringify(call(1, { entity: filler, query: filler }));
    huge = JSON.stringify(call(1, { entity: filler.slice(0, filler.length - (huge.length - MAX_BODY_BYTES) / 2 - 2), query: filler.slice(0, filler.length - (huge.length - MAX_BODY_BYTES) / 2 - 2) }));
    expect(Buffer.byteLength(huge)).toBeLessThanOrEqual(MAX_BODY_BYTES);
    expect(Buffer.byteLength(huge)).toBeGreaterThan(MAX_BODY_BYTES - 64);
    const a = await time(huge);
    expect(a.status).toBe(200);
    expect(a.json.result.isError).toBe(true);
    // (b) os pedidos aceites mais caros: até 200 caracteres por campo, prefixos curtos muito comuns
    // (2, 3 e 4 letras), 100 resultados, sem datas. Mede-se cada forma e fica o pior.
    const pad = (s: string) => (s + " " + "x".repeat(200)).slice(0, 200);
    const two = syllables.slice(0, 8).join(" ");
    const three = syllables.slice(0, 8).map((s) => s + "a").join(" ");
    const four = syllables.slice(0, 8).map((s) => s + "ab").join(" ");
    const shapes: Record<string, Record<string, unknown>> = {
      "entity+query, 8×2 letras": { entity: pad(two), query: pad(two), limit: 100 },
      "query, 8×2 letras": { query: pad(two), limit: 100 },
      "query, 1×2 letras": { query: "ab", limit: 100 },
      "query, 8×3 letras": { query: pad(three), limit: 100 },
      "query, 8×4 letras": { query: pad(four), limit: 100 },
      "entity, 1×2 letras": { entity: "ab", limit: 100 },
    };
    const report: string[] = [];
    let worstMs = 0;
    for (const [name, args] of Object.entries(shapes)) {
      const body = JSON.stringify(call(2, args));
      expect(Buffer.byteLength(body)).toBeLessThan(MAX_BODY_BYTES);
      await time(body); // aquecimento
      let max = 0;
      let count = 0;
      for (let i = 0; i < 5; i++) {
        const r = await time(body);
        expect(r.status).toBe(200);
        expect(r.json.result.isError).toBeFalsy();
        max = Math.max(max, r.ms);
        count = r.json.result.structuredContent.count;
      }
      worstMs = Math.max(worstMs, max);
      report.push(`${name}: ${max.toFixed(1)} ms, ${count} resultados`);
    }
    console.error(`pior caso (20 000 contratos, máx. de 5 corridas): 64 KiB recusado em ${a.ms.toFixed(1)} ms; ${report.join("; ")}`);
    expect(a.ms).toBeLessThan(1000);
    expect(worstMs).toBeLessThan(1000);
  } finally {
    bigSrv.stop(true);
  }
}, 60_000);
