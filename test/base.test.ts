import { expect, test } from "bun:test";
import { euros, isAzores, isoDate, toContract } from "../src/contracts/base";
import { rows } from "./fixtures";

test("região: localExecucao com Açores ou NUTs PT2, e nada mais", () => {
  expect(rows.map(isAzores)).toEqual([true, true, false]);
  expect(isAzores({ localExecucao: ["Portugal"], NUTs: ["PT200"] })).toBe(true);
  expect(isAzores({ localExecucao: ["Portugal, Lisboa"], NUTs: ["PT170"] })).toBe(false);
  expect(isAzores({ localExecucao: null, NUTs: null })).toBe(false);
});

test("datas passam a ISO e valores a número em euros", () => {
  expect(isoDate("23/02/2026")).toBe("2026-02-23");
  expect(isoDate("")).toBeNull();
  expect(euros(125000.5)).toBe(125000.5);
  expect(euros("9 500,25")).toBe(9500.25);
  expect(euros(null)).toBeNull();
  expect(euros("n/d")).toBeNull();
});

test("toContract não inventa campos: o que falta vem a null", () => {
  const c = toContract(rows[1]!);
  expect(c.entity).toBe("Secretaria Regional das Obras Públicas");
  expect(c.entity_nif).toBe("600000001");
  expect(typeof c.value_eur).toBe("number");
  expect(c.description).toBeNull();
  expect(c.nuts).toBeNull();
  expect(c.published_on).toBeNull();
  expect(c.source_url).toBe("https://www.base.gov.pt/Base4/pt/detalhe/?type=contratos&id=1002");
});
