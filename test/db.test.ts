import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isAzores, toContract, type Contract } from "../src/contracts/base";
import {
  checkIndex, countContracts, DbUnavailableError, EmptyImportError, getMeta, openReadOnlyDb, openWritableDb, replaceYear, SCHEMA_VERSION,
} from "../src/contracts/db";
import { searchContracts } from "../src/contracts/search";
import { rows, seededDb } from "./fixtures";

const dir = mkdtempSync(join(tmpdir(), "joraa-mcp-db-"));
afterAll(() => {
  // Repõe permissões para conseguir apagar o diretório só de leitura.
  for (const d of readdirSync(dir)) chmodSync(join(dir, d), 0o755);
  rmSync(dir, { recursive: true, force: true });
});

const contracts = rows.filter(isAzores).map(toContract);
const contract = (id: string, object: string): Contract => ({ ...contracts[0]!, id, object, source_url: `https://example.org/${id}` });
const ids = (db: Database) => (db.prepare(`SELECT id FROM contracts ORDER BY id`).all() as { id: string }[]).map((r) => r.id);

test("reimportar um ano remove o que desapareceu da fonte", () => {
  const db = seededDb();
  expect(ids(db)).toEqual(["1001", "1002"]);
  replaceYear(db, 2026, [contract("1001", "Manutenção da rede elétrica")]);
  expect(ids(db)).toEqual(["1001"]);
  expect(searchContracts(db, { query: "estradas" })).toEqual([]);
  checkIndex(db);
});

test("cada ano é substituído sem tocar nos outros", () => {
  const db = seededDb();
  replaceYear(db, 2025, [contract("9001", "Limpeza de praias")]);
  replaceYear(db, 2026, [contract("1001", "Manutenção da rede elétrica")]);
  expect(ids(db)).toEqual(["1001", "9001"]);
  expect(getMeta(db, "ingested_2025")).not.toBeNull();
  expect(getMeta(db, "ingested_2026")).not.toBeNull();
  checkIndex(db);
});

test("uma importação sem contratos é recusada e o índice fica igual", () => {
  const db = seededDb(":memory:", 2026);
  const before = getMeta(db, "last_ingest");
  expect(() => replaceYear(db, 2026, [])).toThrow(EmptyImportError);
  expect(ids(db)).toEqual(["1001", "1002"]);
  expect(getMeta(db, "last_ingest")).toBe(before);
});

test("um erro a meio desfaz o ano inteiro", () => {
  const db = seededDb();
  const before = getMeta(db, "last_ingest");
  const bad = { ...contract("1003", "x"), source_url: null as unknown as string };
  expect(() => replaceYear(db, 2026, [contract("1004", "Novo"), bad])).toThrow();
  expect(ids(db)).toEqual(["1001", "1002"]);
  expect(getMeta(db, "last_ingest")).toBe(before);
  checkIndex(db);
});

test("um id repetido no ficheiro ou vindo de outro ano fica uma só vez, com o texto mais recente", () => {
  const db = openWritableDb(":memory:");
  replaceYear(db, 2025, [contract("1", "Texto antigo")]);
  replaceYear(db, 2026, [contract("1", "Texto intermédio"), contract("1", "Texto final"), contract("2", "Outro")]);
  expect(ids(db)).toEqual(["1", "2"]);
  expect((db.prepare(`SELECT source_year FROM contracts WHERE id = '1'`).get() as { source_year: number }).source_year).toBe(2026);
  expect(searchContracts(db, { query: "final" }).map((c) => c.id)).toEqual(["1"]);
  expect(searchContracts(db, { query: "antigo" })).toEqual([]);
  expect(searchContracts(db, { query: "intermédio" })).toEqual([]);
  // Reimportar 2025 sem o contrato 1 não o apaga: já pertence a 2026.
  replaceYear(db, 2025, [contract("3", "Terceiro")]);
  expect(ids(db)).toEqual(["1", "2", "3"]);
  checkIndex(db);
});

test("um id em dois anos fica no ano mais alto, seja qual for a ordem de importação", () => {
  const db = openWritableDb(":memory:");
  replaceYear(db, 2026, [contract("1", "Versão recente")]);
  replaceYear(db, 2025, [contract("1", "Versão velha"), contract("2", "Outro")]);
  expect(ids(db)).toEqual(["1", "2"]);
  expect((db.prepare(`SELECT source_year FROM contracts WHERE id = '1'`).get() as { source_year: number }).source_year).toBe(2026);
  expect(searchContracts(db, { query: "recente" }).map((c) => c.id)).toEqual(["1"]);
  expect(searchContracts(db, { query: "velha" })).toEqual([]);
  checkIndex(db);
  // Reimportar 2026 sem o contrato 1 apaga-o: 2025 já não o tem como seu.
  replaceYear(db, 2026, [contract("3", "Terceiro")]);
  expect(ids(db)).toEqual(["2", "3"]);
  checkIndex(db);
});

test("um índice FTS dessincronizado faz falhar a importação antes do COMMIT", () => {
  const db = seededDb();
  const before = getMeta(db, "last_ingest");
  db.prepare(`INSERT INTO contracts_fts (rowid, entity, object, description) VALUES (999, 'x', 'y', 'z')`).run();
  expect(() => replaceYear(db, 2026, [contract("1004", "Novo")])).toThrow(/dessincronizado/);
  expect(ids(db)).toEqual(["1001", "1002"]);
  expect(getMeta(db, "last_ingest")).toBe(before);
});

test("checkIndex deteta linhas FTS sem contrato", () => {
  const db = seededDb();
  db.prepare(`INSERT INTO contracts_fts (rowid, entity, object, description) VALUES (999, 'x', 'y', 'z')`).run();
  expect(() => checkIndex(db)).toThrow(/dessincronizado/);
});

test("o serviço não cria o índice quando falta e explica como o criar", () => {
  const path = join(dir, "falta", "c.sqlite");
  expect(() => openReadOnlyDb(path)).toThrow(DbUnavailableError);
  expect(() => openReadOnlyDb(path)).toThrow(/bun run ingest/);
  expect(existsSync(path)).toBe(false);
  expect(existsSync(join(dir, "falta"))).toBe(false);
});

test("um índice com outro esquema é recusado nos dois modos", () => {
  const path = join(dir, "antigo.sqlite");
  const old = new Database(path, { create: true });
  old.exec(`CREATE TABLE contracts (id TEXT PRIMARY KEY); PRAGMA user_version = 1`);
  old.close();
  expect(() => openReadOnlyDb(path)).toThrow(/esquema 1/);
  expect(() => openWritableDb(path)).toThrow(/esquema 1/);
});

test("um ficheiro recusado pelo ingest fica intacto, incluindo o journal_mode", () => {
  const path = join(dir, "antigo-wal.sqlite");
  const old = new Database(path, { create: true });
  old.exec(`PRAGMA journal_mode = WAL; CREATE TABLE contracts (id TEXT PRIMARY KEY); PRAGMA user_version = 1`);
  old.close();
  const bytes = readFileSync(path);
  expect(() => openWritableDb(path)).toThrow(/esquema 1/);
  expect(readFileSync(path).equals(bytes)).toBe(true);
  const again = new Database(path, { readonly: true });
  expect((again.prepare(`PRAGMA journal_mode`).get() as { journal_mode: string }).journal_mode).toBe("wal");
  again.close();
});

test("a ligação do serviço não escreve", () => {
  const path = join(dir, "ro-check.sqlite");
  seededDb(path).close();
  const db = openReadOnlyDb(path);
  expect(() => db.exec(`DELETE FROM contracts`)).toThrow();
  expect(countContracts(db)).toBe(2);
  db.close();
});

test("o índice abre e pesquisa num volume só de leitura, sem criar -wal nem -shm", () => {
  const roDir = join(dir, "ro");
  mkdirSync(roDir);
  const path = join(roDir, "c.sqlite");
  const w = seededDb(path);
  expect((w.prepare(`PRAGMA journal_mode`).get() as { journal_mode: string }).journal_mode).toBe("delete");
  w.close();
  chmodSync(path, 0o444);
  chmodSync(roDir, 0o555);
  const db = openReadOnlyDb(path);
  expect(searchContracts(db, { entity: "EDA" }).map((c) => c.id)).toEqual(["1001"]);
  expect(getMeta(db, "last_ingest")).not.toBeNull();
  db.close();
  expect(readdirSync(roDir)).toEqual(["c.sqlite"]);
});

test("o esquema grava a versão atual", () => {
  const db = openWritableDb(":memory:");
  expect((db.prepare(`PRAGMA user_version`).get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION);
});
