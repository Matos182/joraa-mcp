import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Contract } from "./base";

export const DEFAULT_DB_PATH =
  process.env.JORAA_MCP_DB ?? join(import.meta.dir, "..", "..", "data", "contracts.sqlite");

export function openDb(path = DEFAULT_DB_PATH): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS contracts (
      id TEXT PRIMARY KEY,
      entity TEXT, entity_nif TEXT, contractors TEXT NOT NULL,
      object TEXT, description TEXT, contract_type TEXT, procedure TEXT,
      value_eur REAL, signed_on TEXT, published_on TEXT,
      location TEXT, nuts TEXT, cpv TEXT, source_url TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS contracts_entity_nif ON contracts(entity_nif);
    CREATE INDEX IF NOT EXISTS contracts_signed_on ON contracts(signed_on);
    -- Texto pesquisável: só a entidade adjudicante e o objeto. Os adjudicatários
    -- ficam de fora para não se pesquisar pessoas singulares.
    CREATE VIRTUAL TABLE IF NOT EXISTS contracts_fts USING fts5(
      id UNINDEXED, entity, object, description, tokenize = 'unicode61 remove_diacritics 2'
    );
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
  `);
  return db;
}

export function upsertContracts(db: Database, rows: Contract[]) {
  const ins = db.prepare(`INSERT OR REPLACE INTO contracts VALUES
    ($id,$entity,$entity_nif,$contractors,$object,$description,$contract_type,$procedure,
     $value_eur,$signed_on,$published_on,$location,$nuts,$cpv,$source_url)`);
  const delFts = db.prepare(`DELETE FROM contracts_fts WHERE id = ?`);
  const insFts = db.prepare(`INSERT INTO contracts_fts (id, entity, object, description) VALUES (?,?,?,?)`);
  db.transaction(() => {
    for (const c of rows) {
      ins.run({
        $id: c.id, $entity: c.entity, $entity_nif: c.entity_nif,
        $contractors: JSON.stringify(c.contractors), $object: c.object,
        $description: c.description, $contract_type: c.contract_type,
        $procedure: c.procedure, $value_eur: c.value_eur, $signed_on: c.signed_on,
        $published_on: c.published_on, $location: c.location, $nuts: c.nuts,
        $cpv: c.cpv, $source_url: c.source_url,
      });
      delFts.run(c.id);
      insFts.run(c.id, c.entity, c.object, c.description);
    }
  })();
}

export function setMeta(db: Database, key: string, value: string) {
  db.prepare(`INSERT OR REPLACE INTO meta VALUES (?, ?)`).run(key, value);
}

export function getMeta(db: Database, key: string): string | null {
  return (db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as { value: string } | null)?.value ?? null;
}

export function countContracts(db: Database): number {
  return (db.prepare(`SELECT count(*) AS n FROM contracts`).get() as { n: number }).n;
}
