import type { Database } from "bun:sqlite";
import { z } from "zod";
import { ftsQuery } from "../contracts/search";
import { normalizeKey } from "./text";
import type { AvisoResult } from "./types";

export type AvisosSearchArgs = {
  query?: string;
  program?: string;
  status?: "Aberto" | "Fechado";
  beneficiary?: string;
  open_on?: string;
  limit?: number;
};

const JsonSchema = z.string().transform((text, ctx): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    // Não inclui o conteúdo do índice na mensagem de erro.
    ctx.addIssue({ code: "custom", message: "JSON inválido" });
    return z.NEVER;
  }
});
const ListSchema = JsonSchema.pipe(z.array(z.string()));
const GroupSchema = z.object({
  source: z.enum(["pt2030_xlsx", "acores2030_plano"]), code: z.string(),
  title: z.string().nullable(), status: z.string().nullable(), program: z.string().nullable(),
  amount_eur: z.number().nullable(), starts_on: z.string().nullable(), ends_on: z.string().nullable(),
  snapshot_date: z.string().nullable(), source_url: z.string(),
  funds: JsonSchema.pipe(z.array(ListSchema)), objectives: JsonSchema.pipe(z.array(ListSchema)),
  beneficiary: JsonSchema.pipe(z.array(ListSchema.nullable())),
});

function mergeLists(lists: (string[] | null)[]): string[] {
  return [...new Set(lists.flatMap((list) => list ?? []))];
}

export function searchAvisos(db: Database, args: AvisosSearchArgs): AvisoResult[] {
  const where: string[] = [];
  const params: Record<string, string | number> = {};

  // Um filtro fornecido mas inutilizável nunca se transforma numa pesquisa sem filtro.
  if (args.query !== undefined && args.query !== "") {
    const q = ftsQuery(args.query);
    if (q === null) return [];
    where.push("a.rid IN (SELECT rowid FROM avisos_fts WHERE avisos_fts MATCH $q)");
    params.$q = `{title program objectives funds} : (${q})`;
  }
  if (args.program !== undefined) {
    const key = normalizeKey(args.program);
    if (!key) return [];
    where.push("a.program_search LIKE '%' || $prog || '%'");
    params.$prog = key;
  }
  if (args.status !== undefined) {
    where.push("a.status = $status");
    params.$status = args.status;
  }
  if (args.beneficiary !== undefined) {
    const key = normalizeKey(args.beneficiary);
    if (key !== "publica" && key !== "privada") return [];
    where.push("a.beneficiary_search LIKE '%' || $ben || '%'");
    params.$ben = key;
  }
  if (args.open_on !== undefined) {
    where.push("a.starts_on IS NOT NULL AND a.ends_on IS NOT NULL AND a.starts_on <= $d AND a.ends_on >= $d");
    params.$d = args.open_on;
  }
  params.$limit = Math.min(Math.max(args.limit ?? 20, 1), 100);

  // Seleciona chaves distintas antes de somar o grupo inteiro, incluindo linhas sem correspondência.
  // A ordem por rid conserva a primeira ocorrência de cada elemento dos arrays.
  const sql = `WITH hit AS (
      SELECT DISTINCT a.source, a.code, a.program FROM avisos a ${where.length ? "WHERE " + where.join(" AND ") : ""}
    )
    SELECT g.source, g.code, MIN(g.title) AS title, g.program, MIN(g.status) AS status,
      ROUND(SUM(g.amount_eur), 2) AS amount_eur, MIN(g.starts_on) AS starts_on, MAX(g.ends_on) AS ends_on,
      MAX(g.snapshot_date) AS snapshot_date, MIN(g.source_url) AS source_url,
      json_group_array(g.funds ORDER BY g.rid) AS funds,
      json_group_array(g.objectives ORDER BY g.rid) AS objectives,
      json_group_array(g.beneficiary ORDER BY g.rid) AS beneficiary
    FROM avisos g JOIN hit h ON h.source = g.source AND h.code = g.code AND h.program IS g.program
    GROUP BY g.source, g.code, g.program
    ORDER BY (MIN(g.status) = 'Aberto') DESC, MAX(g.ends_on) IS NULL, MAX(g.ends_on), g.code, g.source
    LIMIT $limit`;
  let rows: unknown;
  try {
    rows = db.prepare(sql).all(params);
  } catch (error) {
    throw new Error(`Não foi possível pesquisar o índice de avisos: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  const parsed = z.array(GroupSchema).safeParse(rows, { error: () => "Valor inválido para este campo" });
  if (!parsed.success) {
    throw new Error(`Resposta inesperada do índice de avisos: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data.map((row) => ({
    ...row, funds: mergeLists(row.funds), objectives: mergeLists(row.objectives),
    beneficiary: row.beneficiary.every((list) => list === null) ? null : mergeLists(row.beneficiary),
  }));
}
