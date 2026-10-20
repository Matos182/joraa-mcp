import { beforeAll, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { isAzores, toContract, type BaseRow } from "../src/contracts/base";
import { openWritableDb, replaceYear } from "../src/contracts/db";
import { buildSearchSql, ftsQuery, searchContracts } from "../src/contracts/search";
import { rows, seededDb } from "./fixtures";

let db: Database;
beforeAll(() => {
  db = seededDb();
});

test("só ficam contratos açorianos no índice", () => {
  expect(searchContracts(db, {}).map((c) => c.id)).toEqual(["1001", "1002"]);
});

test("entidade por variante de grafia (Câmara Municipal vs Município, o mesmo NIF em anos diferentes)", () => {
  // Base isolada deste teste: a fonte indexou "Município de Angra do Heroísmo"
  // este ano; noutros anos a mesma entidade (mesmo NIF) aparece como "Câmara
  // Municipal de Angra do Heroísmo". As duas formas têm de encontrar o contrato,
  // apesar de nenhuma das palavras "Câmara"/"Municipal" aparecer no texto indexado.
  const extraRow: BaseRow = {
    idcontrato: "1003", objectoContrato: "Licenciamento e suporte a software de gestão documental",
    adjudicante: ["512044040 - Município de Angra do Heroísmo"], adjudicatarios: [],
    precoContratual: 39556, dataCelebracaoContrato: "13/04/2026",
    localExecucao: ["Portugal, Região Autónoma dos Açores, Angra do Heroísmo"], NUTs: ["PT200"],
  };
  const entityDb = openWritableDb(":memory:");
  replaceYear(entityDb, 2026, [...rows, extraRow].filter(isAzores).map(toContract));

  expect(searchContracts(entityDb, { entity: "Câmara Municipal de Angra do Heroísmo" }).map((c) => c.id)).toEqual(["1003"]);
  expect(searchContracts(entityDb, { entity: "Município de Angra do Heroísmo" }).map((c) => c.id)).toEqual(["1003"]);
  // Só com palavras genéricas (sem nenhuma distintiva) não se esvazia o filtro.
  expect(searchContracts(entityDb, { entity: "Câmara Municipal" })).toEqual([]);
});

test("entidade por nome (sem acentos) e por NIF", () => {
  expect(searchContracts(db, { entity: "eda" }).map((c) => c.id)).toEqual(["1001"]);
  expect(searchContracts(db, { entity: "obras publicas" }).map((c) => c.id)).toEqual(["1002"]);
  expect(searchContracts(db, { entity: "512000040" }).map((c) => c.id)).toEqual(["1001"]);
});

test("palavras no objeto, datas e sintaxe FTS inofensiva", () => {
  expect(searchContracts(db, { query: "estradas Terceira" }).map((c) => c.id)).toEqual(["1002"]);
  expect(searchContracts(db, { from: "2026-03-01" }).map((c) => c.id)).toEqual(["1001"]);
  expect(searchContracts(db, { to: "2026-01-31" }).map((c) => c.id)).toEqual(["1002"]);
  expect(searchContracts(db, { query: 'rede" (*' }).map((c) => c.id)).toEqual(["1001"]);
  expect(searchContracts(db, { query: 'rede OR NEAR' })).toEqual([]);
});

test("resultado completo, com valor numérico e link da fonte, sem colunas internas", () => {
  const [c] = searchContracts(db, { entity: "EDA" });
  expect(c).toMatchObject({
    entity: "EDA - Electricidade dos Açores, S.A.", contractors: ["500000000 - Empresa Exemplo, Lda"],
    object: "Manutenção da rede elétrica de São Miguel", value_eur: 125000.5, signed_on: "2026-03-10",
    source_url: "https://www.base.gov.pt/Base4/pt/detalhe/?type=contratos&id=1001",
  });
  expect(typeof c!.value_eur).toBe("number");
  expect(Object.keys(c!)).not.toContain("rid");
  expect(Object.keys(c!)).not.toContain("source_year");
});

test("não se pesquisam pessoas singulares pelos adjudicatários", () => {
  expect(searchContracts(db, { query: "João Silva" })).toEqual([]);
  expect(searchContracts(db, { entity: "João Silva" })).toEqual([]);
});

test("ftsQuery guarda no máximo 8 termos de 2 ou mais caracteres", () => {
  expect(ftsQuery("a b c")).toBeNull();
  expect(ftsQuery("a ed b ã")).toBe(`"ed"*`);
  expect(ftsQuery("ão")).toBe(`"ão"*`);
  const many = Array.from({ length: 50 }, (_, i) => `t${i}`).join(" ");
  expect(ftsQuery(many)).toBe(Array.from({ length: 8 }, (_, i) => `"t${i}"*`).join(" "));
});

test("um filtro de texto sem termos utilizáveis não encontra nada (nunca alarga a pesquisa)", () => {
  expect(searchContracts(db, { entity: "a" })).toEqual([]);
  expect(searchContracts(db, { query: "* ( )" })).toEqual([]);
  expect(searchContracts(db, { entity: "   " }).length).toBe(2);
});

test("a tabela FTS tem índices de prefixo 2 e 3", () => {
  const { sql } = db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'contracts_fts'`).get() as { sql: string };
  expect(sql).toContain("prefix = '2 3'");
  expect(sql).not.toContain("UNINDEXED");
});

test("o plano de consulta liga o FTS ao contrato pelo rowid, sem varrer colunas", () => {
  const { sql, params } = buildSearchSql({ entity: "eda", query: "rede" });
  const plan = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(params) as { detail: string }[]).map((r) => r.detail);
  // O FTS5 aparece sempre como "SCAN ... VIRTUAL TABLE INDEX"; o que conta é ter a restrição MATCH (índice 0:M...).
  const fts = plan.filter((d) => d.includes("contracts_fts"));
  expect(fts.length).toBe(2);
  for (const d of fts) expect(d).toMatch(/VIRTUAL TABLE INDEX 0:M/);
  // A tabela de contratos nunca é percorrida por uma coluna sem índice.
  expect(plan.some((d) => /^SCAN c\b/.test(d) && !/USING/.test(d))).toBe(false);
  expect(plan.some((d) => /SEARCH c USING INTEGER PRIMARY KEY \(rowid=\?\)/.test(d))).toBe(true);
});
