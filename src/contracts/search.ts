import type { Database } from "bun:sqlite";
import type { Contract } from "./base";

export type SearchArgs = {
  entity?: string;
  query?: string;
  from?: string;
  to?: string;
  limit?: number;
};

// Cada palavra vira um termo FTS entre aspas com prefixo, para o texto do
// utilizador nunca ser interpretado como sintaxe FTS.
function ftsQuery(text: string): string | null {
  const words = text.match(/[\p{L}\p{N}]+/gu) ?? [];
  return words.length ? words.map((w) => `"${w}"*`).join(" ") : null;
}

export function searchContracts(db: Database, a: SearchArgs): Contract[] {
  const where: string[] = [];
  const params: Record<string, string | number> = {};

  if (a.entity?.trim()) {
    const e = a.entity.trim();
    if (/^\d{9}$/.test(e)) {
      where.push(`c.entity_nif = $nif`);
      params.$nif = e;
    } else {
      const q = ftsQuery(e);
      if (q) {
        where.push(`c.id IN (SELECT id FROM contracts_fts WHERE contracts_fts MATCH $ent)`);
        params.$ent = `entity : (${q})`;
      }
    }
  }
  if (a.query?.trim()) {
    const q = ftsQuery(a.query);
    if (q) {
      where.push(`c.id IN (SELECT id FROM contracts_fts WHERE contracts_fts MATCH $q)`);
      params.$q = `{entity object description} : (${q})`;
    }
  }
  if (a.from) { where.push(`c.signed_on >= $from`); params.$from = a.from; }
  if (a.to) { where.push(`c.signed_on <= $to`); params.$to = a.to; }

  params.$limit = Math.min(Math.max(a.limit ?? 20, 1), 100);
  const sql = `SELECT * FROM contracts c ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY c.signed_on DESC NULLS LAST, c.id DESC LIMIT $limit`;
  return (db.prepare(sql).all(params) as any[]).map((r) => ({ ...r, contractors: JSON.parse(r.contractors) }));
}
