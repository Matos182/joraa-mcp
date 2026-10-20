import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AvisosDbUnavailableError, countAvisos, EmptySourceError, getAvisosMeta,
  openAvisosReadOnlyDb, openAvisosWritableDb, replaceAvisos,
} from "../src/avisos/db";
import { AVISOS_DATASET_API, ingestAvisos, resolveXlsxUrl } from "../src/avisos/ingest";
import type { AvisoRow, AvisoSource } from "../src/avisos/types";
import { fetchWpAvisos, WP_API, WP_MAX_PAGES, WP_PAGE_SIZE } from "../src/avisos/wp";
import { parseAvisosXlsx, XLSX_HEADERS } from "../src/avisos/xlsx";
import { EgressDeniedError, SourceUnavailableError } from "../src/http";
import { AVISOS_NOW, AVISOS_XLSX_URL, avisosSource, avisosXlsx, seededAvisosDb, wpItem, xlsxOf } from "./avisos-fixtures";

const dir = mkdtempSync(join(tmpdir(), "joraa-mcp-avisos-ingest-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const pageUrl = (page: number) => `${WP_API}?per_page=50&page=${page}`;
const items = (count: number, offset = 0) => Array.from({ length: count }, (_, i) => wpItem(offset + i + 1));
const resource = (date: string, url = AVISOS_XLSX_URL) => ({ title: `02-datasets-avisos-pt2030-${date}.xlsx`, url });

test("importa as duas fontes, preserva as linhas repartidas e grava metadados e FTS", async () => {
  const path = join(dir, "ok.sqlite");
  const { http, calls } = avisosSource();
  const result = await ingestAvisos(path, http, AVISOS_NOW);
  expect(result).toEqual({ xlsx_url: AVISOS_XLSX_URL, pt2030_xlsx: 5, acores2030_plano: 1, total: 6 });
  expect(calls).toEqual([AVISOS_DATASET_API, AVISOS_XLSX_URL, pageUrl(1)]);
  const db = openAvisosReadOnlyDb(path);
  try {
    expect(countAvisos(db)).toBe(6);
    expect(getAvisosMeta(db, "last_ingest")).toBe(AVISOS_NOW.toISOString());
    expect(getAvisosMeta(db, "xlsx_url")).toBe(AVISOS_XLSX_URL);
    expect(getAvisosMeta(db, "count_pt2030_xlsx")).toBe("5");
    expect(getAvisosMeta(db, "count_acores2030_plano")).toBe("1");
    expect(getAvisosMeta(db, "ausente")).toBeNull();
    expect(db.query("SELECT source, count(*) AS n FROM avisos GROUP BY source ORDER BY source").all())
      .toEqual([{ source: "acores2030_plano", n: 1 }, { source: "pt2030_xlsx", n: 5 }]);
    expect(db.query("SELECT program, sum(amount_eur) AS n FROM avisos WHERE code = 'MPr-2023-1' GROUP BY program ORDER BY program").all())
      .toEqual([{ program: "ACORES2030", n: 2000 }, { program: "COMPETE2030", n: 15000 }]);
    expect(db.query("SELECT count(*) AS n FROM avisos_fts WHERE avisos_fts MATCH 'Qualificação'").get()).toEqual({ n: 1 });
    expect(db.query("SELECT count(*) AS n FROM avisos a JOIN avisos_fts f ON f.rowid = a.rid").get()).toEqual({ n: 6 });
    expect(db.query("SELECT starts_on, ends_on, beneficiary, beneficiary_search FROM avisos WHERE source = 'pt2030_xlsx' LIMIT 1").get())
      .toEqual({ starts_on: null, ends_on: null, beneficiary: null, beneficiary_search: null });
    expect(db.query("SELECT status, funds, objectives, beneficiary, beneficiary_search FROM avisos WHERE source = 'acores2030_plano'").get())
      .toEqual({ status: null, funds: '["FEDER"]', objectives: '["Inovação"]', beneficiary: '["Privada"]', beneficiary_search: "privada" });
    expect(() => db.exec("DELETE FROM avisos")).toThrow();
  } finally { db.close(); }
  for (const text of [readFileSync(path).toString(), JSON.stringify(result)]) {
    expect(text).not.toContain("SECRET");
    expect(text).not.toContain("token=");
  }
});

test("escolhe 02 mesmo com 01 primeiro e nunca transfere 01", async () => {
  const url01 = "https://dados.gov.pt/01.xlsx";
  const { http, calls } = avisosSource({ metadata: { resources: [
    { title: "01-datasets-avisos-pt2030-30102026.xlsx", url: url01 }, resource("30092026"),
  ] } });
  await ingestAvisos(join(dir, "selecao.sqlite"), http);
  expect(calls).not.toContain(url01);
  expect(calls).toContain(AVISOS_XLSX_URL);
});

test("escolhe a data mais recente por calendário e conserva a primeira em empate ou sem datas válidas", async () => {
  const cases = [
    { resources: [resource("31122025", "https://dados.gov.pt/velho"), resource("01012026")], expected: AVISOS_XLSX_URL },
    { resources: [resource("30092026"), resource("01082026", "https://dados.gov.pt/velho")], expected: AVISOS_XLSX_URL },
    { resources: [resource("sem-data"), resource("outro", "https://dados.gov.pt/outro")], expected: AVISOS_XLSX_URL },
    { resources: [resource("30092026"), resource("30092026", "https://dados.gov.pt/outro")], expected: AVISOS_XLSX_URL },
    { resources: [resource("31022027", "https://dados.gov.pt/invalido"), resource("30092026")], expected: AVISOS_XLSX_URL },
    { resources: [resource("sem-data", "https://dados.gov.pt/sem-data"), resource("30092026")], expected: AVISOS_XLSX_URL },
    { resources: [{ title: "02-DATASETS-AVISOS-PT2030-30092026.XLSX", url: AVISOS_XLSX_URL }], expected: AVISOS_XLSX_URL },
  ];
  for (const { resources, expected } of cases) {
    expect(await resolveXlsxUrl(avisosSource({ metadata: { resources } }).http)).toBe(expected);
  }
});

test("dataset sem 02 falha explicitamente", async () => {
  const { http } = avisosSource({ metadata: { resources: [{ title: "01-datasets-avisos-pt2030-30092026.xlsx", url: AVISOS_XLSX_URL }] } });
  await expect(resolveXlsxUrl(http)).rejects.toThrow("O dataset não tem o ficheiro 02-datasets-avisos-pt2030-*.xlsx");
});

test("valida a forma da API do dataset e identifica o campo inválido", async () => {
  for (const [metadata, field] of [[{ data: [] }, "resources"], [{ resources: [{ title: 7, url: "x" }] }, "title"],
    [{ resources: [{ title: "x", url: "" }] }, "url"], [null, "Resposta inesperada"]] as const) {
    await expect(resolveXlsxUrl(avisosSource({ metadata }).http)).rejects.toThrow(field);
  }
});

test("recusa XLSX fora da lista antes de contactar o anfitrião", async () => {
  const { http, calls } = avisosSource({ metadata: { resources: [resource("30092026", "https://static.example.net/x.xlsx")] } });
  const path = join(dir, "egress.sqlite");
  await expect(ingestAvisos(path, http)).rejects.toBeInstanceOf(EgressDeniedError);
  await expect(ingestAvisos(path, http)).rejects.toThrow("static.example.net");
  expect(calls).toEqual([AVISOS_DATASET_API, AVISOS_DATASET_API]);
  expect(existsSync(path)).toBe(false);
});

test("WP pagina 50 + 50 + 3 sem perder nem repetir avisos", async () => {
  const { http, calls } = avisosSource({ pages: [items(50), items(50, 50), items(3, 100)] });
  const rows = await fetchWpAvisos(http);
  expect(rows).toHaveLength(103);
  expect(new Set(rows.map((row) => row.code)).size).toBe(103);
  expect(calls).toEqual([pageUrl(1), pageUrl(2), pageUrl(3)]);
});

test("WP aceita 400 depois de 50 avisos como fim da paginação", async () => {
  const { http, calls } = avisosSource({ pages: [items(50), new Response(null, { status: 400 })] });
  expect(await fetchWpAvisos(http)).toHaveLength(50);
  expect(calls).toEqual([pageUrl(1), pageUrl(2)]);
});

test("WP propaga 400 na primeira página e outros erros em páginas seguintes", async () => {
  for (const pages of [[new Response(null, { status: 400 })], [items(50), new Response(null, { status: 503 })]]) {
    await expect(fetchWpAvisos(avisosSource({ pages }).http)).rejects.toBeInstanceOf(SourceUnavailableError);
  }
});

test("WP admite uma página vazia final e recusa exceder o limite sem pedir a página 41", async () => {
  expect(await fetchWpAvisos(avisosSource({ pages: [items(50), []] }).http)).toHaveLength(50);
  const { http, calls } = avisosSource({ pages: Array.from({ length: WP_MAX_PAGES }, () => items(WP_PAGE_SIZE)) });
  await expect(fetchWpAvisos(http)).rejects.toThrow(/Açores 2030.*40/);
  expect(calls).toHaveLength(40);
  expect(calls.at(-1)).toBe(pageUrl(40));
});

test("WP descodifica entidades e mapeia apenas os campos do aviso", async () => {
  const rows = await fetchWpAvisos(avisosSource({ pages: [[wpItem(7, { codigo: "  A-7  ", programa: ["AÇORES2030", "Programa dois"] })]] }).http);
  expect(rows).toEqual([{
    source: "acores2030_plano", code: "A-7", title: "Construir 2030 – Inovação & emprego & formação", status: null,
    program: "AÇORES2030; Programa dois", program_search: "acores2030|programadois", funds: ["FEDER"], objectives: ["Inovação"],
    amount_eur: 1500000, starts_on: "2026-09-01", ends_on: "2026-10-31", beneficiary: ["Privada"],
    snapshot_date: "2026-09-30", source_url: "https://acores.portugal2030.pt/aviso/7/",
  }]);
  expect(JSON.stringify(rows)).not.toContain("SECRET");
});

test("WP converte campos ACF vazios e montantes com espaços e vírgula", async () => {
  for (const empty of [false, "", null]) {
    const item = wpItem(1, { beneficiario: empty, programa: empty, objectivo: empty, fundo: empty,
      data_inicio: empty, data_fim: empty, df: empty });
    item.title.rendered = "<p>&nbsp;</p>";
    expect((await fetchWpAvisos(avisosSource({ pages: [[item]] }).http))[0]).toMatchObject({
      title: null, beneficiary: [], program: null, program_search: "", funds: [], objectives: [],
      starts_on: null, ends_on: null, amount_eur: null,
    });
  }
  for (const [df, amount] of [["1 500 000", 1500000], ["1 500,25", 1500.25], [0, 0], [-5, -5]] as const) {
    expect((await fetchWpAvisos(avisosSource({ pages: [[wpItem(1, { df })]] }).http))[0]?.amount_eur).toBe(amount);
  }
});

test("WP valida todos os campos e o erro indica a página e o caminho sem expor valores", async () => {
  const badItems: [unknown, string][] = [
    [wpItem(1, { codigo: " " }), "codigo"], [wpItem(1, { codigo: null }), "codigo"],
    [wpItem(1, { beneficiario: [3] }), "beneficiario"], [wpItem(1, { programa: true }), "programa"],
    [wpItem(1, { objectivo: {} }), "objectivo"], [wpItem(1, { fundo: "FEDER" }), "fundo"],
    [wpItem(1, { data_inicio: "2026-09-01T00:00:00" }), "data_inicio"],
    [wpItem(1, { data_fim: "amanhã" }), "data_fim"], [wpItem(1, { df: "Infinity" }), "df"],
    [wpItem(1, { df: "1,2,3" }), "df"], [wpItem(1, { df: true }), "df"],
    [{ ...wpItem(), id: "1" }, "id"], [{ ...wpItem(), link: "inválido" }, "link"],
    [{ ...wpItem(), modified: "ontem" }, "modified"], [{ ...wpItem(), title: { rendered: false } }, "rendered"],
    [{ ...wpItem(), acf: null }, "acf"],
  ];
  for (const [item, field] of badItems) {
    try {
      await fetchWpAvisos(avisosSource({ pages: [items(50), [item]] }).http);
      throw new Error("A validação devia ter falhado");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      expect(message).toContain("Resposta inesperada da API do Açores 2030 (página 2)");
      expect(message).toContain(field);
      expect(message).not.toContain("SECRET");
      expect(message).not.toContain("token=");
    }
  }
  await expect(fetchWpAvisos(avisosSource({ pages: [{ items: [] }] }).http)).rejects.toThrow("página 1");
});

for (const source of ["pt2030_xlsx", "acores2030_plano"] as const) {
  test(`fonte ${source} vazia deixa o índice intacto e não cria um índice novo`, async () => {
    const path = join(dir, `vazio-${source}.sqlite`);
    seededAvisosDb(path).close();
    const before = readFileSync(path);
    const options = source === "pt2030_xlsx" ? { xlsx: xlsxOf(XLSX_HEADERS, []) } : { pages: [[]] };
    await expect(ingestAvisos(path, avisosSource(options).http)).rejects.toBeInstanceOf(EmptySourceError);
    expect(readFileSync(path)).toEqual(before);
    const db = openAvisosReadOnlyDb(path);
    try {
      expect(countAvisos(db)).toBe(9);
      expect(getAvisosMeta(db, "last_ingest")).toBe(AVISOS_NOW.toISOString());
    } finally { db.close(); }
    const missing = join(dir, `novo-${source}.sqlite`);
    await expect(ingestAvisos(missing, avisosSource(options).http)).rejects.toThrow(source);
    expect(existsSync(missing)).toBe(false);
  });
}

test("recusa versões diferentes sem escrever, mesmo num ficheiro sem tabelas", () => {
  for (const tables of [false, true]) {
    const path = join(dir, `versao-${tables}.sqlite`);
    const db = new Database(path);
    if (tables) db.exec("CREATE TABLE antigo (id INTEGER)");
    db.exec("PRAGMA user_version = 99");
    db.close();
    const before = readFileSync(path);
    for (const open of [openAvisosWritableDb, openAvisosReadOnlyDb]) {
      expect(() => open(path)).toThrow(AvisosDbUnavailableError);
      expect(() => open(path)).toThrow(/esquema 99.*servidor usa o 1.*bun run ingest:avisos/);
      expect(readFileSync(path)).toEqual(before);
    }
  }
});

test("leitura de índice inexistente não cria o ficheiro", () => {
  const path = join(dir, "inexistente", "avisos.sqlite");
  expect(() => openAvisosReadOnlyDb(path)).toThrow(AvisosDbUnavailableError);
  expect(() => openAvisosReadOnlyDb(path)).toThrow("bun run ingest:avisos");
  expect(existsSync(path)).toBe(false);
});

async function replacement(): Promise<Record<AvisoSource, AvisoRow[]>> {
  return {
    pt2030_xlsx: parseAvisosXlsx(avisosXlsx(), AVISOS_XLSX_URL),
    acores2030_plano: await fetchWpAvisos(avisosSource().http),
  };
}

test("substituição elimina dados e FTS anteriores numa transação, sem acumular montantes", async () => {
  const db = seededAvisosDb();
  try {
    const rows = await replacement();
    replaceAvisos(db, rows, { xlsx_url: "https://dados.gov.pt/novo.xlsx" }, AVISOS_NOW);
    replaceAvisos(db, rows, {}, AVISOS_NOW);
    expect(countAvisos(db)).toBe(6);
    expect(db.query("SELECT count(*) AS n FROM avisos_fts").get()).toEqual({ n: 6 });
    expect(db.query("SELECT sum(amount_eur) AS n FROM avisos WHERE code = 'MPr-2023-1'").get()).toEqual({ n: 17000 });
    expect(getAvisosMeta(db, "xlsx_url")).toBe("https://dados.gov.pt/novo.xlsx");
  } finally { db.close(); }
});

test("replaceAvisos recusa qualquer fonte vazia antes de tocar na base de dados", async () => {
  const db = seededAvisosDb();
  const rows = await replacement();
  db.close();
  for (const source of ["pt2030_xlsx", "acores2030_plano"] as const) {
    expect(() => replaceAvisos(db, { ...rows, [source]: [] }, {})).toThrow(EmptySourceError);
  }
});

test("falha SQL durante a substituição repõe dados, metadados e FTS", async () => {
  const db = seededAvisosDb();
  try {
    const before = db.query("SELECT * FROM avisos ORDER BY rid").all();
    const fts = db.query("SELECT rowid, * FROM avisos_fts ORDER BY rowid").all();
    db.exec("CREATE TRIGGER recusa BEFORE INSERT ON avisos WHEN NEW.source = 'acores2030_plano' BEGIN SELECT RAISE(ABORT, 'Aviso recusado'); END");
    const rows = await replacement();
    expect(() => replaceAvisos(db, rows, {}, new Date("2027-01-01"))).toThrow("Aviso recusado");
    expect(db.query("SELECT * FROM avisos ORDER BY rid").all()).toEqual(before);
    expect(db.query("SELECT rowid, * FROM avisos_fts ORDER BY rowid").all()).toEqual(fts);
    expect(getAvisosMeta(db, "last_ingest")).toBe(AVISOS_NOW.toISOString());
  } finally { db.close(); }
});

test("a verificação FTS deteta linhas sem par e reverte a transação", async () => {
  const db = seededAvisosDb();
  try {
    const rows = await replacement();
    const before = db.query("SELECT * FROM avisos ORDER BY rid").all();
    db.exec("CREATE TRIGGER orfao AFTER INSERT ON avisos BEGIN INSERT INTO avisos_fts(rowid, title) VALUES (NEW.rid + 1000, 'órfão'); END");
    expect(() => replaceAvisos(db, rows, {})).toThrow(/FTS.*sem par/);
    expect(db.query("SELECT * FROM avisos ORDER BY rid").all()).toEqual(before);
    expect(db.query("SELECT count(*) AS n FROM avisos_fts").get()).toEqual({ n: 9 });
  } finally { db.close(); }
});
