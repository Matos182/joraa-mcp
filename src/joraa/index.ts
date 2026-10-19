export type IndexEntry = {
  entidade: string | null;
  tipo: string | null;
  numeroAto: string | null;
  dataAto: string | null;
  sumario: string | null;
};

export type JournalIndex = {
  serie: "I" | "II" | null;
  numero: number | null;
  data: string | null;
  suplemento: number | null;
  entries: IndexEntry[];
};

const months = [
  "janeiro", "fevereiro", "março", "abril", "maio", "junho",
  "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
];

function parseDate(text: string): string | null {
  const match = /^(\d{1,2}) de (\p{L}+) de (\d{4})$/iu.exec(text);
  if (!match) return null;
  const day = Number(match[1]);
  const month = months.indexOf(match[2]!.toLowerCase()) + 1;
  const year = Number(match[3]);
  if (!month || day < 1) return null;
  const date = new Date(`${match[3]}-${String(month).padStart(2, "0")}-01T00:00:00Z`);
  date.setUTCDate(day);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month) return null;
  return `${match[3]}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function joinLines(lines: string[]): string {
  return lines.reduce((text, line) => text + (text && !/\p{L}-$/u.test(text) ? " " : "") + line, "");
}

function parseAct(text: string): IndexEntry | null {
  // Os diplomas regionais têm sufixo de região (por exemplo, 1/2026/A).
  // A vírgula após o número, ou o ponto final, distingue uma referência no sumário de um novo ato.
  const match = /^(.+?) n\.º (\d+\/\d{4}(?:\/[A-Z])?)(?: de (.+))?$/u.exec(text);
  if (!match || text.endsWith(".")) return null;
  return {
    entidade: null, tipo: match[1]!, numeroAto: match[2]!,
    dataAto: parseDate(match[3] ?? ""), sumario: null,
  };
}

export function parseIndex(text: string): JournalIndex {
  const result: JournalIndex = { serie: null, numero: null, data: null, suplemento: null, entries: [] };
  const body: string[] = [];
  for (const raw of text.split(/\r\n?|\n/u)) {
    const line = raw.replace(/\s+/gu, " ").trim();
    if (/^ÍNDICE\b/iu.test(line)) {
      const date = /,\s*(\d{1,2} de \p{L}+ de \d{4})\b/iu.exec(line);
      if (date) result.data = parseDate(date[1]!);
    } else if (/CENTRO DE EDIÇÃO DO JORNAL OFICIAL|JO\.AZORES\.GOV\.PT/iu.test(line) || /^\d+$/u.test(line)) {
      continue;
    } else if (/^(I|II) SÉRIE$/u.test(line)) {
      result.serie = line.startsWith("II ") ? "II" : "I";
    } else if (/^NÚMERO \d+$/u.test(line)) {
      const number = Number(line.slice(7));
      result.numero = Number.isSafeInteger(number) ? number : null;
    } else if (/^(?:\d+\.º )?SUPLEMENTO$/iu.test(line)) {
      const number = line.toUpperCase() === "SUPLEMENTO" ? 1 : Number(line.split(".")[0]);
      result.suplemento = Number.isSafeInteger(number) ? number : null;
    } else {
      body.push(line);
    }
  }

  const bodyText = body.join("\n").trim();
  if (!bodyText) return result;
  const blocks = /\n\s*\n/u.test(bodyText);
  const units = blocks
    ? bodyText.split(/\n\s*\n/u).map((block) => joinLines(block.split("\n")))
    : bodyText.split("\n");
  let entity: string | null = null;
  let heading: string[] = [];
  let current: IndexEntry | null = null;
  let summary: string[] = [];
  let readingSummary = false;

  for (let i = 0; i < units.length; i++) {
    let unit = units[i]!;
    let act = parseAct(unit);
    if (!blocks && act && /^de \d{4}$/u.test(units[i + 1] ?? "")) {
      unit = joinLines([unit, units[++i]!]);
      act = parseAct(unit);
    }
    if (act) {
      if (heading.length) entity = joinLines(heading);
      act.entidade = entity;
      result.entries.push(act);
      current = act;
      heading = [];
      summary = [];
      readingSummary = true;
    } else if (readingSummary && current) {
      summary.push(unit);
      current.sumario = joinLines(summary);
      if (blocks || unit.endsWith(".")) readingSummary = false;
    } else {
      heading.push(unit);
    }
  }
  return result;
}

export function journalPdfUrl(serie: "I" | "II", ano: number, numero: number, suplemento = 0): string {
  if (!Number.isInteger(ano) || ano < 1000 || ano > 9999) throw new RangeError("O ano deve ter quatro algarismos.");
  if (!Number.isInteger(numero) || numero < 1) throw new RangeError("O número do jornal deve ser um inteiro positivo.");
  if (!Number.isInteger(suplemento) || suplemento < 0) throw new RangeError("O suplemento deve ser um inteiro não negativo.");
  return `https://jo.azores.gov.pt/pdf/jornais/${serie}-${ano}-${String(numero).padStart(3, "0")}-S${suplemento}.pdf`;
}
