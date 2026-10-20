import { expect, test } from "bun:test";
import { strToU8, zipSync } from "fflate";
import { cleanTitle, decodeEntities, normalizeKey } from "../src/avisos/text";
import { excelSerialToIso, parseAvisosXlsx, readSheet, XLSX_HEADERS } from "../src/avisos/xlsx";
import { xlsxOf, type XlsxCell } from "./avisos-fixtures";

const SOURCE_URL = "https://dados.gov.pt/s/resources/02-datasets-avisos-pt2030-30092026.xlsx";
const HEADERS = [
  "Data", "Código do Aviso", "Designação do Aviso", "Estado do Aviso", "Código do Programa",
  "Designação do Programa", "Marca do Programa", "Código do Objetivo Estratégico", "Designação do Objetivo Estratégico",
  "Código do Objetivo Específico", "Sigla do Objetivo Específico", "Designação do Objetivo Específico",
  "Código do Fundo", "Sigla do Fundo", "Designação do Fundo", "Montante fundo colocado a concurso [1000€]",
  "Enquadramento", "Critérios de seleção",
] as const;
const REQUIRED = HEADERS.filter((_, index) => ![7, 8, 9, 12, 16, 17].includes(index));
const inline = (column: string, value: string): XlsxCell => ({ column, type: "inlineStr", value });
const parseCells = (cells: XlsxCell[]) => parseAvisosXlsx(xlsxOf(HEADERS, [{ row: 2, cells }]), SOURCE_URL);
const sheetXml = (xml: string, shared?: string) => zipSync({
  "xl/worksheets/sheet1.xml": strToU8(`<worksheet><sheetData>${xml}</sheetData></worksheet>`),
  ...(shared === undefined ? {} : { "xl/sharedStrings.xml": strToU8(`<sst>${shared}</sst>`) }),
});

test("normalizeKey remove acentos, espaços e pontuação e conserva letras ASCII e números", () => {
  for (const text of ["AÇORES2030", "Açores 2030", "Ac\u0327ores-2030"]) {
    expect(normalizeKey(text)).toBe("acores2030");
  }
  expect(normalizeKey("Pública/Privada")).toBe("publicaprivada");
  expect(normalizeKey("  _!?|% 日本 😀 ")).toBe("");
  expect(normalizeKey("")).toBe("");
});

test("decodeEntities descodifica entidades XML, decimais e hexadecimais numa só passagem", () => {
  expect(decodeEntities("&amp;&lt;&gt;&quot;&apos;&nbsp;")).toBe("&<>\"'\u00a0");
  expect(decodeEntities("&#8211; &#038; &#xE7; &#X1F600;")).toBe("– & ç 😀");
  expect(decodeEntities("&amp;lt; &amp;#65;")).toBe("&lt; &#65;");
  expect(decodeEntities("&#0; &#x10FFFF;")).toBe("\u0000 \u{10ffff}");
  expect(decodeEntities("texto sem entidades")).toBe("texto sem entidades");
});

test("decodeEntities conserva entidades desconhecidas e pontos de código inválidos", () => {
  const text = "&#1114112; &#x110000; &#55296; &#xDFFF; &#99999999999999999999999999; &#-1; &#xZZ; &outra; &amp";
  expect(decodeEntities(text)).toBe(text);
  expect(decodeEntities(`&#${"9".repeat(400)};`)).toBe(`&#${"9".repeat(400)};`);
});

test("cleanTitle remove HTML, descodifica entidades e normaliza espaços", () => {
  expect(cleanTitle(" <p>Açores&nbsp; <strong>2030</strong> &#8211; &#038; &amp;</p>\n ")).toBe("Açores 2030 – & &");
  expect(cleanTitle("A\u00a0\t\n B")).toBe("A B");
  expect(cleanTitle("&lt;texto&gt;")).toBe("<texto>");
  for (const text of ["", " \n\t", "<p> &nbsp; </p><br/>"]) expect(cleanTitle(text)).toBeNull();
});

test("readSheet localiza células pela referência, mesmo fora de ordem e além de Z", () => {
  const sheet = readSheet(xlsxOf([], [{ row: 7, cells: [
    inline("P", "fim"), { column: "B", type: "empty" }, inline("D", "depois"),
    { column: "E", type: "empty" }, inline("AA", "longe"), inline("C", ""),
  ] }]));
  expect(sheet.get(7)).toEqual(new Map([["P", "fim"], ["D", "depois"], ["AA", "longe"]]));
  expect(sheet.has(1)).toBe(false);
  expect(readSheet(xlsxOf(Array.from({ length: 28 }, (_, i) => String(i)), [])).get(1)?.get("AB")).toBe("27");
});

test("readSheet concatena texto simples e rico, ignora rPh e aceita xml:space", () => {
  const xml = '<t xml:space="preserve"> A &amp; </t><rPh sb="0" eb="1"><t>fonética</t></rPh>' +
    '<r><rPr><b/></rPr><t>&#8211; </t></r><rPh/><r><t>&#xE7;</t></r><t/><t>!</t>';
  const sheet = readSheet(xlsxOf([], [{ row: 2, cells: [
    { column: "A", type: "inlineStr", value: { xml } },
    { column: "B", type: "s", value: 0 },
    { column: "C", type: "s", value: 1 },
    { column: "D", type: "s", value: 2 },
  ] }], [{ xml }, "normal < > \" ' &", ""]));
  expect(sheet.get(2)).toEqual(new Map([["A", " A & – ç!"], ["B", " A & – ç!"], ["C", "normal < > \" ' &"]]));
});

test("readSheet lê valores numéricos, booleanos e texto de fórmulas sem avaliar fórmulas", () => {
  const sheet = readSheet(sheetXml('<row r="2">' +
    '<c r="A2"><v>001.2300</v></c><c r="B2" t="n"><v>46295</v></c>' +
    '<c r="C2" t="b"><v>0</v></c><c r="D2" t="b"><v>1</v></c>' +
    '<c r="E2" t="str"><f>IGNORAR()</f><v>&lt; &#65; &amp; &apos; &quot; &gt;</v></c>' +
    '<c r="F2"><v/></c><c r="G2"><f>IGNORAR()</f></c>' +
    '<c r="H2" t="inlineStr"><is/><extLst><t>ignorar</t></extLst></c>' +
    '<c r="I2" t="inlineStr"><is><t></t></is></c></row>'));
  expect(sheet.get(2)).toEqual(new Map([["A", "001.2300"], ["B", "46295"], ["C", "0"], ["D", "1"], ["E", '< A & \' " >']]));
});

test("readSheet conserva os índices quando há entradas sharedStrings vazias", () => {
  const sheet = readSheet(sheetXml('<c r="A2" t="s"><v>0</v></c><c r="B2" t="s"><v>1</v></c><c r="C2" t="s"><v>2</v></c>',
    '<si/><si><t/></si><si><t>terceira</t></si>'));
  expect(sheet.get(2)).toEqual(new Map([["C", "terceira"]]));
  expect(readSheet(sheetXml('<c r="A2" t="s"><v/></c><c r="B2" t="s"/><c r="C2" t="inlineStr"/>')).size).toBe(0);
  expect(readSheet(sheetXml('<c r="A2" t="inlineStr"><extLst><t>ignorar</t></extLst></c>')).size).toBe(0);
  expect(readSheet(sheetXml('<c r="A2" t="s"><v> 0 </v></c>', '<si><t>primeira</t></si>')).get(2)?.get("A")).toBe("primeira");
});

test("readSheet recusa índices sharedStrings inválidos indicando a célula", () => {
  for (const value of ["-1", "1.5", "NaN", "Infinity", "1x", "1", "9007199254740992"]) {
    expect(() => readSheet(xlsxOf([], [{ row: 8, cells: [{ column: "AC", type: "s", value }] }], ["única"])))
      .toThrow(/sharedStrings.*AC8/);
  }
  expect(() => readSheet(xlsxOf([], [{ row: 8, cells: [{ column: "AC", type: "s", value: 0 }] }])))
    .toThrow(/sharedStrings.*AC8/);
});

test("readSheet recusa ZIP inválido e folha ausente e ignora outras entradas", () => {
  expect(() => readSheet(new Uint8Array([1, 2, 3]))).toThrow(/XLSX/);
  expect(() => readSheet(zipSync({ "xl/worksheets/sheet2.xml": strToU8("<worksheet/>") })))
    .toThrow("O XLSX não tem a folha xl/worksheets/sheet1.xml");
  expect(readSheet(zipSync({
    "xl/worksheets/sheet1.xml": strToU8('<c r="A2"><v>7</v></c>'),
    "xl/worksheets/sheet2.xml": strToU8('<c r="A2" t="s"><v>999</v></c>'),
  })).get(2)?.get("A")).toBe("7");
});

test("readSheet recusa células sem referência válida e tipos não suportados", () => {
  for (const ref of ["", ' r="2"', ' r="A0"', ' r="A-1"', ' r="A9007199254740992"']) {
    expect(() => readSheet(sheetXml(`<c${ref}><v>1</v></c>`))).toThrow(/referência/);
  }
  expect(() => readSheet(sheetXml('<c r="B2" t="e"><v>#REF!</v></c>'))).toThrow(/tipo.*B2/);
  expect(readSheet(sheetXml("<c s='3' r='A2' t='str'><v>texto</v></c>")).get(2)?.get("A")).toBe("texto");
});

test("excelSerialToIso usa a época 1899-12-30 em UTC e ignora a hora", () => {
  expect(excelSerialToIso(46295)).toBe("2026-09-30");
  expect(excelSerialToIso(46295.75)).toBe("2026-09-30");
  expect(excelSerialToIso(0)).toBe("1899-12-30");
  expect(excelSerialToIso(-1)).toBe("1899-12-29");
  for (const n of [NaN, Infinity, -Infinity, Number.MAX_VALUE]) {
    expect(() => excelSerialToIso(n)).toThrow(/Data Excel inválida/);
  }
});

test("XLSX_HEADERS contém os 18 textos exatos da fonte", () => {
  expect(XLSX_HEADERS).toEqual(HEADERS);
});

test("parseAvisosXlsx mapeia todos os campos e converte milhares de euros a cêntimos", () => {
  expect(parseCells([
    { column: "A", value: 46295 }, inline("B", " MPr-2023-1 "), inline("C", " Inovação & ciência "),
    inline("D", " Aberto "), inline("E", " MPr "), inline("F", " Competitividade e Internacionalização "),
    inline("G", " COMPETE2030 "), inline("K", " RSO1.1 "), inline("L", " Investigação "),
    inline("N", " FEDER "), inline("O", " Fundo Europeu "), { column: "P", value: 1.234567 },
  ])).toEqual([{
    source: "pt2030_xlsx", code: "MPr-2023-1", title: "Inovação & ciência", status: "Aberto",
    program: "COMPETE2030", program_search: "mpr|competitividadeeinternacionalizacao|compete2030",
    funds: ["FEDER"], objectives: ["RSO1.1 - Investigação"], amount_eur: 1234.57,
    starts_on: null, ends_on: null, beneficiary: null, snapshot_date: "2026-09-30", source_url: SOURCE_URL,
  }]);
});

test("cabeçalhos mudam de coluna com lacunas e espaços sem deslocar dados", () => {
  const headers = [null, "extra", ...[...REQUIRED].reverse().map((h) => ` \n${h.replaceAll(" ", "  \t")} `)];
  const result = parseAvisosXlsx(xlsxOf(headers, [{ row: 2, cells: [
    { column: "A", type: "empty" }, inline("B", "ignorar"), { column: "C", value: "2,50055" },
    inline("D", "Fundo"), { column: "E", type: "empty" }, inline("F", "Objetivo"),
    inline("H", "AÇORES2030"), inline("K", "Fechado"), inline("L", "Título"),
    inline("M", "ACORES-1"), { column: "N", value: 46295 },
  ] }]), SOURCE_URL);
  expect(result[0]).toMatchObject({ code: "ACORES-1", title: "Título", status: "Fechado", program: "AÇORES2030",
    program_search: "acores2030", funds: ["Fundo"], objectives: ["Objetivo"], amount_eur: 2500.55, snapshot_date: "2026-09-30" });
});

test("todos os cabeçalhos obrigatórios em falta são nomeados no mesmo erro", () => {
  for (const header of REQUIRED) {
    expect(() => parseAvisosXlsx(xlsxOf(HEADERS.filter((h) => h !== header), []), SOURCE_URL))
      .toThrow(`O XLSX não tem a coluna "${header}"`);
  }
  let message = "";
  try { parseAvisosXlsx(xlsxOf([], []), SOURCE_URL); } catch (error) {
    expect(error).toBeInstanceOf(Error);
    message = (error as Error).message;
  }
  for (const header of REQUIRED) expect(message).toContain(`O XLSX não tem a coluna "${header}"`);
  expect(parseAvisosXlsx(xlsxOf(REQUIRED, []), SOURCE_URL)).toEqual([]);
});

test("campos ausentes ficam a null ou arrays vazios e não se inventa o montante zero", () => {
  expect(parseCells([inline("B", "A-1"), inline("C", "  "), inline("D", "\t"), inline("P", " ")])).toEqual([{
    source: "pt2030_xlsx", code: "A-1", title: null, status: null, program: null, program_search: "",
    funds: [], objectives: [], amount_eur: null, starts_on: null, ends_on: null, beneficiary: null,
    snapshot_date: null, source_url: SOURCE_URL,
  }]);
  expect(parseCells([inline("B", "A-1")])[0]?.amount_eur).toBeNull();
});

test("programa, fundo e objetivo usam as partes disponíveis sem separadores vazios", () => {
  expect(parseCells([inline("B", "A-1"), inline("E", "ACORES"), inline("F", "Açores 2030"), inline("O", "Fundo"), inline("L", "Objetivo")])[0])
    .toMatchObject({ program: "Açores 2030", program_search: "acores|acores2030", funds: ["Fundo"], objectives: ["Objetivo"] });
  expect(parseCells([inline("B", "A-1"), inline("E", "ACORES"), inline("K", "OE1")])[0])
    .toMatchObject({ program: "ACORES", program_search: "acores", objectives: ["OE1"] });
});

test("montantes aceitam vírgula, zero e negativos e recusam valores não finitos com a referência", () => {
  for (const [value, expected] of [["1,234567", 1234.57], ["0", 0], ["-2.5", -2500], ["1e2", 100000]] as const) {
    expect(parseCells([inline("B", "A-1"), inline("P", value)])[0]?.amount_eur).toBe(expected);
  }
  for (const value of ["NaN", "Infinity", "-Infinity", "dois", "1,2,3", "1e308"]) {
    expect(() => parseCells([inline("B", "A-1"), inline("P", value)])).toThrow(/montante.*P2/i);
  }
});

test("datas aceitam série Excel ou prefixo ISO e erros nomeiam a célula", () => {
  for (const value of ["2026-09-30", "2026-09-30T12:00:00Z", " 46295.5 "]) {
    expect(parseCells([inline("B", "A-1"), inline("A", value)])[0]?.snapshot_date).toBe("2026-09-30");
  }
  for (const value of ["30/09/2026", "ontem", "NaN", "Infinity", "1e308"]) {
    expect(() => parseCells([inline("B", "A-1"), inline("A", value)])).toThrow(/data.*A2/i);
  }
});

test("linhas vazias são ignoradas, mas uma linha preenchida sem código falha com o seu número", () => {
  expect(parseAvisosXlsx(xlsxOf(HEADERS, [{ row: 2, cells: [] }, { row: 3, cells: [{ column: "B", type: "empty" }] }]), SOURCE_URL)).toEqual([]);
  for (const cells of [[inline("C", "Sem código")], [inline("B", "  ")], [inline("Z", "Extra")]]) {
    expect(() => parseAvisosXlsx(xlsxOf(HEADERS, [{ row: 17, cells }]), SOURCE_URL)).toThrow(/linha 17.*Código do Aviso/);
  }
});

test("linhas repartidas por fundo ou programa mantêm o seu grão e montante", () => {
  const rows = parseAvisosXlsx(xlsxOf(HEADERS, [
    { row: 2, cells: [inline("B", "MPr-2023-1"), inline("G", "COMPETE2030"), inline("N", "FEDER"), { column: "P", value: 10 }] },
    { row: 3, cells: [inline("B", "MPr-2023-1"), inline("G", "COMPETE2030"), inline("N", "FSE+"), { column: "P", value: 5 }] },
    { row: 4, cells: [inline("B", "MPr-2023-1"), inline("G", "ACORES2030"), inline("N", "FEDER"), { column: "P", value: 2 }] },
  ]), SOURCE_URL);
  expect(rows).toHaveLength(3);
  expect(rows.map((r) => [r.program, r.amount_eur])).toEqual([["COMPETE2030", 10000], ["COMPETE2030", 5000], ["ACORES2030", 2000]]);
  expect(rows.reduce((sum, r) => sum + (r.amount_eur ?? 0), 0)).toBe(17000);
});

test("colunas não usadas e entradas ZIP alheias não entram nos avisos", () => {
  const secret = "https://acores.portugal2030.pt/x.pdf?token=SECRET";
  const rows = parseCells([inline("B", "A-1"), ...["H", "I", "J", "M", "Q", "R", "S"].map((column) => inline(column, secret))]);
  expect(rows).toHaveLength(1);
  expect(JSON.stringify(rows)).not.toContain("token=SECRET");
  expect(rows[0]).toMatchObject({ funds: [], objectives: [], program: null });
});
