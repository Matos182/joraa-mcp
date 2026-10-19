import { afterAll, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { isAzores, toContract } from "../src/contracts/base";
import { openDb, upsertContracts } from "../src/contracts/db";
import { createHttpHandler } from "../src/serve";
import { rows } from "./fixtures";

const db = openDb(":memory:");
upsertContracts(db, rows.filter(isAzores).map(toContract));
const srv = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: createHttpHandler(db, { allowedOrigins: ["https://permitido.example"], allowedHosts: ["mcp.example.pt"] }) });
const base = `http://127.0.0.1:${srv.port}`;
afterAll(() => srv.stop(true));

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
  expect((await fetch(`${base}/mcp`)).status).toBe(405);
});

test("um Origin de browser não autorizado leva 403, um autorizado passa", async () => {
  const init = (origin: string) => ({
    method: "POST",
    headers: { origin, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  expect((await fetch(`${base}/mcp`, init("https://mau.example"))).status).toBe(403);
  expect((await fetch(`${base}/mcp`, init("https://permitido.example"))).status).not.toBe(403);
});

test("um Host fora da lista leva 421 (DNS rebinding), o domínio configurado passa", async () => {
  const health = (host: string) => fetch(`${base}/health`, { headers: { host } });
  expect((await health("mau.example:3000")).status).toBe(421);
  expect((await health("mcp.example.pt")).status).toBe(200);
  expect((await health("localhost:3000")).status).toBe(200);
});
