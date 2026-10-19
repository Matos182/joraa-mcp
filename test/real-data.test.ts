import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { DEFAULT_DB_PATH, openDb } from "../src/contracts/db";
import { searchContracts } from "../src/contracts/search";

// Corre só depois de `bun run ingest`. Verifica o filtro de região nos dados reais.
test.skipIf(!existsSync(DEFAULT_DB_PATH))("amostra real: 20/20 contratos são dos Açores", () => {
  const db = openDb(DEFAULT_DB_PATH);
  const sample = db.prepare(`SELECT id FROM contracts ORDER BY random() LIMIT 20`).all() as { id: string }[];
  expect(sample.length).toBe(20);
  for (const { id } of sample) {
    const c = db.prepare(`SELECT location, nuts FROM contracts WHERE id = ?`).get(id) as { location: string | null; nuts: string | null };
    const ok = /açores/i.test(c.location ?? "") || (c.nuts ?? "").split("; ").some((n) => n.startsWith("PT2"));
    expect(ok).toBe(true);
  }
  expect(searchContracts(db, { entity: "Electricidade dos Açores" }).length).toBeGreaterThan(0);
  db.close();
});
