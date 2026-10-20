import { z } from "zod";
import { createHttp } from "../http";
import { countAvisos, EmptySourceError, openAvisosWritableDb, replaceAvisos } from "./db";
import type { AvisoRow, AvisoSource } from "./types";
import { fetchWpAvisos } from "./wp";
import { parseAvisosXlsx } from "./xlsx";

export const AVISOS_DATASET_API = "https://dados.gov.pt/api/1/datasets/65afddb4bca3f3b9c6aac069/";
export const AVISOS_DATASET_PAGE = "https://dados.gov.pt/pt/datasets/65afddb4bca3f3b9c6aac069/";
export const AVISOS_HOSTS = ["dados.gov.pt", "acores.portugal2030.pt"] as const;

const DatasetSchema = z.object({
  resources: z.array(z.object({ title: z.string(), url: z.string().min(1) })),
});
type Http = ReturnType<typeof createHttp>;

export function createAvisosHttp(): Http {
  return createHttp({ allowedHosts: AVISOS_HOSTS, maxBytes: 64 * 1024 * 1024, timeoutMs: 5 * 60 * 1000 });
}

function resourceDate(title: string): string {
  const match = /(\d{2})(\d{2})(\d{4})\.xlsx$/i.exec(title);
  if (!match) return "";
  const iso = `${match[3]}-${match[2]}-${match[1]}`;
  const date = new Date(`${iso}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === iso ? iso : "";
}

export async function resolveXlsxUrl(http: Http): Promise<string> {
  let body: unknown;
  try {
    body = await http.json(AVISOS_DATASET_API, { maxBytes: 8 * 1024 * 1024 });
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("Resposta inesperada da API do dados.gov.pt: JSON inválido");
    throw error;
  }
  const parsed = DatasetSchema.safeParse(body, { error: () => "Valor inválido para este campo" });
  if (!parsed.success) {
    throw new Error(`Resposta inesperada da API do dados.gov.pt (${AVISOS_DATASET_API}): ${z.prettifyError(parsed.error)}`);
  }
  const candidates = parsed.data.resources.filter((resource) => /^02-datasets-avisos-pt2030-.*\.xlsx$/i.test(resource.title));
  let selected = candidates[0];
  if (!selected) throw new Error("O dataset não tem o ficheiro 02-datasets-avisos-pt2030-*.xlsx");
  // Data DDMMYYYY mais recente; sem data válida ou em empate, fica o primeiro da API.
  for (const candidate of candidates.slice(1)) {
    if (resourceDate(candidate.title) > resourceDate(selected.title)) selected = candidate;
  }
  return selected.url;
}

export async function ingestAvisos(dbPath?: string, http: Http = createAvisosHttp(), now = new Date()): Promise<{
  xlsx_url: string; pt2030_xlsx: number; acores2030_plano: number; total: number;
}> {
  const url = await resolveXlsxUrl(http);
  const xlsx = parseAvisosXlsx(new Uint8Array(await http.get(url)), url);
  const wp = await fetchWpAvisos(http);
  const bySource: Record<AvisoSource, AvisoRow[]> = { pt2030_xlsx: xlsx, acores2030_plano: wp };
  // Nenhuma falha das fontes pode criar ou alterar o índice anterior.
  for (const [source, rows] of Object.entries(bySource)) {
    if (rows.length === 0) throw new EmptySourceError(`A fonte ${source} não devolveu avisos; o índice fica como estava.`);
  }
  const db = openAvisosWritableDb(dbPath);
  try {
    replaceAvisos(db, bySource, { xlsx_url: url }, now);
    return { xlsx_url: url, pt2030_xlsx: xlsx.length, acores2030_plano: wp.length, total: countAvisos(db) };
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  try {
    console.error("A importar avisos...");
    console.error(JSON.stringify(await ingestAvisos()));
  } catch (error) {
    console.error(`ingest:avisos: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
