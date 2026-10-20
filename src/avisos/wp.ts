import { z } from "zod";
import { createHttp, SourceUnavailableError } from "../http";
import { cleanTitle, normalizeKey } from "./text";
import type { AvisoRow } from "./types";

export const WP_API = "https://acores.portugal2030.pt/wp-json/wp/v2/aviso";
export const WP_PAGE_SIZE = 50;
export const WP_MAX_PAGES = 40;

const EmptySchema = z.union([z.literal(false), z.literal(""), z.null()]);
const ListSchema = z.union([z.array(z.string()), EmptySchema]).transform((value) => Array.isArray(value) ? value : []);
const DateSchema = z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), EmptySchema])
  .transform((value) => value || null);
const AmountSchema = z.union([z.number(), z.string(), z.literal(false), z.null()])
  .transform((value) => {
    if (value === false || value === null || value === "") return null;
    if (typeof value === "number") return value;
    return Number(value.replace(/\s/g, "").replace(",", "."));
  }).pipe(z.number().nullable());

// Só os campos declarados seguem para o índice; os restantes são descartados pelo zod.
const PageSchema = z.array(z.object({
  id: z.number(), link: z.string().url(), modified: z.string().regex(/^\d{4}-\d{2}-\d{2}/),
  title: z.object({ rendered: z.string() }),
  acf: z.object({
    codigo: z.string().trim().min(1), beneficiario: ListSchema, programa: ListSchema,
    objectivo: ListSchema, fundo: ListSchema, data_inicio: DateSchema, data_fim: DateSchema, df: AmountSchema,
  }),
}));

type Http = ReturnType<typeof createHttp>;

export async function fetchWpAvisos(http: Http): Promise<AvisoRow[]> {
  const rows: AvisoRow[] = [];
  for (let page = 1; page <= WP_MAX_PAGES; page++) {
    let body: unknown;
    try {
      body = await http.json(`${WP_API}?per_page=${WP_PAGE_SIZE}&page=${page}`);
    } catch (error) {
      if (error instanceof SourceUnavailableError && error.status === 400 && page > 1) return rows;
      // Erros de JSON podem citar o corpo, que contém campos privados da fonte.
      if (error instanceof SyntaxError) throw new Error(`Resposta inesperada da API do Açores 2030 (página ${page}): JSON inválido`);
      throw error;
    }
    const parsed = PageSchema.safeParse(body, { error: () => "Valor inválido para este campo" });
    if (!parsed.success) {
      throw new Error(`Resposta inesperada da API do Açores 2030 (página ${page}): ${z.prettifyError(parsed.error)}`);
    }
    for (const item of parsed.data) {
      const acf = item.acf;
      rows.push({
        source: "acores2030_plano", code: acf.codigo, title: cleanTitle(item.title.rendered), status: null,
        program: acf.programa.join("; ") || null, program_search: acf.programa.map(normalizeKey).join("|"),
        funds: acf.fundo, objectives: acf.objectivo, amount_eur: acf.df,
        starts_on: acf.data_inicio, ends_on: acf.data_fim, beneficiary: acf.beneficiario,
        snapshot_date: item.modified.slice(0, 10), source_url: item.link,
      });
    }
    if (parsed.data.length < WP_PAGE_SIZE) return rows;
  }
  throw new Error(`A API do Açores 2030 excedeu o limite de ${WP_MAX_PAGES} páginas`);
}
