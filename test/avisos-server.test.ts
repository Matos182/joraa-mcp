import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAvisosWritableDb } from "../src/avisos/db";
import type { AvisoResult } from "../src/avisos/types";
import { summarizeAvisos } from "../src/server";
import { createHttpHandler } from "../src/serve";
import { AVISOS_NOW, seededAvisosDb } from "./avisos-fixtures";
import { seededDb } from "./fixtures";

const dir = mkdtempSync(join(tmpdir(), "joraa-mcp-avisos-server-"));
const dbPath = join(dir, "contratos.sqlite");
seededDb(dbPath).close();
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function connect(env: Record<string, string>): Promise<Client> {
  const client = new Client({ name: "test", version: "0" });
  const transport = new StdioClientTransport({
    command: "bun", args: ["src/index.ts"], cwd: join(import.meta.dir, ".."),
    env: { ...process.env, ...env } as Record<string, string>,
  });
  try {
    await client.connect(transport);
    return client;
  } catch (error) {
    await transport.close();
    throw error;
  }
}

function aviso(overrides: Partial<AvisoResult> = {}): AvisoResult {
  return {
    source: "pt2030_xlsx", code: "AVISO-1", title: null, status: null, program: null,
    funds: [], objectives: [], amount_eur: null, starts_on: null, ends_on: null,
    beneficiary: null, snapshot_date: null, source_url: "https://dados.gov.pt/avisos.xlsx",
    ...overrides,
  };
}

test("resumo: 30 avisos ocupam dez linhas e o título cortado tem 80 caracteres", () => {
  const results = Array.from({ length: 30 }, (_, i) => aviso({ code: `AVISO-${i}`, title: "t".repeat(100) }));
  const text = summarizeAvisos(results, AVISOS_NOW.toISOString());
  expect(text.split("\n")).toHaveLength(10);
  expect(text).toContain("30 aviso(s) encontrado(s); índice atualizado em " + AVISOS_NOW.toISOString());
  expect(text).toContain("(+22 em structuredContent)");
  expect(text).toContain("t".repeat(79) + "…");
  expect(text).not.toContain("t".repeat(80));
  expect(text).toContain("programa n/d · estado n/d · montante n/d · sem janela");
  expect(text).not.toContain("{");
});

test("resumo: sem resultados há só uma linha", () => {
  expect(summarizeAvisos([], null)).toBe("0 aviso(s) encontrado(s). Os dados completos estão em structuredContent.");
});

test("resumo: campos preenchidos, título curto e montante zero são preservados", () => {
  const row = aviso({ title: "t".repeat(80), program: "AÇORES2030", status: "Aberto", amount_eur: 1234.5,
    starts_on: "2026-09-01", ends_on: "2026-10-31" });
  expect(summarizeAvisos([row], null)).toContain(
    `- AVISO-1 · ${row.title} · AÇORES2030 · Aberto · 1234.5 EUR · 2026-09-01–2026-10-31 · ${row.source_url}`,
  );
  expect(summarizeAvisos([aviso({ amount_eur: 0, starts_on: "2026-09-01" })], null)).toContain("0 EUR · sem janela");
  expect(summarizeAvisos([aviso({ ends_on: "2026-10-31" })], null)).toContain("sem janela");
  expect(summarizeAvisos([aviso()], null)).toContain("título n/d");
});

test("resumo: quebras de linha e chavetas da fonte não alteram o formato", () => {
  const text = summarizeAvisos(Array.from({ length: 30 }, () => aviso({
    title: "Título\n{texto}", program: "Programa\r\nregional", code: "A\u2028B",
  })), null);
  expect(text.split("\n")).toHaveLength(10);
  expect(text).not.toContain("{");
  expect(text).not.toContain("\u2028");
});

async function expectContracts(client: Client): Promise<void> {
  const result: any = await client.callTool({ name: "contracts_search", arguments: { entity: "EDA" } });
  expect(result.isError).toBeFalsy();
  expect(result.structuredContent.results[0].id).toBe("1001");
}

test("stdio: índice de avisos ausente mantém ambas as tools e os contratos disponíveis", async () => {
  const path = join(dir, "ausente", "avisos.sqlite");
  const client = await connect({ JORAA_MCP_DB: dbPath, JORAA_MCP_AVISOS_DB: path });
  try {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["contracts_search", "avisos_search"]));
    const result: any = await client.callTool({ name: "avisos_search", arguments: {} });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("bun run ingest:avisos");
    await expectContracts(client);
  } finally {
    await client.close();
  }
  expect(existsSync(path)).toBe(false);
}, 20_000);

test("stdio: esquema 99 é recusado sem alterar o ficheiro nem impedir contratos", async () => {
  const path = join(dir, "esquema.sqlite");
  const db = new Database(path);
  db.exec("PRAGMA user_version = 99");
  db.close();
  const before = readFileSync(path);
  const client = await connect({ JORAA_MCP_DB: dbPath, JORAA_MCP_AVISOS_DB: path });
  try {
    const result: any = await client.callTool({ name: "avisos_search", arguments: {} });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("esquema 99");
    expect(result.content[0].text).toContain("bun run ingest:avisos");
    await expectContracts(client);
  } finally {
    await client.close();
  }
  expect(readFileSync(path)).toEqual(before);
}, 20_000);

test("stdio: pesquisa nacional e regional devolve dados e resumo sem tokens", async () => {
  const path = join(dir, "avisos.sqlite");
  seededAvisosDb(path).close();
  const before = readFileSync(path);
  const client = await connect({ JORAA_MCP_DB: dbPath, JORAA_MCP_AVISOS_DB: path });
  try {
    const national: any = await client.callTool({ name: "avisos_search", arguments: {
      program: "ACORES2030", status: "Aberto", query: "pequenos negócios",
    } });
    expect(national.isError).toBeFalsy();
    expect(national.structuredContent.count).toBe(1);
    expect(national.structuredContent.results[0].code).toBe("ACORES2030-2026-15");
    expect(national.structuredContent.last_ingest).toBe(AVISOS_NOW.toISOString());
    expect(national.content[0].text).toContain("ACORES2030-2026-15");
    expect(national.content[0].text).not.toContain("{");
    const regional: any = await client.callTool({ name: "avisos_search", arguments: {
      open_on: "2026-10-21", beneficiary: "privada",
    } });
    expect(regional.isError).toBeFalsy();
    expect(regional.structuredContent.count).toBe(2);
    expect(regional.structuredContent.results.every((row: AvisoResult) => row.source === "acores2030_plano")).toBe(true);
    expect(JSON.stringify([national, regional])).not.toMatch(/SECRET|token=/);
    await expectContracts(client);
  } finally {
    await client.close();
  }
  expect(readFileSync(path)).toEqual(before);
}, 20_000);

test("stdio: índice de avisos vazio devolve isError", async () => {
  const path = join(dir, "vazio.sqlite");
  openAvisosWritableDb(path).close();
  const client = await connect({ JORAA_MCP_DB: dbPath, JORAA_MCP_AVISOS_DB: path });
  try {
    const result: any = await client.callTool({ name: "avisos_search", arguments: {} });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("vazio");
    expect(result.content[0].text).toContain("bun run ingest:avisos");
  } finally {
    await client.close();
  }
}, 20_000);

const contracts = seededDb();
afterAll(() => contracts.close());

// O transporte recebe o pedido diretamente, sem rede nem sockets.
async function callHttp(avisos?: Database | Error, args: Record<string, unknown> = {}): Promise<any> {
  const response = await createHttpHandler(contracts, { avisos })(new Request("http://localhost/mcp", {
    method: "POST",
    headers: { host: "localhost", "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "avisos_search", arguments: args } }),
  }));
  expect(response.status).toBe(200);
  const body: any = await response.json();
  expect(body.error).toBeUndefined();
  return body.result;
}

test("HTTP: índice opcional ausente ou com erro devolve isError", async () => {
  const missing = await callHttp();
  expect(missing.isError).toBe(true);
  expect(missing.content[0].text).toBe("O índice de avisos não está disponível. Corre `bun run ingest:avisos` para o criar.");
  const message = "O índice tem o esquema 99. Corre `bun run ingest:avisos` para o recriar.";
  const failed = await callHttp(new Error(message));
  expect(failed.isError).toBe(true);
  expect(failed.content[0].text).toBe(message);
});

test("HTTP: índice vazio devolve isError", async () => {
  const db = openAvisosWritableDb(":memory:");
  try {
    const result = await callHttp(db);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("vazio");
  } finally { db.close(); }
});

test("HTTP: o índice recebido fornece resultados, filtros e metadados", async () => {
  const db = seededAvisosDb();
  try {
    const result = await callHttp(db, { program: "ACORES2030", status: "Aberto", query: "pequenos negócios", limit: 1 });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent.count).toBe(1);
    expect(result.structuredContent.results[0].code).toBe("ACORES2030-2026-15");
    expect(result.structuredContent.last_ingest).toBe(AVISOS_NOW.toISOString());
    expect(result.content[0].text).toContain("ACORES2030-2026-15");
    const regional = await callHttp(db, { open_on: "2026-10-21", beneficiary: "privada" });
    expect(regional.structuredContent.count).toBe(2);
    expect(regional.structuredContent.results.every((row: AvisoResult) => row.source === "acores2030_plano")).toBe(true);
    expect(JSON.stringify([result, regional])).not.toMatch(/SECRET|token=/);
    db.exec("DELETE FROM meta");
    expect((await callHttp(db, { query: "inexistente" })).structuredContent).toEqual({ count: 0, last_ingest: null, results: [] });
  } finally { db.close(); }
});

test("HTTP: argumentos inválidos são recusados antes da consulta", async () => {
  for (const args of [
    { query: "a".repeat(201) }, { program: "a".repeat(101) }, { status: "Planeado" },
    { beneficiary: "a".repeat(21) }, { open_on: "21/10/2026" }, { limit: 0 }, { limit: 101 }, { limit: 1.5 },
  ]) {
    const result = await callHttp(undefined, args);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).not.toContain("não está disponível");
  }
});

for (const [name, sql] of [
  ["contagem", "DROP TABLE avisos"],
  ["pesquisa", "UPDATE avisos SET funds = 'token=SECRET'"],
  ["metadados", "DROP TABLE meta"],
] as const) {
  test(`HTTP: erro de ${name} é isError sem dados brutos`, async () => {
    const db = seededAvisosDb();
    try {
      db.exec(sql);
      const result = await callHttp(db);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
      expect(result.content[0].text).toContain("Não foi possível");
      expect(result.content[0].text).toContain("avisos");
      expect(JSON.stringify(result)).not.toMatch(/SECRET|token=/);
    } finally { db.close(); }
  });
}
