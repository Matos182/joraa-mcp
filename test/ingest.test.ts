import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { countContracts, getMeta, openReadOnlyDb, openWritableDb, replaceYear } from "../src/contracts/db";
import { azoresRows, DADOS_GOV_HOSTS, DATASET_API, ingestYear, parseYears, resolveZipUrl } from "../src/contracts/ingest";
import { searchContracts } from "../src/contracts/search";
import { createHttp, EgressDeniedError } from "../src/http";
import { rows } from "./fixtures";

const dir = mkdtempSync(join(tmpdir(), "joraa-mcp-ingest-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const ZIP_URL = "https://dados.gov.pt/s/resources/contratos2026.zip";
const zipOf = (files: Record<string, unknown>) =>
  zipSync(Object.fromEntries(Object.entries(files).map(([n, v]) => [n, strToU8(typeof v === "string" ? v : JSON.stringify(v))])));

function source({ metadata, zip }: { metadata?: unknown; zip?: Uint8Array }) {
  const calls: string[] = [];
  const fetch = async (url: string) => {
    calls.push(url);
    if (url === DATASET_API) {
      return Response.json(metadata ?? { resources: [{ title: "contratos2026.zip", url: ZIP_URL }, { title: "outro.csv", url: "https://dados.gov.pt/x" }] });
    }
    if (url === ZIP_URL && zip) return new Response(zip);
    return new Response("not found", { status: 404 });
  };
  return { http: createHttp({ allowedHosts: DADOS_GOV_HOSTS, ttlMs: 0, fetch }), calls };
}

test("importa os contratos açorianos de um ZIP e conta as linhas sem idcontrato", async () => {
  const path = join(dir, "ok.sqlite");
  const noId = [{ ...rows[0], idcontrato: "  " }, { ...rows[1], idcontrato: undefined }];
  const { http, calls } = source({ zip: zipOf({ "contratos2026.json": [...rows, ...noId], "leia-me.txt": "ignorado" }) });
  const r = await ingestYear(2026, path, http);
  expect(r).toEqual({ year: 2026, url: ZIP_URL, azores: 2, rejected: 2, total: 2 });
  expect(calls).toEqual([DATASET_API, ZIP_URL]);
  const db = openReadOnlyDb(path);
  expect(searchContracts(db, { entity: "EDA" }).map((c) => c.id)).toEqual(["1001"]);
  expect(getMeta(db, "ingested_2026")).not.toBeNull();
  db.close();
});

test("um ZIP sem contratos açorianos é recusado e o índice existente fica igual", async () => {
  const path = join(dir, "vazio.sqlite");
  const w = openWritableDb(path);
  replaceYear(w, 2026, rows.filter((r) => r.idcontrato !== "2001").map((r) => ({
    id: String(r.idcontrato), entity: null, entity_nif: null, contractors: [], object: "x", description: null,
    contract_type: null, procedure: null, value_eur: null, signed_on: null, published_on: null, location: null,
    nuts: null, cpv: null, source_url: `https://example.org/${r.idcontrato}`,
  })));
  const before = getMeta(w, "last_ingest");
  w.close();
  const { http } = source({ zip: zipOf({ "contratos2026.json": [rows[2]] }) });
  await expect(ingestYear(2026, path, http)).rejects.toThrow(/não tem contratos/);
  const db = openReadOnlyDb(path);
  expect(countContracts(db)).toBe(2);
  expect(getMeta(db, "last_ingest")).toBe(before);
  db.close();
});

test("um JSON que não é uma lista é um erro e não uma importação vazia", () => {
  expect(() => azoresRows(zipOf({ "a.json": { contratos: [] } }))).toThrow(/não é uma lista/);
  expect(() => azoresRows(zipOf({ "a.json": "{ partido" }))).toThrow();
});

test("idcontrato numérico é aceite; vazio, nulo ou ausente é recusado", () => {
  const { rows: ok, rejected } = azoresRows(zipOf({
    "a.json": [{ ...rows[0], idcontrato: 7 }, { ...rows[0], idcontrato: "" }, { ...rows[0], idcontrato: null }, { ...rows[0], idcontrato: undefined }],
  }));
  expect(ok.map((r) => r.idcontrato)).toEqual([7]);
  expect(rejected).toBe(3);
});

test("metadados da API com outra forma dão um erro que diz o que faltou", async () => {
  const { http } = source({ metadata: { data: [] } });
  await expect(resolveZipUrl(http, 2026)).rejects.toThrow(/Resposta inesperada da API.*resources/s);
});

test("um ano que não está no dataset é um erro explícito", async () => {
  const { http } = source({});
  await expect(resolveZipUrl(http, 1999)).rejects.toThrow(/contratos1999\.zip/);
});

test("um ficheiro alojado fora da lista é recusado antes de qualquer ligação a esse anfitrião", async () => {
  const path = join(dir, "egress.sqlite");
  const { http, calls } = source({ metadata: { resources: [{ title: "contratos2026.zip", url: "https://static.example.net/c.zip" }] } });
  const err = await ingestYear(2026, path, http).catch((e) => e);
  expect(err).toBeInstanceOf(EgressDeniedError);
  expect(err.message).toContain("static.example.net");
  expect(calls).toEqual([DATASET_API]);
});

test("parseYears aceita só anos de 4 dígitos e usa o ano corrente sem argumentos", () => {
  expect(parseYears([], new Date("2026-05-01T00:00:00Z"))).toEqual([2026]);
  expect(parseYears(["2024", "2025"])).toEqual([2024, 2025]);
  for (const bad of ["26", "2026a", "../x", "", "20266"]) expect(() => parseYears([bad])).toThrow(/Ano inválido/);
});
