import { unzipSync } from "fflate";
import { createHttp } from "../http";
import { isAzores, toContract, type BaseRow } from "./base";
import { countContracts, openDb, setMeta, upsertContracts } from "./db";

// Dataset do IMPIC no dados.gov.pt: um ZIP por ano, atualizado semanalmente.
// Os URLs dos ficheiros mudam a cada atualização, por isso resolvem-se pela API.
export const DATASET_API = "https://dados.gov.pt/api/1/datasets/66d72d488ca4b7cb2de28712/";

type Http = ReturnType<typeof createHttp>;

export async function resolveZipUrl(http: Http, year: number): Promise<string> {
  const ds = await http.json<{ resources: { title: string; url: string }[] }>(DATASET_API);
  const r = ds.resources.find((x) => x.title === `contratos${year}.zip`);
  if (!r) throw new Error(`O dataset não tem o ficheiro contratos${year}.zip`);
  return r.url;
}

export function azoresRows(zip: Uint8Array): BaseRow[] {
  const files = unzipSync(zip, { filter: (f) => f.name.toLowerCase().endsWith(".json") });
  const rows: BaseRow[] = [];
  for (const data of Object.values(files)) {
    const all: BaseRow[] = JSON.parse(new TextDecoder().decode(data));
    for (const r of all) if (isAzores(r)) rows.push(r);
  }
  return rows;
}

export async function ingestYear(year: number, dbPath?: string, http: Http = createHttp()) {
  const url = await resolveZipUrl(http, year);
  const zip = new Uint8Array(await http.get(url));
  const rows = azoresRows(zip).map(toContract);
  const db = openDb(dbPath);
  upsertContracts(db, rows);
  setMeta(db, `ingested_${year}`, new Date().toISOString());
  setMeta(db, "last_ingest", new Date().toISOString());
  const total = countContracts(db);
  db.close();
  return { year, url, azores: rows.length, total };
}

if (import.meta.main) {
  const years = process.argv.slice(2).map(Number).filter(Boolean);
  for (const y of years.length ? years : [new Date().getFullYear()]) {
    console.error(`A importar ${y}...`);
    console.error(JSON.stringify(await ingestYear(y)));
  }
}
