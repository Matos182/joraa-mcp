import { beforeAll, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { isAzores, toContract } from "../src/contracts/base";
import { openDb, upsertContracts } from "../src/contracts/db";
import { searchContracts } from "../src/contracts/search";
import { rows } from "./fixtures";

let db: Database;
beforeAll(() => {
  db = openDb(":memory:");
  upsertContracts(db, rows.filter(isAzores).map(toContract));
});

test("só ficam contratos açorianos no índice", () => {
  expect(searchContracts(db, {}).map((c) => c.id)).toEqual(["1001", "1002"]);
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

test("resultado completo, com valor numérico e link da fonte", () => {
  const [c] = searchContracts(db, { entity: "EDA" });
  expect(c).toMatchObject({
    entity: "EDA - Electricidade dos Açores, S.A.", contractors: ["500000000 - Empresa Exemplo, Lda"],
    object: "Manutenção da rede elétrica de São Miguel", value_eur: 125000.5, signed_on: "2026-03-10",
    source_url: "https://www.base.gov.pt/Base4/pt/detalhe/?type=contratos&id=1001",
  });
  expect(typeof c!.value_eur).toBe("number");
});

test("não se pesquisam pessoas singulares pelos adjudicatários", () => {
  expect(searchContracts(db, { query: "João Silva" })).toEqual([]);
  expect(searchContracts(db, { entity: "João Silva" })).toEqual([]);
});
