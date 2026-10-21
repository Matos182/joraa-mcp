import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ListPromptsResultSchema, ReadResourceResultSchema, type ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { countAvisos, getAvisosMeta, openAvisosWritableDb } from "../src/avisos/db";
import { countContracts, getMeta, listIngestedYears, openWritableDb, setMeta } from "../src/contracts/db";
import { createServer, describeSources, marketWords, todayInAzores } from "../src/server";
import { createHttpHandler } from "../src/serve";
import { seededAvisosDb } from "./avisos-fixtures";
import { seededDb } from "./fixtures";

const contracts = seededDb();
const avisos = seededAvisosDb();
const server = createServer(contracts, avisos);
const client = new Client({ name: "teste-prompts-recursos", version: "0" });
const extraDbs: Database[] = [];

function keepDb(db: Database): Database {
  extraDbs.push(db);
  return db;
}

beforeAll(async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
});

afterAll(async () => {
  await client.close();
  await server.close();
  contracts.close();
  avisos.close();
  for (const db of extraDbs) db.close();
});

async function promptText(name: string, args: Record<string, string> = {}): Promise<string> {
  const { messages } = await client.getPrompt({ name, arguments: args });
  expect(messages).toHaveLength(1);
  const message = messages[0]!;
  expect(message.role).toBe("user");
  expect(message.content.type).toBe("text");
  if (message.content.type !== "text") throw new Error("O prompt não devolveu texto.");
  return message.content.text;
}

const PromptCallSchema = z.object({ name: z.string(), arguments: z.record(z.string(), z.union([z.string(), z.number()])) });
type PromptCall = z.infer<typeof PromptCallSchema>;

function promptCalls(text: string): PromptCall[] {
  return [...text.matchAll(/```json\n([^]*?)\n```/g)].map((match) => PromptCallSchema.parse(JSON.parse(match[1]!)));
}

test("contratos_entidade: argumentos reais, limites, valores e pessoas singulares", async () => {
  const text = await promptText("contratos_entidade", {
    entidade: "EDA - Electricidade dos Açores, S.A.", desde: "2026-01-01", ate: "2026-10-21",
  });
  expect(promptCalls(text)).toEqual([{ name: "contracts_search", arguments: {
    entity: "EDA - Electricidade dos Açores, S.A.", from: "2026-01-01", to: "2026-10-21", limit: 100,
  } }]);
  for (const value of ["EDA - Electricidade dos Açores, S.A.", "2026-01-01", "2026-10-21", "limite inferior",
    "structuredContent.count", "value_eur", "source_url", "Lda", "S.A.", "Unipessoal", "pessoas singulares", "null"]) {
    expect(text).toContain(value);
  }
  expect(text).toContain("contar, ordenar ou agrupar pessoas singulares");
  expect(text).toContain("dentro dos resultados obtidos");
  expect(text).toContain("por data");
});

test("contratos_entidade: datas opcionais e entidade preservada literalmente", async () => {
  const entidade = 'EDA "Açores"\nSão Miguel';
  const text = await promptText("contratos_entidade", { entidade });
  expect(text).toContain(entidade);
  expect(promptCalls(text)).toEqual([{ name: "contracts_search", arguments: { entity: entidade, limit: 100 } }]);
});

test("avisos_empresa: duas chamadas com filtros separados e ligações para as fontes", async () => {
  const text = await promptText("avisos_empresa", { beneficiario: "privada", tema: "Inovação", data: "2026-10-21" });
  const calls = promptCalls(text);
  expect(calls).toEqual([
    { name: "avisos_search", arguments: { status: "Aberto", query: "Inovação", limit: 100 } },
    { name: "avisos_search", arguments: { open_on: "2026-10-21", beneficiary: "privada", query: "Inovação", limit: 100 } },
  ]);
  for (const value of ["não se cruzam", "snapshot_date", "não o de hoje", "dimensão da empresa", "source_url", "null"]) {
    expect(text).toContain(value);
  }
  for (const call of calls) {
    const result = await client.callTool(call);
    expect(result.isError).toBeFalsy();
    expect(z.object({ count: z.number() }).parse(result.structuredContent).count).toBeGreaterThan(0);
  }
});

test("avisos_empresa: sem argumentos usa a data corrente nos Açores e omite filtros ausentes", async () => {
  const before = todayInAzores();
  const calls = promptCalls(await promptText("avisos_empresa"));
  const after = todayInAzores();
  expect(calls).toHaveLength(2);
  expect(calls[0]).toEqual({ name: "avisos_search", arguments: { status: "Aberto", limit: 100 } });
  expect(Object.keys(calls[1]!.arguments)).toEqual(["open_on", "limit"]);
  expect([before, after]).toContain(z.string().parse(calls[1]!.arguments.open_on));
});

test("mapa_mercado: separa vírgulas, remove espaços e não altera o AND da pesquisa", async () => {
  const text = await promptText("mapa_mercado", {
    tema: "Infraestruturas dos Açores", palavras: " elétrica, estradas , , rede elétrica, ", desde: "2026-01-01",
  });
  expect(promptCalls(text)).toEqual(["elétrica", "estradas", "rede elétrica"].map((query) => ({
    name: "contracts_search", arguments: { query, from: "2026-01-01", limit: 100 },
  })));
  for (const value of ["Infraestruturas dos Açores", "AND", "id", "entity", "value_eur", "source_url",
    "limite inferior", "pessoas singulares", "null", "100"]) expect(text).toContain(value);
  expect(text).toContain('Palavras: ["elétrica","estradas","rede elétrica"]');
  expect(text).toContain("elimina duplicados por id");
});

test("mapa_mercado: sem palavras usa as palavras do tema e omite from", async () => {
  const text = await promptText("mapa_mercado", { tema: "  rede   elétrica\nAçores  " });
  expect(promptCalls(text)).toEqual(["rede", "elétrica", "Açores"].map((query) => ({
    name: "contracts_search", arguments: { query, limit: 100 },
  })));
});

test("mapa_mercado: uma lista vazia não produz uma pesquisa sem filtro", async () => {
  const emptyArgs: Record<string, string>[] = [{ tema: "de da do" }, { tema: "rede elétrica", palavras: " , , " }, { tema: "rede", palavras: "" }];
  for (const args of emptyArgs) {
    const text = await promptText("mapa_mercado", args);
    expect(promptCalls(text)).toEqual([]);
    expect(text).toContain("Não há palavras para pesquisar");
  }
});

test("prompts: só referem ferramentas existentes e os respetivos argumentos", async () => {
  const { tools } = await client.listTools();
  for (const [name, args] of [
    ["contratos_entidade", { entidade: "EDA", desde: "2026-01-01", ate: "2026-10-21" }],
    ["avisos_empresa", { beneficiario: "privada", tema: "inovação", data: "2026-10-21" }],
    ["mapa_mercado", { tema: "rede elétrica", palavras: "rede, elétrica", desde: "2026-01-01" }],
  ] satisfies [string, Record<string, string>][]) {
    const text = await promptText(name, args);
    const calls = promptCalls(text);
    expect(calls.length).toBeGreaterThan(0);
    for (const mentioned of text.match(/\b\w+_search\b/g) ?? []) {
      expect(["contracts_search", "avisos_search"]).toContain(mentioned);
    }
    for (const call of calls) {
      expect(["contracts_search", "avisos_search"]).toContain(call.name);
      const tool = tools.find((tool) => tool.name === call.name);
      expect(tool).toBeDefined();
      for (const key of Object.keys(call.arguments)) expect(Object.keys(tool!.inputSchema.properties ?? {})).toContain(key);
      if (call.arguments.status !== undefined) {
        expect(call.arguments.open_on).toBeUndefined();
        expect(call.arguments.beneficiary).toBeUndefined();
      }
    }
  }
});

test("prompts: argumentos obrigatórios, datas e comprimentos inválidos rejeitam com -32602", async () => {
  const invalid: [string, Record<string, string> | undefined][] = [
    ["contratos_entidade", undefined], ["contratos_entidade", {}], ["mapa_mercado", {}],
    ["contratos_entidade", { entidade: "EDA", desde: "21/10/2026" }],
    ["contratos_entidade", { entidade: "EDA", ate: "21/10/2026" }],
    ["avisos_empresa", { data: "21/10/2026" }], ["mapa_mercado", { tema: "rede", desde: "21/10/2026" }],
    ["contratos_entidade", { entidade: "a".repeat(201) }],
    ["avisos_empresa", { beneficiario: "a".repeat(21) }], ["avisos_empresa", { tema: "a".repeat(201) }],
    ["mapa_mercado", { tema: "a".repeat(201) }], ["mapa_mercado", { tema: "rede", palavras: "a".repeat(201) }],
  ];
  for (const [name, args] of invalid) {
    await expect(client.getPrompt({ name, arguments: args })).rejects.toMatchObject({ code: -32602 });
  }
});

test("prompts/list: três prompts com título e descrição", async () => {
  const { prompts } = await client.listPrompts();
  expect(prompts.map(({ name }) => name).sort()).toEqual(["avisos_empresa", "contratos_entidade", "mapa_mercado"]);
  for (const prompt of prompts) {
    expect(prompt.title).toBeTruthy();
    expect(prompt.description).toBeTruthy();
  }
});

test("resources/list: fontes em Markdown", async () => {
  const { resources } = await client.listResources();
  expect(resources).toContainEqual(expect.objectContaining({
    name: "fontes", uri: "joraa://fontes", mimeType: "text/markdown",
    title: expect.any(String), description: expect.any(String),
  }));
});

function resourceText(result: ReadResourceResult): string {
  expect(result.contents).toHaveLength(1);
  const content = result.contents[0]!;
  expect(content.uri).toBe("joraa://fontes");
  expect(content.mimeType).toBe("text/markdown");
  if (!("text" in content) || typeof content.text !== "string") throw new Error("O recurso não devolveu texto.");
  return content.text;
}

test("resources/read: contagens reais, anos importados, datas e limitações", async () => {
  const text = resourceText(await client.readResource({ uri: "joraa://fontes" }));
  expect(countContracts(contracts)).toBe(2);
  expect(text).toBe(describeSources(contracts, avisos));
  for (const value of [`${countContracts(contracts)} contrato(s)`, `${countAvisos(avisos)} aviso(s)`, "2026",
    getMeta(contracts, "last_ingest")!, getAvisosMeta(avisos, "last_ingest")!,
    `pt2030_xlsx: ${getAvisosMeta(avisos, "count_pt2030_xlsx")}`,
    `acores2030_plano: ${getAvisosMeta(avisos, "count_acores2030_plano")}`,
    "Portal BASE", "dados.gov.pt", "ZIP", "XLSX", "acores.portugal2030.pt", "WordPress",
    "localExecucao", "PT2", "AND", "uma pesquisa por palavra", "snapshot_date", "null", "sem estado",
    "JORAA", "bloqueia o acesso automatizado", "Centro de Edição do Jornal Oficial"]) expect(text).toContain(value);
});

test("resources/read: lê o estado atual em cada pedido", async () => {
  const db = keepDb(seededDb());
  const avisosDb = keepDb(seededAvisosDb());
  const liveServer = createServer(db, avisosDb);
  const liveClient = new Client({ name: "teste-recurso-atual", version: "0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await liveServer.connect(serverTransport);
  await liveClient.connect(clientTransport);
  try {
    const before = resourceText(await liveClient.readResource({ uri: "joraa://fontes" }));
    setMeta(db, "last_ingest", "2026-10-22T12:00:00.000Z");
    setMeta(db, "ingested_2025", "2026-10-22T12:00:00.000Z");
    avisosDb.prepare("UPDATE meta SET value = ? WHERE key = 'last_ingest'").run("2026-10-23T12:00:00.000Z");
    const after = resourceText(await liveClient.readResource({ uri: "joraa://fontes" }));
    expect(after).not.toBe(before);
    expect(after).toContain("2025, 2026");
    expect(after).toContain("2026-10-22T12:00:00.000Z");
    expect(after).toContain("2026-10-23T12:00:00.000Z");
  } finally {
    await liveClient.close();
    await liveServer.close();
  }
});

test("data de hoje nos Açores: UTC-1 no inverno e UTC no verão", () => {
  expect(todayInAzores(new Date("2026-12-01T00:30:00.000Z"))).toBe("2026-11-30");
  expect(todayInAzores(new Date("2026-12-01T01:30:00.000Z"))).toBe("2026-12-01");
  expect(todayInAzores(new Date("2026-07-01T00:30:00.000Z"))).toBe("2026-07-01");
});

test("anos importados: só chaves de anos, por ordem crescente", () => {
  const db = keepDb(openWritableDb(":memory:"));
  expect(listIngestedYears(db)).toEqual([]);
  for (const key of ["ingested_2026", "ingested_2012", "ingested_2025", "ingested_total", "ingestedX2024"]) {
    setMeta(db, key, "2026-10-21");
  }
  expect(listIngestedYears(db)).toEqual([2012, 2025, 2026]);
});

test("fontes: metadados ausentes são n/d, nunca zero", () => {
  const db = keepDb(seededDb());
  const avisosDb = keepDb(seededAvisosDb());
  db.exec("DELETE FROM meta");
  avisosDb.exec("DELETE FROM meta");
  const text = describeSources(db, avisosDb);
  expect(text.match(/last_ingest: n\/d/g)).toHaveLength(2);
  expect(text).toContain("Anos importados: n/d");
  expect(text).toContain("pt2030_xlsx: n/d");
  expect(text).toContain("acores2030_plano: n/d");
});

test("fontes: avisos ausentes, com erro ou vazios não são apresentados como zero", () => {
  for (const db of [undefined, new Error("O índice tem o esquema 99. Corre `bun run ingest:avisos` para o recriar."),
    keepDb(openAvisosWritableDb(":memory:"))]) {
    const text = describeSources(contracts, db);
    expect(text).toContain(db === undefined || db instanceof Error ? "O índice de avisos não está disponível" : "O índice de avisos está vazio");
    expect(text).toContain("bun run ingest:avisos");
    expect(text).not.toMatch(/\b0 avisos?\b/);
    expect(text).toContain(`${countContracts(contracts)} contrato(s)`);
  }
});

test("fontes: contratos vazios pedem importação, sem uma contagem zero", () => {
  const text = describeSources(keepDb(openWritableDb(":memory:")), avisos);
  expect(text).toContain("O índice de contratos está vazio");
  expect(text).toContain("bun run ingest");
  expect(text).not.toMatch(/\b0 contrato/);
  expect(text).toContain(`${countAvisos(avisos)} aviso(s)`);
});

test("fontes: falhas de contagem ou metadados são genéricas e não expõem valores", () => {
  for (const table of ["contracts", "meta"]) {
    const db = keepDb(seededDb());
    setMeta(db, "last_ingest", "valor reservado");
    db.exec(`DROP TABLE ${table}`);
    const text = describeSources(db, avisos);
    expect(text).toContain("Não foi possível ler o índice de contratos");
    expect(text).toContain("bun run ingest");
    expect(text).toContain(`${countAvisos(avisos)} aviso(s)`);
    expect(text).not.toMatch(/no such table|SQLite|valor reservado|\b0 contrato/);
  }
  for (const table of ["avisos", "meta"]) {
    const db = keepDb(seededAvisosDb());
    db.prepare("UPDATE meta SET value = ? WHERE key = 'last_ingest'").run("valor reservado");
    db.exec(`DROP TABLE ${table}`);
    const text = describeSources(contracts, db);
    expect(text).toContain("Não foi possível ler o índice de avisos");
    expect(text).toContain("bun run ingest:avisos");
    expect(text).toContain(`${countContracts(contracts)} contrato(s)`);
    expect(text).not.toMatch(/no such table|SQLite|valor reservado|\b0 avisos?\b/);
  }
});

async function callHttp(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const response = await createHttpHandler(contracts, { avisos })(new Request("http://localhost/mcp", {
    method: "POST",
    headers: { host: "localhost", "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  }));
  expect(response.status).toBe(200);
  const body = z.object({ result: z.unknown(), error: z.unknown().optional() }).parse(await response.json());
  expect(body.error).toBeUndefined();
  return body.result;
}

test("HTTP: prompts/list e resources/read expõem os mesmos conteúdos", async () => {
  const listed = ListPromptsResultSchema.parse(await callHttp("prompts/list"));
  expect(listed).toEqual(await client.listPrompts());
  const read = ReadResourceResultSchema.parse(await callHttp("resources/read", { uri: "joraa://fontes" }));
  expect(resourceText(read)).toBe(describeSources(contracts, avisos));
});

test("prompts: entidade ou tema em branco, beneficiário desconhecido e datas trocadas rejeitam com -32602", async () => {
  for (const [name, args] of [
    ["contratos_entidade", { entidade: "   " }],
    ["contratos_entidade", { entidade: "EDA", desde: "2026-06-01", ate: "2026-01-01" }],
    ["mapa_mercado", { tema: "  " }],
    ["avisos_empresa", { beneficiario: "empresa" }],
    ["avisos_empresa", { beneficiario: "PME" }],
  ] as const) {
    await expect(client.getPrompt({ name, arguments: args })).rejects.toMatchObject({ code: -32602 });
  }
});

test("avisos_empresa: beneficiário normalizado e limit 100 nas duas chamadas", async () => {
  const calls = promptCalls(await promptText("avisos_empresa", { beneficiario: "Pública", data: "2026-10-21" }));
  expect(calls.map((call) => call.arguments.limit)).toEqual([100, 100]);
  expect(calls[1]!.arguments.beneficiary).toBe("publica");
});

test("mapa_mercado: sem palavras de ligação, sem repetidos e no máximo MAX_TERMS pesquisas", () => {
  expect(marketWords("Manutenção de estradas e das pontes")).toEqual(["Manutenção", "estradas", "pontes"]);
  expect(marketWords("x", "rede,Rede, rede ,cabo")).toEqual(["rede", "cabo"]);
  expect(marketWords("x", Array.from({ length: 40 }, (_, i) => `p${i}`).join(","))).toHaveLength(8);
  expect(marketWords("de da do e")).toEqual([]);
});

test("contratos_entidade: a chamada gerada corre contra contracts_search sem erro", async () => {
  const [call] = promptCalls(await promptText("contratos_entidade", { entidade: "EDA" }));
  const result: any = await client.callTool(call!);
  expect(result.isError).toBeFalsy();
});
