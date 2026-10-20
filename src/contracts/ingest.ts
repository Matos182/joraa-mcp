import { unzipSync } from "fflate";
import { z } from "zod";
import { createHttp } from "../http";
import { hasContractId, isAzores, toContract, type BaseRow } from "./base";
import { checkIndex, countContracts, openWritableDb, replaceYear } from "./db";

// Dataset do IMPIC no dados.gov.pt: um ZIP por ano, atualizado semanalmente.
// Os URLs dos ficheiros mudam a cada atualização, por isso resolvem-se pela API.
export const DATASET_API = "https://dados.gov.pt/api/1/datasets/66d72d488ca4b7cb2de28712/";

// Únicos destinos do ingest. Um ficheiro (ou redirecionamento) noutro anfitrião é recusado
// com o nome do anfitrião no erro; acrescenta-se aqui só depois de confirmado.
export const DADOS_GOV_HOSTS = ["dados.gov.pt"] as const;

const MAX_METADATA_BYTES = 8 * 1024 * 1024;
const MAX_ZIP_BYTES = positiveInt("JORAA_MCP_MAX_DOWNLOAD_BYTES", 512 * 1024 * 1024);

function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`${name} tem de ser um inteiro positivo, recebido ${JSON.stringify(raw)}`);
  return n;
}

const DatasetSchema = z.object({
  resources: z.array(z.object({ title: z.string(), url: z.string().min(1) })),
});

type Http = ReturnType<typeof createHttp>;

export function createIngestHttp(): Http {
  // 10 min por pedido, incluindo a leitura do ZIP anual.
  return createHttp({ allowedHosts: DADOS_GOV_HOSTS, maxBytes: MAX_ZIP_BYTES, timeoutMs: 10 * 60 * 1000 });
}

export async function resolveZipUrl(http: Http, year: number): Promise<string> {
  const parsed = DatasetSchema.safeParse(await http.json(DATASET_API, { maxBytes: MAX_METADATA_BYTES }));
  if (!parsed.success) {
    throw new Error(`Resposta inesperada da API do dados.gov.pt (${DATASET_API}): ${z.prettifyError(parsed.error)}`);
  }
  const r = parsed.data.resources.find((x) => x.title === `contratos${year}.zip`);
  if (!r) throw new Error(`O dataset não tem o ficheiro contratos${year}.zip`);
  return r.url;
}

export function azoresRows(zip: Uint8Array): { rows: BaseRow[]; rejected: number } {
  const files = unzipSync(zip, { filter: (f) => f.name.toLowerCase().endsWith(".json") });
  const rows: BaseRow[] = [];
  let rejected = 0;
  for (const [name, data] of Object.entries(files)) {
    const all: unknown = JSON.parse(new TextDecoder().decode(data));
    if (!Array.isArray(all)) throw new Error(`${name} não é uma lista de contratos`);
    for (const r of all as BaseRow[]) {
      if (!isAzores(r)) continue;
      if (hasContractId(r)) rows.push(r);
      else rejected++;
    }
  }
  return { rows, rejected };
}

export async function ingestYear(year: number, dbPath?: string, http: Http = createIngestHttp()) {
  const url = await resolveZipUrl(http, year);
  const zip = new Uint8Array(await http.get(url));
  const { rows, rejected } = azoresRows(zip);
  const db = openWritableDb(dbPath);
  try {
    replaceYear(db, year, rows.map(toContract));
    checkIndex(db);
    return { year, url, azores: rows.length, rejected, total: countContracts(db) };
  } finally {
    db.close();
  }
}

export function parseYears(args: string[], now = new Date()): number[] {
  if (args.length === 0) return [now.getFullYear()];
  return args.map((a) => {
    if (!/^\d{4}$/.test(a)) throw new Error(`Ano inválido: ${JSON.stringify(a)}`);
    return Number(a);
  });
}

if (import.meta.main) {
  try {
    for (const y of parseYears(process.argv.slice(2))) {
      console.error(`A importar ${y}...`);
      console.error(JSON.stringify(await ingestYear(y)));
    }
  } catch (error) {
    console.error(`ingest: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
