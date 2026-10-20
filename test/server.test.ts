import { afterAll, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Contract } from "../src/contracts/base";
import { openWritableDb } from "../src/contracts/db";
import { summarize } from "../src/server";
import { seededDb } from "./fixtures";

const dir = mkdtempSync(join(tmpdir(), "joraa-mcp-"));
const dbPath = join(dir, "c.sqlite");
seededDb(dbPath).close();
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const root = join(import.meta.dir, "..");

async function connect(env: Record<string, string>) {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StdioClientTransport({
    command: "bun", args: ["src/index.ts"], cwd: root,
    env: { ...process.env, ...env } as Record<string, string>,
  }));
  return client;
}

test("o servidor stdio inicializa, lista a tool e responde", async () => {
  const client = await connect({ JORAA_MCP_DB: dbPath });
  expect(client.getServerVersion()).toMatchObject({ name: "joraa-mcp", version: "0.1.0" });
  const { tools } = await client.listTools();
  for (const t of tools) {
    expect(t.description!.length).toBeGreaterThan(50);
    expect(t.inputSchema.type).toBe("object");
  }
  expect(tools.map((t) => t.name)).toContain("contracts_search");
  const res: any = await client.callTool({ name: "contracts_search", arguments: { entity: "EDA" } });
  expect(res.isError).toBeFalsy();
  expect(res.structuredContent.results[0].id).toBe("1001");
  expect(res.structuredContent.last_ingest).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  // O texto é um resumo, não uma segunda cópia do JSON.
  expect(res.content).toHaveLength(1);
  expect(res.content[0].text).not.toContain("{");
  expect(res.content[0].text).toContain("1 contrato(s)");
  expect(res.content[0].text).toContain(res.structuredContent.results[0].source_url);
  await client.close();
}, 20_000);

test("texto de mais de 200 caracteres é recusado pela validação da tool", async () => {
  const client = await connect({ JORAA_MCP_DB: dbPath });
  const res: any = await client.callTool({ name: "contracts_search", arguments: { query: "a".repeat(201) } });
  expect(res.isError).toBe(true);
  await client.close();
}, 20_000);

test("sem o ficheiro do índice o processo termina com um erro claro e não cria nada", async () => {
  const missing = join(dir, "nao-existe", "c.sqlite");
  const proc = Bun.spawn(["bun", "src/index.ts"], {
    cwd: root, env: { ...process.env, JORAA_MCP_DB: missing }, stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  const code = await proc.exited;
  const stderr = await new Response(proc.stderr).text();
  expect(code).toBe(1);
  expect(stderr).toContain("bun run ingest");
  expect(existsSync(missing)).toBe(false);
}, 20_000);

test("com o índice criado mas vazio devolve um erro claro", async () => {
  const empty = join(dir, "vazio.sqlite");
  openWritableDb(empty).close();
  const client = await connect({ JORAA_MCP_DB: empty });
  const res: any = await client.callTool({ name: "contracts_search", arguments: {} });
  expect(res.isError).toBe(true);
  expect(res.content[0].text).toContain("bun run ingest");
  await client.close();
}, 20_000);

test("o resumo tem no máximo 10 linhas de contratos e corta objetos longos", () => {
  const c = (i: number): Contract => ({
    id: String(i), entity: "Entidade", entity_nif: null, contractors: ["Fornecedor"], object: "o".repeat(300),
    description: "d".repeat(5000), contract_type: null, procedure: null, value_eur: i, signed_on: "2026-01-01",
    published_on: null, location: null, nuts: null, cpv: null, source_url: `https://example.org/${i}`,
  });
  const text = summarize(Array.from({ length: 100 }, (_, i) => c(i)), "2026-01-02T00:00:00.000Z");
  const lines = text.split("\n");
  expect(lines).toHaveLength(12);
  expect(lines[0]).toContain("100 contrato(s)");
  expect(lines.at(-1)).toBe("(+90 em structuredContent)");
  expect(text).not.toContain("d".repeat(100));
  expect(text).not.toContain("Fornecedor");
  expect(text.length).toBeLessThan(2000);
  expect(summarize([], null)).toBe("0 contrato(s) encontrado(s). Os dados completos estão em structuredContent.");
});
