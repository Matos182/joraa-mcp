import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { normalizeKey } from "./text";
import type { AvisoRow, AvisoSource } from "./types";

export const DEFAULT_AVISOS_DB_PATH =
  process.env.JORAA_MCP_AVISOS_DB ?? join(import.meta.dir, "..", "..", "data", "avisos.sqlite");
export const AVISOS_SCHEMA_VERSION = 1;

export class AvisosDbUnavailableError extends Error {}
export class EmptySourceError extends Error {}

function assertSchema(db: Database, path: string): void {
  const { user_version } = db.prepare("PRAGMA user_version").get() as { user_version: number };
  if (user_version !== AVISOS_SCHEMA_VERSION) {
    throw new AvisosDbUnavailableError(
      `O índice de avisos em ${path} tem o esquema ${user_version} e este servidor usa o ${AVISOS_SCHEMA_VERSION}. ` +
      "Apaga o ficheiro e corre `bun run ingest:avisos` para o recriar.",
    );
  }
}

export function openAvisosReadOnlyDb(path = DEFAULT_AVISOS_DB_PATH): Database {
  if (!existsSync(path)) {
    throw new AvisosDbUnavailableError(`O índice de avisos não existe em ${path}. Corre \`bun run ingest:avisos\` para o criar.`);
  }
  const db = new Database(path, { readonly: true });
  try {
    db.exec("PRAGMA query_only = ON");
    assertSchema(db, path);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

export function openAvisosWritableDb(path = DEFAULT_AVISOS_DB_PATH): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  try {
    // A versão é verificada antes de qualquer escrita, mesmo num ficheiro sem tabelas.
    const { user_version } = db.prepare("PRAGMA user_version").get() as { user_version: number };
    const hasTables = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' LIMIT 1").get() !== null;
    if (hasTables || user_version !== 0) assertSchema(db, path);
    db.exec("PRAGMA journal_mode = DELETE");
    db.exec(`
      CREATE TABLE IF NOT EXISTS avisos (
        rid INTEGER PRIMARY KEY, source TEXT NOT NULL, code TEXT NOT NULL, title TEXT, status TEXT,
        program TEXT, program_search TEXT NOT NULL, funds TEXT NOT NULL, objectives TEXT NOT NULL,
        amount_eur REAL, starts_on TEXT, ends_on TEXT, beneficiary TEXT, beneficiary_search TEXT,
        snapshot_date TEXT, source_url TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS avisos_group ON avisos(source, code, program);
      CREATE VIRTUAL TABLE IF NOT EXISTS avisos_fts USING fts5(
        title, program, objectives, funds, tokenize = 'unicode61 remove_diacritics 2', prefix = '2 3'
      );
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
      PRAGMA user_version = ${AVISOS_SCHEMA_VERSION};
    `);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

const SOURCES: readonly AvisoSource[] = ["pt2030_xlsx", "acores2030_plano"];

// Mantém o grão da fonte: a soma por programa pertence à pesquisa, nunca à importação.
export function replaceAvisos(db: Database, bySource: Record<AvisoSource, AvisoRow[]>, meta: Record<string, string>, now = new Date()): void {
  for (const source of SOURCES) {
    if (bySource[source].length === 0) {
      throw new EmptySourceError(`A fonte ${source} não devolveu avisos; o índice fica como estava.`);
    }
  }
  const insert = db.prepare(`INSERT INTO avisos
    (source, code, title, status, program, program_search, funds, objectives, amount_eur,
     starts_on, ends_on, beneficiary, beneficiary_search, snapshot_date, source_url)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING rid`);
  const insertFts = db.prepare("INSERT INTO avisos_fts (rowid, title, program, objectives, funds) VALUES (?,?,?,?,?)");
  const setMeta = db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)");
  const stamp = now.toISOString();
  db.transaction(() => {
    db.exec("DELETE FROM avisos_fts; DELETE FROM avisos;");
    for (const source of SOURCES) {
      for (const row of bySource[source]) {
        const { rid } = insert.get(
          row.source, row.code, row.title, row.status, row.program, row.program_search,
          JSON.stringify(row.funds), JSON.stringify(row.objectives), row.amount_eur, row.starts_on, row.ends_on,
          row.beneficiary === null ? null : JSON.stringify(row.beneficiary),
          row.beneficiary === null ? null : row.beneficiary.map(normalizeKey).join("|"),
          row.snapshot_date, row.source_url,
        ) as { rid: number };
        insertFts.run(rid, row.title, row.program, row.objectives.join(" "), row.funds.join(" "));
      }
    }
    for (const [key, value] of Object.entries(meta)) setMeta.run(key, value);
    setMeta.run("last_ingest", stamp);
    for (const source of SOURCES) setMeta.run(`count_${source}`, String(bySource[source].length));
    checkIndex(db);
  })();
}

function checkIndex(db: Database): void {
  db.exec("INSERT INTO avisos_fts(avisos_fts) VALUES ('integrity-check')");
  const { n } = db.prepare(`SELECT
    (SELECT count(*) FROM avisos_fts WHERE rowid NOT IN (SELECT rid FROM avisos)) +
    (SELECT count(*) FROM avisos WHERE rid NOT IN (SELECT rowid FROM avisos_fts)) AS n`).get() as { n: number };
  if (n !== 0) throw new Error(`Índice FTS de avisos dessincronizado: ${n} linhas sem par.`);
}

export function getAvisosMeta(db: Database, key: string): string | null {
  return (db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | null)?.value ?? null;
}

export function countAvisos(db: Database): number {
  return (db.prepare("SELECT count(*) AS n FROM avisos").get() as { n: number }).n;
}
