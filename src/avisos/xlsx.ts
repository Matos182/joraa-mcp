import { unzipSync } from "fflate";
import { decodeEntities, normalizeKey } from "./text";
import type { AvisoRow } from "./types";

export const XLSX_HEADERS = [
  "Data", "Código do Aviso", "Designação do Aviso", "Estado do Aviso", "Código do Programa",
  "Designação do Programa", "Marca do Programa", "Código do Objetivo Estratégico", "Designação do Objetivo Estratégico",
  "Código do Objetivo Específico", "Sigla do Objetivo Específico", "Designação do Objetivo Específico",
  "Código do Fundo", "Sigla do Fundo", "Designação do Fundo", "Montante fundo colocado a concurso [1000€]",
  "Enquadramento", "Critérios de seleção",
] as const;

const REQUIRED_HEADERS = [
  "Data", "Código do Aviso", "Designação do Aviso", "Estado do Aviso", "Código do Programa",
  "Designação do Programa", "Marca do Programa", "Sigla do Objetivo Específico", "Designação do Objetivo Específico",
  "Sigla do Fundo", "Designação do Fundo", "Montante fundo colocado a concurso [1000€]",
] as const;
type Header = typeof REQUIRED_HEADERS[number];

function attribute(attributes: string, name: string): string | undefined {
  return new RegExp(`(?:^|\\s)${name}\\s*=\\s*(["'])(.*?)\\1`).exec(attributes)?.[2];
}

// Os trechos fonéticos não fazem parte do texto visível da célula.
function richText(xml: string): string {
  const visible = xml.replace(/<rPh\b[^>]*?(?:\/>|>[\s\S]*?<\/rPh>)/g, "");
  return [...visible.matchAll(/<t\b[^>]*?(?:\/>|>([\s\S]*?)<\/t>)/g)]
    .map((match) => decodeEntities(match[1] ?? "")).join("");
}

function cellText(body: string, type: string | undefined, ref: string, shared: string[]): string {
  if (type === "inlineStr") {
    return richText(/<is\b[^>]*?(?:\/>|>([\s\S]*?)<\/is>)/.exec(body)?.[1] ?? "");
  }
  const value = decodeEntities(/<v\b[^>]*?(?:\/>|>([\s\S]*?)<\/v>)/.exec(body)?.[1] ?? "");
  if (type === "s") {
    if (value === "") return "";
    const index = Number(value);
    if (!/^\d+$/.test(value.trim()) || !Number.isSafeInteger(index) || shared[index] === undefined) {
      throw new Error(`Índice sharedStrings inválido na célula ${ref}`);
    }
    return shared[index];
  }
  if (type === undefined || type === "n" || type === "str" || type === "b") return value;
  throw new Error(`O XLSX tem um tipo de célula não suportado em ${ref}`);
}

export function readSheet(xlsx: Uint8Array): Map<number, Map<string, string>> {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(xlsx, { filter: (file) => file.name === "xl/worksheets/sheet1.xml" || file.name === "xl/sharedStrings.xml" });
  } catch (error) {
    throw new Error("Não foi possível descomprimir o XLSX", { cause: error });
  }
  const sheet = files["xl/worksheets/sheet1.xml"];
  if (!sheet) throw new Error("O XLSX não tem a folha xl/worksheets/sheet1.xml");
  const decoder = new TextDecoder();
  const sharedXml = files["xl/sharedStrings.xml"];
  const shared = [...(sharedXml ? decoder.decode(sharedXml) : "").matchAll(/<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g)]
    .map((match) => richText(match[1] ?? ""));
  const rows = new Map<number, Map<string, string>>();
  // A referência fixa a posição; uma célula omitida ou autocontida não desloca as seguintes.
  for (const cell of decoder.decode(sheet).matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const attrs = cell[1]!;
    const ref = attribute(attrs, "r") ?? "";
    const position = /^([A-Z]+)([1-9]\d*)$/.exec(ref);
    if (!position || !Number.isSafeInteger(Number(position[2]))) throw new Error("O XLSX tem uma célula sem referência válida");
    if (cell[2] === undefined) continue;
    const text = cellText(cell[2], attribute(attrs, "t"), ref, shared);
    if (text === "") continue;
    const rowNumber = Number(position[2]);
    const row = rows.get(rowNumber) ?? new Map<string, string>();
    row.set(position[1]!, text);
    rows.set(rowNumber, row);
  }
  return rows;
}

export function excelSerialToIso(n: number): string {
  const date = new Date(Date.UTC(1899, 11, 30) + n * 86_400_000);
  if (!Number.isFinite(n) || !Number.isFinite(date.getTime())) throw new Error("Data Excel inválida: série não finita ou fora do intervalo");
  return date.toISOString().slice(0, 10);
}

function headerColumns(sheet: Map<number, Map<string, string>>): Map<string, string> {
  const columns = new Map<string, string>();
  for (const [column, text] of sheet.get(1) ?? []) columns.set(text.replace(/\s+/g, " ").trim(), column);
  const missing = REQUIRED_HEADERS.filter((header) => !columns.has(header));
  if (missing.length) throw new Error(missing.map((header) => `O XLSX não tem a coluna "${header}"`).join("; "));
  return columns;
}

function amountEur(text: string | null, ref: string): number | null {
  if (text === null) return null;
  const value = Number(text.replace(",", "."));
  const amount = Math.round(value * 1000 * 100) / 100;
  if (!Number.isFinite(value) || !Number.isFinite(amount)) throw new Error(`Montante inválido na célula ${ref}`);
  return amount;
}

function snapshotDate(text: string | null, ref: string): string | null {
  if (text === null) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  try {
    return excelSerialToIso(Number(text));
  } catch (error) {
    throw new Error(`Data inválida na célula ${ref}`, { cause: error });
  }
}

export function parseAvisosXlsx(xlsx: Uint8Array, sourceUrl: string): AvisoRow[] {
  const sheet = readSheet(xlsx);
  const columns = headerColumns(sheet);
  const rows: AvisoRow[] = [];
  for (const [rowNumber, cells] of sheet) {
    if (rowNumber < 2) continue;
    const get = (header: Header): string | null => cells.get(columns.get(header)!)?.trim() || null;
    const ref = (header: Header): string => `${columns.get(header)!}${rowNumber}`;
    const code = get("Código do Aviso");
    if (!code) throw new Error(`A linha ${rowNumber} do XLSX não tem Código do Aviso`);
    const programCode = get("Código do Programa");
    const programName = get("Designação do Programa");
    const programBrand = get("Marca do Programa");
    const fund = get("Sigla do Fundo") ?? get("Designação do Fundo");
    const objective = [get("Sigla do Objetivo Específico"), get("Designação do Objetivo Específico")].filter(Boolean).join(" - ");
    rows.push({
      source: "pt2030_xlsx", code, title: get("Designação do Aviso"), status: get("Estado do Aviso"),
      program: programBrand ?? programName ?? programCode,
      program_search: [programCode, programName, programBrand].filter((part) => part !== null).map(normalizeKey).join("|"),
      funds: fund ? [fund] : [], objectives: objective ? [objective] : [],
      amount_eur: amountEur(get("Montante fundo colocado a concurso [1000€]"), ref("Montante fundo colocado a concurso [1000€]")),
      starts_on: null, ends_on: null, beneficiary: null,
      snapshot_date: snapshotDate(get("Data"), ref("Data")), source_url: sourceUrl,
    });
  }
  return rows;
}
