import { strToU8, zipSync } from "fflate";
import type { Database } from "bun:sqlite";
import { openAvisosWritableDb, replaceAvisos } from "../src/avisos/db";
import { AVISOS_DATASET_API, AVISOS_HOSTS } from "../src/avisos/ingest";
import { normalizeKey } from "../src/avisos/text";
import type { AvisoRow } from "../src/avisos/types";
import { WP_API } from "../src/avisos/wp";
import { parseAvisosXlsx, XLSX_HEADERS } from "../src/avisos/xlsx";
import { createHttp } from "../src/http";

export type XlsxText = string | { xml: string };
export type XlsxCell = { column: string } & (
  | { type: "empty" }
  | { type: "inlineStr"; value: XlsxText }
  | { type?: "s" | "n" | "str" | "b"; value: string | number }
);
export type XlsxRow = { row: number; cells: readonly XlsxCell[] };

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function textXml(value: XlsxText): string {
  return typeof value === "string" ? `<t xml:space="preserve">${escapeXml(value)}</t>` : value.xml;
}

function columnName(index: number): string {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + (n - 1) % 26) + name;
  return name;
}

function cellXml(cell: XlsxCell, row: number): string {
  const ref = `${cell.column}${row}`;
  if (cell.type === "empty") return `<c r="${ref}" s="3"/>`;
  if (cell.type === "inlineStr") return `<c r="${ref}" t="inlineStr"><is>${textXml(cell.value)}</is></c>`;
  const type = cell.type === undefined ? "" : ` t="${cell.type}"`;
  return `<c r="${ref}"${type}><v>${escapeXml(String(cell.value))}</v></c>`;
}

// null omite a célula do cabeçalho; xml permite entidades e trechos de texto sintéticos.
export function xlsxOf(headers: readonly (string | null)[], rows: readonly XlsxRow[], sharedStrings: readonly XlsxText[] = []): Uint8Array {
  const head = headers.map((value, index) => value === null ? "" : cellXml({ column: columnName(index), type: "inlineStr", value }, 1)).join("");
  const body = rows.map(({ row, cells }) => `<row r="${row}">${cells.map((cell) => cellXml(cell, row)).join("")}</row>`).join("");
  const files: Record<string, Uint8Array> = {
    "xl/worksheets/sheet1.xml": strToU8(`<worksheet><sheetData><row r="1">${head}</row>${body}</sheetData></worksheet>`),
  };
  if (sharedStrings.length) files["xl/sharedStrings.xml"] = strToU8(`<sst>${sharedStrings.map((value) => `<si>${textXml(value)}</si>`).join("")}</sst>`);
  return zipSync(files);
}

export const AVISOS_XLSX_URL = "https://dados.gov.pt/s/resources/02-datasets-avisos-pt2030-30092026.xlsx";
export const AVISOS_NOW = new Date("2026-10-01T12:00:00.000Z");

export function wpItem(id = 1, acf: Record<string, unknown> = {}) {
  return {
    id, link: `https://acores.portugal2030.pt/aviso/${id}/`, modified: "2026-09-30T10:20:30",
    title: { rendered: "<p>Construir 2030 &#8211; Inovação &#038; emprego &amp; formação</p>" },
    acf: {
      codigo: `ACORES2030-PLANO-${id}`, programa: ["AÇORES2030"], fundo: ["FEDER"],
      objectivo: ["Inovação"], beneficiario: ["Privada"], df: 1500000,
      data_inicio: "2026-09-01", data_fim: "2026-10-31",
      pdf: "https://acores.portugal2030.pt/wp-content/uploads/x.pdf?token=SECRET",
      ...acf,
    },
  };
}

export function avisosXlsx(): Uint8Array {
  const line = (row: number, code: string, program: string, fund: string, objective: string, amount: number,
    status = "Aberto", title = "Inovação e formação"): XlsxRow => ({
    row, cells: [
      { column: "A", value: 46295 },
      ...Object.entries({ B: code, C: title, D: status, E: program, G: program, K: objective, N: fund })
        .map(([column, value]): XlsxCell => ({ column, type: "inlineStr", value })),
      { column: "P", value: amount },
    ],
  });
  return xlsxOf(XLSX_HEADERS, [
    line(2, "MPr-2023-1", "COMPETE2030", "FEDER", "Investigação", 10),
    line(3, "MPr-2023-1", "COMPETE2030", "FSE+", "Qualificação", 5),
    line(4, "MPr-2023-1", "ACORES2030", "FEDER", "Inovação", 2),
    line(5, "ACORES2030-2026-15", "ACORES2030", "FEDER", "Empreendedorismo", 25,
      "Aberto", "Construir 2030 - Pequenos Negócios"),
    line(6, "ACORES2030-2025-1", "ACORES2030", "FSE+", "Formação", 8, "Fechado"),
  ]);
}

type AvisosSourceOptions = {
  metadata?: unknown;
  xlsx?: Uint8Array;
  pages?: readonly unknown[];
};

// Não há recurso à rede: pedidos sem correspondência recebem 404.
export function avisosSource({ metadata, xlsx = avisosXlsx(), pages = [[wpItem()]] }: AvisosSourceOptions = {}) {
  const calls: string[] = [];
  const fetch = async (url: string): Promise<Response> => {
    calls.push(url);
    if (url === AVISOS_DATASET_API) {
      return Response.json(metadata === undefined ? {
        resources: [{ title: "02-datasets-avisos-pt2030-30092026.xlsx", url: AVISOS_XLSX_URL }],
      } : metadata);
    }
    if (url === AVISOS_XLSX_URL) return new Response(xlsx);
    const parsed = new URL(url);
    if (`${parsed.origin}${parsed.pathname}` === WP_API) {
      const page = pages[Number(parsed.searchParams.get("page")) - 1];
      if (page instanceof Response) return new Response(await page.clone().arrayBuffer(), { status: page.status, headers: page.headers });
      if (page !== undefined) return Response.json(page);
    }
    return new Response("Não encontrado", { status: 404 });
  };
  return { fetch, calls, http: createHttp({ allowedHosts: AVISOS_HOSTS, ttlMs: 0, fetch }) };
}

export function seededAvisosDb(path = ":memory:"): Database {
  const db = openAvisosWritableDb(path);
  const beneficiaries = [["Privada"], ["Pública"], ["Pública/Privada"], ["Pública", "Privada"]];
  const regional: AvisoRow[] = beneficiaries.map((beneficiary, i) => ({
    source: "acores2030_plano", code: `ACORES2030-PLANO-${i + 1}`, title: "Construir 2030 - Inovação",
    status: null, program: "AÇORES2030", program_search: normalizeKey("AÇORES2030"),
    funds: ["FEDER"], objectives: ["Inovação"], amount_eur: 1500000, beneficiary,
    starts_on: i === 3 ? null : "2026-09-01", ends_on: i === 3 ? null : "2026-10-31",
    snapshot_date: "2026-09-30", source_url: `https://acores.portugal2030.pt/aviso/${i + 1}/`,
  }));
  try {
    replaceAvisos(db, { pt2030_xlsx: parseAvisosXlsx(avisosXlsx(), AVISOS_XLSX_URL), acores2030_plano: regional },
      { xlsx_url: AVISOS_XLSX_URL }, AVISOS_NOW);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
