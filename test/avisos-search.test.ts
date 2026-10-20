import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { replaceAvisos } from "../src/avisos/db";
import { searchAvisos } from "../src/avisos/search";
import { normalizeKey } from "../src/avisos/text";
import type { AvisoRow } from "../src/avisos/types";
import { seededAvisosDb } from "./avisos-fixtures";

let db: Database;
beforeEach(() => { db = seededAvisosDb(); });
afterEach(() => db.close());

function row(overrides: Partial<AvisoRow> = {}): AvisoRow {
  return {
    source: "acores2030_plano", code: "PLANO", title: "Inovação", status: null,
    program: "AÇORES2030", program_search: normalizeKey("AÇORES2030"),
    funds: [], objectives: [], amount_eur: null, starts_on: null, ends_on: null,
    beneficiary: [], snapshot_date: null, source_url: "https://acores.portugal2030.pt/aviso/1/",
    ...overrides,
  };
}

test("sem filtros devolve oito grupos e soma apenas dentro de cada programa", () => {
  const results = searchAvisos(db, {});
  expect(results).toHaveLength(8);
  expect(results.filter((r) => r.code === "MPr-2023-1").map((r) => [r.program, r.amount_eur]))
    .toEqual([["ACORES2030", 2000], ["COMPETE2030", 15000]]);
});

test("um objetivo de uma só linha seleciona o grupo completo", () => {
  const results = searchAvisos(db, { query: "Investigação" });
  expect(results).toHaveLength(1);
  expect(results[0]).toMatchObject({
    code: "MPr-2023-1", program: "COMPETE2030", amount_eur: 15000,
    funds: ["FEDER", "FSE+"], objectives: ["Investigação", "Qualificação"],
  });
});

test("várias linhas que correspondem à pesquisa não multiplicam o montante", () => {
  const results = searchAvisos(db, { query: "inovação formação", program: "COMPETE" });
  expect(results).toHaveLength(1);
  expect(results[0]?.amount_eur).toBe(15000);
});

test("combina texto, programa e estado", () => {
  const results = searchAvisos(db, { query: "pequenos negócios", program: "ACORES2030", status: "Aberto" });
  expect(results).toHaveLength(1);
  expect(results[0]).toMatchObject({ code: "ACORES2030-2026-15", title: "Construir 2030 - Pequenos Negócios" });
});

test("programa ignora acentos e maiúsculas e aceita partes do nome", () => {
  for (const program of ["ACORES2030", "AÇORES2030", "Açores 2030", "acores"]) {
    const results = searchAvisos(db, { program });
    expect(results).toHaveLength(7);
    expect(results.filter((r) => r.source === "acores2030_plano")).toHaveLength(4);
  }
  expect(searchAvisos(db, { program: "COMPETE" }).map((r) => r.program)).toEqual(["COMPETE2030"]);
});

test("programa sem chave normalizada nunca alarga a pesquisa", () => {
  for (const program of ["--", "", "   ", "%_"]) expect(searchAvisos(db, { program })).toEqual([]);
});

test("estado Fechado exclui avisos abertos e o plano sem estado", () => {
  expect(searchAvisos(db, { status: "Fechado" }).map((r) => r.code)).toEqual(["ACORES2030-2025-1"]);
});

test("beneficiário privada inclui categorias mistas mas exclui pública e XLSX", () => {
  const results = searchAvisos(db, { beneficiary: "privada" });
  expect(results.map((r) => r.code)).toEqual(["ACORES2030-PLANO-1", "ACORES2030-PLANO-3", "ACORES2030-PLANO-4"]);
  expect(results.map((r) => r.beneficiary)).toEqual([["Privada"], ["Pública/Privada"], ["Pública", "Privada"]]);
});

test("beneficiário PÚBLICA inclui as três variantes públicas", () => {
  expect(searchAvisos(db, { beneficiary: "PÚBLICA" }).map((r) => r.code))
    .toEqual(["ACORES2030-PLANO-2", "ACORES2030-PLANO-3", "ACORES2030-PLANO-4"]);
});

test("beneficiário inválido nunca alarga a pesquisa", () => {
  for (const beneficiary of ["empresa", "", "--", "Pública/Privada", "%_"]) {
    expect(searchAvisos(db, { beneficiary })).toEqual([]);
  }
});

test("janela inclui o interior e ambas as fronteiras e exclui datas nulas", () => {
  for (const open_on of ["2026-09-01", "2026-09-30", "2026-10-31"]) {
    expect(searchAvisos(db, { open_on }).map((r) => r.code))
      .toEqual(["ACORES2030-PLANO-1", "ACORES2030-PLANO-2", "ACORES2030-PLANO-3"]);
  }
  for (const open_on of ["2026-08-31", "2026-11-01"]) expect(searchAvisos(db, { open_on })).toEqual([]);
  expect(searchAvisos(db, { open_on: "2026-09-30", beneficiary: "privada" }).map((r) => r.code))
    .toEqual(["ACORES2030-PLANO-1", "ACORES2030-PLANO-3"]);
  db.exec("UPDATE avisos SET starts_on = NULL WHERE code = 'ACORES2030-PLANO-1'; UPDATE avisos SET ends_on = NULL WHERE code = 'ACORES2030-PLANO-2'");
  expect(searchAvisos(db, { open_on: "2026-09-30" }).map((r) => r.code)).toEqual(["ACORES2030-PLANO-3"]);
});

test("campos ausentes mantêm null conforme a fonte e o resultado tem só as chaves públicas", () => {
  const keys = ["source", "code", "title", "status", "program", "funds", "objectives", "amount_eur",
    "starts_on", "ends_on", "beneficiary", "snapshot_date", "source_url"].sort();
  for (const result of searchAvisos(db, {})) {
    expect(Object.keys(result).sort()).toEqual(keys);
    if (result.source === "pt2030_xlsx") {
      expect(result).toMatchObject({ starts_on: null, ends_on: null, beneficiary: null });
      expect(result.status === "Aberto" || result.status === "Fechado").toBe(true);
    } else {
      expect(result.status).toBeNull();
    }
  }
});

test("ordena abertos primeiro e desempata por fim da janela, código e fonte", () => {
  expect(searchAvisos(db, {}).map((r) => `${r.code}/${r.program}`)).toEqual([
    "ACORES2030-2026-15/ACORES2030", "MPr-2023-1/ACORES2030", "MPr-2023-1/COMPETE2030",
    "ACORES2030-2025-1/ACORES2030", "ACORES2030-PLANO-1/AÇORES2030", "ACORES2030-PLANO-2/AÇORES2030",
    "ACORES2030-PLANO-3/AÇORES2030", "ACORES2030-PLANO-4/AÇORES2030",
  ]);
  replaceAvisos(db, {
    pt2030_xlsx: [row({ source: "pt2030_xlsx", code: "A", beneficiary: null })],
    acores2030_plano: [row({ code: "A" }), row({ code: "Z", ends_on: "2026-10-31" }),
      row({ code: "Y", ends_on: "2026-09-30" })],
  }, {});
  expect(searchAvisos(db, {}).map((r) => [r.code, r.source])).toEqual([
    ["Y", "acores2030_plano"], ["Z", "acores2030_plano"], ["A", "acores2030_plano"], ["A", "pt2030_xlsx"],
  ]);
});

test("limite aplica-se aos grupos, usa 20 por omissão e fica entre 1 e 100", () => {
  replaceAvisos(db, {
    pt2030_xlsx: [row({ source: "pt2030_xlsx", beneficiary: null })],
    acores2030_plano: Array.from({ length: 105 }, (_, i) => row({ code: `PLANO-${i}` })),
  }, {});
  expect(searchAvisos(db, {})).toHaveLength(20);
  for (const limit of [-5, 0, 1]) expect(searchAvisos(db, { limit })).toHaveLength(1);
  expect(searchAvisos(db, { limit: 30 })).toHaveLength(30);
  for (const limit of [100, 999]) expect(searchAvisos(db, { limit })).toHaveLength(100);
});

test("texto sem termos utilizáveis ou sem correspondência nunca alarga a pesquisa", () => {
  for (const query of ["a .", "--", "   ", "inexistente", "token=SECRET"]) {
    expect(searchAvisos(db, { query })).toEqual([]);
  }
  expect(searchAvisos(db, { query: "" })).toEqual(searchAvisos(db, {}));
});

test("FTS pesquisa fundos e programas e trata sintaxe e SQL como texto", () => {
  expect(searchAvisos(db, { query: "FSE" }).map((r) => r.amount_eur)).toEqual([15000, 8000]);
  expect(searchAvisos(db, { query: "COMPETE" }).map((r) => r.amount_eur)).toEqual([15000]);
  for (const query of ['" OR *', "' OR 1=1 --", "title:NEAR(inovação)"]) expect(searchAvisos(db, { query })).toEqual([]);
  expect(searchAvisos(db, { program: "%' OR 1=1 --" })).toEqual([]);
  expect(searchAvisos(db, { open_on: "2026-09-30' OR 1=1 --" })).toHaveLength(3);
});

test("grupos com programa nulo preservam nulls, somam a cêntimos e unem arrays pela ordem inicial", () => {
  const base = { program: null, program_search: "" };
  replaceAvisos(db, {
    pt2030_xlsx: [row({ ...base, source: "pt2030_xlsx", amount_eur: 7, beneficiary: null })],
    acores2030_plano: [
      row({ ...base, funds: ["FSE+", "FEDER", "FSE+"], objectives: ["Investigação", "Inovação"],
        beneficiary: null, amount_eur: 0.104, starts_on: "2026-09-15", ends_on: "2026-10-01", snapshot_date: "2026-09-01" }),
      row({ ...base, funds: ["FEDER", "FC"], objectives: ["Inovação", "Qualificação"],
        beneficiary: ["Privada", "Privada"], amount_eur: 0.104, starts_on: "2026-09-01", ends_on: "2026-10-31", snapshot_date: "2026-09-30" }),
      row({ ...base, beneficiary: ["Pública", "Privada"] }),
      row({ code: "VAZIO", title: null }),
    ],
  }, {});
  const results = searchAvisos(db, { query: "Investigação" });
  expect(results).toHaveLength(1);
  expect(results[0]).toMatchObject({
    program: null, amount_eur: 0.21, funds: ["FSE+", "FEDER", "FC"],
    objectives: ["Investigação", "Inovação", "Qualificação"], beneficiary: ["Privada", "Pública"],
    starts_on: "2026-09-01", ends_on: "2026-10-31", snapshot_date: "2026-09-30",
  });
  expect(searchAvisos(db, { beneficiary: "privada" })[0]?.amount_eur).toBe(0.21);
  expect(searchAvisos(db, {}).find((r) => r.code === "VAZIO")).toMatchObject({
    title: null, amount_eur: null, funds: [], objectives: [], beneficiary: [], snapshot_date: null,
  });
  expect(searchAvisos(db, {}).find((r) => r.source === "pt2030_xlsx")?.amount_eur).toBe(7);
});

test("arrays inválidos no índice dão erro com o campo sem divulgar o conteúdo", () => {
  for (const field of ["funds", "objectives", "beneficiary"]) {
    for (const value of ["token=SECRET", '{"token":"SECRET"}', "[1]", '"SECRET"', "null"]) {
      db.prepare(`UPDATE avisos SET ${field} = $value`).run({ $value: value });
      try {
        searchAvisos(db, {});
        throw new Error("A validação devia ter falhado");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        const message = (error as Error).message;
        expect(message).toContain("índice de avisos");
        expect(message).toContain(field);
        expect(message).not.toContain("SECRET");
      }
    }
    db.prepare(`UPDATE avisos SET ${field} = '[]'`).run();
  }
});

test("valida também os campos escalares devolvidos pelo índice", () => {
  db.exec("UPDATE avisos SET source = 'inválida'");
  expect(() => searchAvisos(db, {})).toThrow(/índice de avisos.*source/s);
});

test("falhas SQL propagam contexto e um índice vazio devolve uma lista vazia", () => {
  db.exec("DELETE FROM avisos_fts; DELETE FROM avisos");
  expect(searchAvisos(db, {})).toEqual([]);
  db.exec("DROP TABLE avisos_fts");
  expect(() => searchAvisos(db, { query: "inovação" })).toThrow(/pesquisar.*avisos_fts/);
});
