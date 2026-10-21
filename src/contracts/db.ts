import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Contract } from "./base";

export const DEFAULT_DB_PATH =
  process.env.JORAA_MCP_DB ?? join(import.meta.dir, "..", "..", "data", "contracts.sqlite");

// Sobe quando o esquema muda. Um índice de outra versão não é aberto: reimporta-se.
export const SCHEMA_VERSION = 2;

export class DbUnavailableError extends Error {}

// O serviço só lê. O ficheiro tem de existir: nunca é criado aqui.
export function openReadOnlyDb(path = DEFAULT_DB_PATH): Database {
  if (!existsSync(path)) {
    throw new DbUnavailableError(`O índice de contratos não existe em ${path}. Corre \`bun run ingest\` para o criar.`);
  }
  const db = new Database(path, { readonly: true });
  try {
    db.exec(`PRAGMA query_only = ON`);
    assertSchema(db, path);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

function assertSchema(db: Database, path: string) {
  const { user_version } = db.prepare(`PRAGMA user_version`).get() as { user_version: number };
  if (user_version !== SCHEMA_VERSION) {
    throw new DbUnavailableError(
      `O índice em ${path} tem o esquema ${user_version} e este servidor usa o ${SCHEMA_VERSION}. ` +
      `Apaga o ficheiro e corre \`bun run ingest\` para o recriar.`,
    );
  }
}

// Só o ingest escreve. Journal DELETE: o ficheiro fica completo em si mesmo e pode ser
// lido por um serviço com o volume montado só de leitura (WAL precisaria de -shm gravável).
export function openWritableDb(path = DEFAULT_DB_PATH): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  try {
    // A versão é verificada antes de qualquer PRAGMA que escreva: um ficheiro recusado fica intacto.
    const { user_version } = db.prepare(`PRAGMA user_version`).get() as { user_version: number };
    const hasTables = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' LIMIT 1`).get() !== null;
    if (hasTables && user_version !== SCHEMA_VERSION) assertSchema(db, path);
    db.exec(`PRAGMA journal_mode = DELETE`);
    db.exec(`
      CREATE TABLE IF NOT EXISTS contracts (
        rid INTEGER PRIMARY KEY,
        id TEXT NOT NULL UNIQUE,
        source_year INTEGER NOT NULL,
        entity TEXT, entity_nif TEXT, contractors TEXT NOT NULL,
        object TEXT, description TEXT, contract_type TEXT, procedure TEXT,
        value_eur REAL, signed_on TEXT, published_on TEXT,
        location TEXT, nuts TEXT, cpv TEXT, source_url TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS contracts_entity_nif ON contracts(entity_nif);
      CREATE INDEX IF NOT EXISTS contracts_signed_on ON contracts(signed_on);
      CREATE INDEX IF NOT EXISTS contracts_source_year ON contracts(source_year);
      -- Texto pesquisável: só a entidade adjudicante e o objeto. Os adjudicatários
      -- ficam de fora para não se pesquisar pessoas singulares.
      -- O rowid de cada linha FTS é o rid do contrato; os índices de prefixo de 2 e 3
      -- caracteres evitam percorrer o vocabulário inteiro em termos curtos com *.
      CREATE VIRTUAL TABLE IF NOT EXISTS contracts_fts USING fts5(
        entity, object, description, tokenize = 'unicode61 remove_diacritics 2', prefix = '2 3'
      );
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
      PRAGMA user_version = ${SCHEMA_VERSION};
    `);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

export class EmptyImportError extends Error {}

// Substitui todos os contratos de um ano numa só transação: o que desapareceu da
// fonte desaparece do índice e, se algo falhar, fica tudo como estava.
// Um id que aparece em vários anos fica no ano mais alto, seja qual for a ordem de importação;
// dentro do mesmo ficheiro ganha a última ocorrência. Antes do COMMIT corre checkIndex.
export function replaceYear(db: Database, year: number, rows: Contract[], now = new Date()) {
  if (!Number.isInteger(year)) throw new Error(`Ano inválido: ${year}`);
  if (rows.length === 0) {
    throw new EmptyImportError(`A importação de ${year} não tem contratos; o índice fica como estava.`);
  }
  const delFtsYear = db.prepare(`DELETE FROM contracts_fts WHERE rowid IN (SELECT rid FROM contracts WHERE source_year = ?)`);
  const delYear = db.prepare(`DELETE FROM contracts WHERE source_year = ?`);
  const upsert = db.prepare(`INSERT INTO contracts
    (id, source_year, entity, entity_nif, contractors, object, description, contract_type, procedure,
     value_eur, signed_on, published_on, location, nuts, cpv, source_url)
    VALUES ($id,$year,$entity,$entity_nif,$contractors,$object,$description,$contract_type,$procedure,
     $value_eur,$signed_on,$published_on,$location,$nuts,$cpv,$source_url)
    ON CONFLICT(id) DO UPDATE SET source_year = excluded.source_year, entity = excluded.entity,
      entity_nif = excluded.entity_nif, contractors = excluded.contractors, object = excluded.object,
      description = excluded.description, contract_type = excluded.contract_type,
      procedure = excluded.procedure, value_eur = excluded.value_eur, signed_on = excluded.signed_on,
      published_on = excluded.published_on, location = excluded.location, nuts = excluded.nuts,
      cpv = excluded.cpv, source_url = excluded.source_url
    WHERE excluded.source_year >= contracts.source_year
    RETURNING rid`);
  const delFts = db.prepare(`DELETE FROM contracts_fts WHERE rowid = ?`);
  const insFts = db.prepare(`INSERT INTO contracts_fts (rowid, entity, object, description) VALUES (?,?,?,?)`);
  const stamp = now.toISOString();
  db.transaction(() => {
    delFtsYear.run(year);
    delYear.run(year);
    for (const c of rows) {
      const hit = upsert.get({
        $id: c.id, $year: year, $entity: c.entity, $entity_nif: c.entity_nif,
        $contractors: JSON.stringify(c.contractors), $object: c.object,
        $description: c.description, $contract_type: c.contract_type,
        $procedure: c.procedure, $value_eur: c.value_eur, $signed_on: c.signed_on,
        $published_on: c.published_on, $location: c.location, $nuts: c.nuts,
        $cpv: c.cpv, $source_url: c.source_url,
      }) as { rid: number } | null;
      // Sem linha: o contrato pertence a um ano mais alto e fica como está, com o seu FTS.
      if (!hit) continue;
      // Sem efeito se o rid é novo; necessário se o contrato veio de outro ano ou se repete no ficheiro.
      delFts.run(hit.rid);
      insFts.run(hit.rid, c.entity, c.object, c.description);
    }
    setMeta(db, `ingested_${year}`, stamp);
    setMeta(db, "last_ingest", stamp);
    checkIndex(db);
  })();
}

// Verificação interna do FTS5 e da correspondência 1:1 com os contratos.
export function checkIndex(db: Database) {
  db.exec(`INSERT INTO contracts_fts(contracts_fts) VALUES ('integrity-check')`);
  const orphans = db.prepare(`SELECT
      (SELECT count(*) FROM contracts_fts WHERE rowid NOT IN (SELECT rid FROM contracts)) +
      (SELECT count(*) FROM contracts WHERE rid NOT IN (SELECT rowid FROM contracts_fts)) AS n`).get() as { n: number };
  if (orphans.n !== 0) throw new Error(`Índice FTS dessincronizado: ${orphans.n} linhas sem par.`);
}

export function setMeta(db: Database, key: string, value: string) {
  db.prepare(`INSERT OR REPLACE INTO meta VALUES (?, ?)`).run(key, value);
}

export function getMeta(db: Database, key: string): string | null {
  return (db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as { value: string } | null)?.value ?? null;
}

export function listIngestedYears(db: Database): number[] {
  const rows = db.prepare("SELECT key FROM meta WHERE key LIKE 'ingested_%'").all() as { key: string }[];
  return rows.filter(({ key }) => /^ingested_\d{4}$/.test(key))
    .map(({ key }) => Number(key.slice("ingested_".length)))
    .sort((a, b) => a - b);
}

export function countContracts(db: Database): number {
  return (db.prepare(`SELECT count(*) AS n FROM contracts`).get() as { n: number }).n;
}
