import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { DEFAULT_DB_PATH, openReadOnlyDb } from "../src/contracts/db";
import { searchContracts } from "../src/contracts/search";

// Corre só depois de `bun run ingest` (ou com JORAA_MCP_DB a apontar para um índice), e só lê.
// Sem ficheiro, os testes são ignorados. Um ficheiro que existe mas não abre (por exemplo,
// de outro esquema) faz falhar o teste: é um índice que o servidor também recusaria.
const present = existsSync(DEFAULT_DB_PATH);
if (!present) console.error(`Testes com dados reais ignorados: não há índice em ${DEFAULT_DB_PATH}.`);

let db: Database | undefined;
const open = () => (db ??= openReadOnlyDb(DEFAULT_DB_PATH));

test.skipIf(!present)("o índice existente abre com o esquema atual", () => {
  expect(() => open()).not.toThrow();
});

test.skipIf(!present)("amostra real: 20/20 contratos são dos Açores", () => {
  const sample = open().prepare(`SELECT location, nuts FROM contracts ORDER BY random() LIMIT 20`).all() as { location: string | null; nuts: string | null }[];
  expect(sample.length).toBe(20);
  for (const c of sample) {
    const ok = /açores/i.test(c.location ?? "") || (c.nuts ?? "").split("; ").some((n) => n.startsWith("PT2"));
    expect(ok).toBe(true);
  }
  expect(searchContracts(open(), { entity: "Electricidade dos Açores" }).length).toBeGreaterThan(0);
  open().close();
  db = undefined;
});
