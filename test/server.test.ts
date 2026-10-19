import { afterAll, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isAzores, toContract } from "../src/contracts/base";
import { openDb, upsertContracts } from "../src/contracts/db";
import { rows } from "./fixtures";

const dir = mkdtempSync(join(tmpdir(), "joraa-mcp-"));
const dbPath = join(dir, "c.sqlite");
const db = openDb(dbPath);
upsertContracts(db, rows.filter(isAzores).map(toContract));
db.close();
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function connect(env: Record<string, string>) {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StdioClientTransport({
    command: "bun", args: ["src/index.ts"], cwd: join(import.meta.dir, ".."),
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
  await client.close();
}, 20_000);

test("com o índice vazio devolve um erro claro", async () => {
  const client = await connect({ JORAA_MCP_DB: join(dir, "vazio.sqlite") });
  const res: any = await client.callTool({ name: "contracts_search", arguments: {} });
  expect(res.isError).toBe(true);
  expect(res.content[0].text).toContain("bun run ingest");
  await client.close();
}, 20_000);
