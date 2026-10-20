import type { Database } from "bun:sqlite";
import type { Contract } from "./base";

export type SearchArgs = {
  entity?: string;
  query?: string;
  from?: string;
  to?: string;
  limit?: number;
};

// Limites do custo de cada pesquisa: termos de uma letra com * percorreriam
// quase todo o vocabulário, e muitos termos multiplicam o trabalho do FTS.
export const MAX_TERMS = 8;
export const MIN_TERM_LENGTH = 2;

const stripDiacritics = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "");

// Preposições e designações administrativas genéricas: a grafia oficial de uma
// entidade varia por ano na fonte ("Câmara Municipal de X" num ano, "Município
// de X" noutro, para o mesmo NIF), e um AND sobre todas as palavras falhava
// sempre que o utilizador escrevia a forma que a fonte não usou nesse ano.
// Só entram no filtro quando sobra pelo menos uma palavra fora da lista: uma
// entidade digitada só com estas palavras não fica sem filtro nenhum.
const ENTITY_STOPWORDS = new Set(
  [
    "de", "da", "do", "das", "dos", "e",
    "camara", "municipal", "municipio", "concelho",
    "regiao", "regional", "autonoma", "autonomo",
    "direcao", "secretaria", "servicos", "municipalizados",
  ].map(stripDiacritics),
);

function extractWords(text: string): string[] {
  return (text.match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => [...w].length >= MIN_TERM_LENGTH);
}

// Cada palavra vira um termo FTS entre aspas com prefixo, para o texto do
// utilizador nunca ser interpretado como sintaxe FTS.
// null quando não sobra nenhum termo utilizável.
export function ftsQuery(text: string, opts?: { dropStopwords?: boolean }): string | null {
  let words = extractWords(text);
  if (opts?.dropStopwords) {
    const kept = words.filter((w) => !ENTITY_STOPWORDS.has(stripDiacritics(w.toLowerCase())));
    if (kept.length) words = kept;
  }
  words = words.slice(0, MAX_TERMS);
  return words.length ? words.map((w) => `"${w}"*`).join(" ") : null;
}

const COLUMNS = `c.id, c.entity, c.entity_nif, c.contractors, c.object, c.description, c.contract_type,
  c.procedure, c.value_eur, c.signed_on, c.published_on, c.location, c.nuts, c.cpv, c.source_url`;

// Um filtro de texto preenchido mas sem termos utilizáveis não encontra nada:
// nunca se alarga a pesquisa por se ter descartado o que o utilizador escreveu.
const NOTHING = `0`;

export function buildSearchSql(a: SearchArgs): { sql: string; params: Record<string, string | number> } {
  const where: string[] = [];
  const params: Record<string, string | number> = {};

  if (a.entity?.trim()) {
    const e = a.entity.trim();
    if (/^\d{9}$/.test(e)) {
      where.push(`c.entity_nif = $nif`);
      params.$nif = e;
    } else {
      const q = ftsQuery(e, { dropStopwords: true });
      if (q) {
        where.push(`c.rid IN (SELECT rowid FROM contracts_fts WHERE contracts_fts MATCH $ent)`);
        params.$ent = `entity : (${q})`;
      } else {
        where.push(NOTHING);
      }
    }
  }
  if (a.query?.trim()) {
    const q = ftsQuery(a.query);
    if (q) {
      where.push(`c.rid IN (SELECT rowid FROM contracts_fts WHERE contracts_fts MATCH $q)`);
      params.$q = `{entity object description} : (${q})`;
    } else {
      where.push(NOTHING);
    }
  }
  if (a.from) { where.push(`c.signed_on >= $from`); params.$from = a.from; }
  if (a.to) { where.push(`c.signed_on <= $to`); params.$to = a.to; }

  params.$limit = Math.min(Math.max(a.limit ?? 20, 1), 100);
  const sql = `SELECT ${COLUMNS} FROM contracts c ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY c.signed_on DESC NULLS LAST, c.id DESC LIMIT $limit`;
  return { sql, params };
}

export function searchContracts(db: Database, a: SearchArgs): Contract[] {
  const { sql, params } = buildSearchSql(a);
  return (db.prepare(sql).all(params) as (Omit<Contract, "contractors"> & { contractors: string })[])
    .map((r) => ({ ...r, contractors: JSON.parse(r.contractors) as string[] }));
}
