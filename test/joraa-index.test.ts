import { expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as unpdf from "unpdf";
import { journalPdfUrl, parseIndex, type JournalIndex } from "../src/joraa/index";
import { extractFirstPageText } from "../src/joraa/pdf-text";

const texto001 = `
       ÍNDICE    SEGUNDA-FEIRA, 5 DE JANEIRO DE 2026
                                                                                           1
                                                    I SÉRIE
                                                    NÚMERO 1
                                                    Secretaria Regional do Ambiente e Ação
                                                    Climática
                                                    Portaria n.º 1/2026 de 5 de janeiro de 2026
                                                    Aprova o cartão de identificação profissional e de livre-
                                                    trânsito em formato digital dos dirigentes e do pessoal de
                                                    inspeção da Inspeção Regional do Ambiente. Revoga a
                                                    Portaria n.º 39/2022, de 1 de junho.
         PRESIDÊNCIA DO GOVERNO REGIONAL DOS AÇORES   CENTRO DE EDIÇÃO DO JORNAL OFICIAL   HTTP://JO.AZORES.GOV.PT   CEJO@AZORES.GOV.PT
`.split("\n").map((line) => line.trim()).join("\n").trim();

const texto132 = `
       ÍNDICE   SEGUNDA-FEIRA, 19 DE OUTUBRO DE 2026
                                                                                           3923
                                                    I SÉRIE
                                                    NÚMERO 132
                                                    Secretaria Regional das Finanças,
                                                    Planeamento e Administração Pública,
                                                    Secretaria Regional da Agricultura e
                                                    Alimentação e Secretaria Regional do
                                                    Ambiente e Ação Climática
                                                    Portaria n.º 113/2026 de 19 de outubro de 2026
                                                    Aprova a delimitação da Reserva Ecológica do concelho
                                                    da Povoação.
         PRESIDÊNCIA DO GOVERNO REGIONAL DOS AÇORES   CENTRO DE EDIÇÃO DO JORNAL OFICIAL   HTTP://JO.AZORES.GOV.PT   CEJO@AZORES.GOV.PT
`.split("\n").map((line) => line.trim()).join("\n").trim();

const texto200 = `
        ÍNDICE     SEGUNDA-FEIRA, 19 DE OUTUBRO DE 2026
                                                                                                         16821
                                                            II SÉRIE
                                                            NÚMERO 200
                                                            Presidência do Governo
                                                            Despacho n.º 2419/2026 de 19 de outubro de 2026
                                                            Apoio financeiro - Associação Sindical dos Juízes
                                                            Portugueses (ASJP).
                                                            Presidência do Governo e Junta de Freguesia
                                                            de Santo Espírito
                                                            Acordo de cooperação n.º 58/2026 de 19 de outubro
                                                            de 2026
                                                            Aquisição de equipamentos.
                                                            Presidência do Governo e Junta de Freguesia
                                                            de Achadinha
                                                            Acordo de cooperação n.º 59/2026 de 19 de outubro
                                                            de 2026
                                                            Aquisição de equipamento informático.
                                                            Acordo de cooperação n.º 60/2026 de 19 de outubro
                                                            de 2026
                                                            Aquisição de papeleiras.
                                                            Presidência do Governo e Junta de Freguesia
                                                            de Algarvia
                                                            Acordo de cooperação n.º 61/2026 de 19 de outubro
                                                            de 2026
                                                            Aquisição de cadeiras.
                                                            Acordo de cooperação n.º 62/2026 de 19 de outubro
                                                            de 2026
                                                            Aquisição de colchões.
                                                            Acordo de cooperação n.º 63/2026 de 19 de outubro
                                                            de 2026
                                                            Aquisição de lençóis e mantas.
                                                            Acordo de cooperação n.º 64/2026 de 19 de outubro
                                                            de 2026
                                                            Pintura de edifícios públicos da freguesia.
                                                            Vice-Presidência do Governo Regional
          PRESIDÊNCIA DO GOVERNO REGIONAL DOS AÇORES   CENTRO DE EDIÇÃO DO JORNAL OFICIAL   HTTP://JO.AZORES.GOV.PT   CEJO@AZORES.GOV.PT
`.split("\n").map((line) => line.trim()).join("\n").trim();

const esperado001: JournalIndex = {
  serie: "I", numero: 1, data: "2026-01-05", suplemento: null,
  entries: [{
    entidade: "Secretaria Regional do Ambiente e Ação Climática",
    tipo: "Portaria", numeroAto: "1/2026", dataAto: "2026-01-05",
    sumario: "Aprova o cartão de identificação profissional e de livre-trânsito em formato digital dos dirigentes e do pessoal de inspeção da Inspeção Regional do Ambiente. Revoga a Portaria n.º 39/2022, de 1 de junho.",
  }],
};

const esperado132: JournalIndex = {
  serie: "I", numero: 132, data: "2026-10-19", suplemento: null,
  entries: [{
    entidade: "Secretaria Regional das Finanças, Planeamento e Administração Pública, Secretaria Regional da Agricultura e Alimentação e Secretaria Regional do Ambiente e Ação Climática",
    tipo: "Portaria", numeroAto: "113/2026", dataAto: "2026-10-19",
    sumario: "Aprova a delimitação da Reserva Ecológica do concelho da Povoação.",
  }],
};

const esperado200: JournalIndex = {
  serie: "II", numero: 200, data: "2026-10-19", suplemento: null,
  entries: [
    {
      entidade: "Presidência do Governo", tipo: "Despacho", numeroAto: "2419/2026", dataAto: "2026-10-19",
      sumario: "Apoio financeiro - Associação Sindical dos Juízes Portugueses (ASJP).",
    },
    {
      entidade: "Presidência do Governo e Junta de Freguesia de Santo Espírito",
      tipo: "Acordo de cooperação", numeroAto: "58/2026", dataAto: "2026-10-19", sumario: "Aquisição de equipamentos.",
    },
    {
      entidade: "Presidência do Governo e Junta de Freguesia de Achadinha",
      tipo: "Acordo de cooperação", numeroAto: "59/2026", dataAto: "2026-10-19", sumario: "Aquisição de equipamento informático.",
    },
    {
      entidade: "Presidência do Governo e Junta de Freguesia de Achadinha",
      tipo: "Acordo de cooperação", numeroAto: "60/2026", dataAto: "2026-10-19", sumario: "Aquisição de papeleiras.",
    },
    {
      entidade: "Presidência do Governo e Junta de Freguesia de Algarvia",
      tipo: "Acordo de cooperação", numeroAto: "61/2026", dataAto: "2026-10-19", sumario: "Aquisição de cadeiras.",
    },
    {
      entidade: "Presidência do Governo e Junta de Freguesia de Algarvia",
      tipo: "Acordo de cooperação", numeroAto: "62/2026", dataAto: "2026-10-19", sumario: "Aquisição de colchões.",
    },
    {
      entidade: "Presidência do Governo e Junta de Freguesia de Algarvia",
      tipo: "Acordo de cooperação", numeroAto: "63/2026", dataAto: "2026-10-19", sumario: "Aquisição de lençóis e mantas.",
    },
    {
      entidade: "Presidência do Governo e Junta de Freguesia de Algarvia",
      tipo: "Acordo de cooperação", numeroAto: "64/2026", dataAto: "2026-10-19", sumario: "Pintura de edifícios públicos da freguesia.",
    },
  ],
};

for (const [ficheiro, texto, esperado] of [
  ["I-2026-001-S0.p1.pdf", texto001, esperado001],
  ["I-2026-132-S0.p1.pdf", texto132, esperado132],
  ["II-2026-200-S0.p1.pdf", texto200, esperado200],
] as const) {
  test(`extrai e interpreta todos os campos do PDF ${ficheiro}`, async () => {
    const textoExtraido = await extractFirstPageText(readFileSync(`${import.meta.dir}/fixtures/joraa/${ficheiro}`));
    expect(textoExtraido).toContain("\n\n");
    expect(parseIndex(textoExtraido)).toEqual(esperado);
  });

  test(`interpreta todos os campos do texto Ghostscript de ${ficheiro}`, () => {
    expect(parseIndex(texto)).toEqual(esperado);
  });
}

test("mantém a referência à portaria revogada dentro do único sumário", () => {
  const resultado = parseIndex(texto001);
  expect(resultado.entries).toHaveLength(1);
  expect(resultado.entries[0]?.sumario).toContain("Portaria n.º 39/2022, de 1 de junho.");
});

const vazio: JournalIndex = { serie: null, numero: null, data: null, suplemento: null, entries: [] };

test("devolve campos nulos e nenhuma entrada para texto vazio ou sem dados", () => {
  for (const texto of ["", " \t\n\r\n ", "texto aleatório !? 123", "ÍNDICE", "\u0000\ufffd💧"]) {
    expect(parseIndex(texto)).toEqual(vazio);
  }
  expect(parseIndex("ÍNDICE SEGUNDA-FEIRA, 5 DE JANEIRO DE 2026")).toEqual({ ...vazio, data: "2026-01-05" });
});

test("conserva o tipo e o número quando a data do ato não é válida", () => {
  for (const data of ["data desconhecida", "31 de fevereiro de 2026", "1 de mês de 2026", "1 de janeiro de 26"]) {
    expect(parseIndex(`Despacho n.º 2/2026 de ${data}`).entries).toEqual([
      { entidade: null, tipo: "Despacho", numeroAto: "2/2026", dataAto: null, sumario: null },
    ]);
  }
});

test("constrói endereços sem truncar números e usa suplemento zero por omissão", () => {
  expect(journalPdfUrl("I", 2026, 132, 0)).toBe("https://jo.azores.gov.pt/pdf/jornais/I-2026-132-S0.pdf");
  expect(journalPdfUrl("II", 2026, 7, 1)).toBe("https://jo.azores.gov.pt/pdf/jornais/II-2026-007-S1.pdf");
  expect(journalPdfUrl("I", 2026, 1)).toBe("https://jo.azores.gov.pt/pdf/jornais/I-2026-001-S0.pdf");
  expect(journalPdfUrl("II", 2026, 1000)).toBe("https://jo.azores.gov.pt/pdf/jornais/II-2026-1000-S0.pdf");
});

test("recusa parâmetros numéricos inválidos no endereço", () => {
  for (const ano of [999, 10000, 2026.5, NaN, Infinity]) {
    expect(() => journalPdfUrl("I", ano, 1)).toThrow(RangeError);
  }
  for (const numero of [0, -1, 1.5, NaN, Infinity]) {
    expect(() => journalPdfUrl("I", 2026, numero)).toThrow(RangeError);
  }
  for (const suplemento of [-1, 0.5, NaN, Infinity]) {
    expect(() => journalPdfUrl("I", 2026, 1, suplemento)).toThrow(RangeError);
  }
});

test("recusa bytes que não representam um PDF", async () => {
  await expect(extractFirstPageText(new TextEncoder().encode("não é um PDF"))).rejects.toThrow("primeira página do PDF");
});

test("interpreta os doze meses em maiúsculas e minúsculas, incluindo março", () => {
  const meses = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
  for (const [indice, mes] of meses.entries()) {
    const data = `2026-${String(indice + 1).padStart(2, "0")}-01`;
    for (const nome of [mes, mes.toUpperCase()]) {
      const resultado = parseIndex(`ÍNDICE DOMINGO, 1 DE ${nome} DE 2026\nPortaria n.º 1/2026 de 1 de ${nome} de 2026`);
      expect(resultado.data).toBe(data);
      expect(resultado.entries[0]?.dataAto).toBe(data);
    }
  }
});

test("valida os limites dos dias e os anos bissextos sem normalizar datas inválidas", () => {
  for (const [data, iso] of [
    ["29 de fevereiro de 2024", "2024-02-29"],
    ["29 de fevereiro de 2026", null],
    ["0 de janeiro de 2026", null],
    ["32 de janeiro de 2026", null],
    ["31 de abril de 2026", null],
    ["1 de desconhecido de 2026", null],
  ] as const) {
    expect(parseIndex(`ÍNDICE DOMINGO, ${data}`).data).toBe(iso);
    expect(parseIndex(`Portaria n.º 1/2026 de ${data}`).entries[0]?.dataAto).toBe(iso);
  }
});

test("só atribui suplemento quando existe uma indicação explícita", () => {
  expect(parseIndex("SUPLEMENTO")).toEqual({ ...vazio, suplemento: 1 });
  expect(parseIndex("3.º SUPLEMENTO")).toEqual({ ...vazio, suplemento: 3 });
  expect(parseIndex("NÚMERO 1\nI SÉRIE")).toEqual({ ...vazio, numero: 1, serie: "I" });
  expect(parseIndex("NÚMERO 999999999999999999999999\n999999999999999999999999.º SUPLEMENTO")).toEqual(vazio);
});

test("ignora ruído em qualquer posição e normaliza espaços e mudanças de linha", () => {
  const texto = "JO.AZORES.GOV.PT\r\n42\r\nÍNDICE SEGUNDA-FEIRA, 5 DE JANEIRO DE 2026 1\r\nI SÉRIE\rNÚMERO 1\rEntidade   Regional\r\nPortaria n.º 1/2026 de 5 de janeiro de 2026\r\nCENTRO DE EDIÇÃO DO JORNAL OFICIAL\r\nTexto\tcom espaços.\r\n99";
  expect(parseIndex(texto)).toEqual({
    serie: "I", numero: 1, data: "2026-01-05", suplemento: null,
    entries: [{ entidade: "Entidade Regional", tipo: "Portaria", numeroAto: "1/2026", dataAto: "2026-01-05", sumario: "Texto com espaços." }],
  });
});

test("preserva campos ausentes, a herança e o cabeçalho final sem criar atos", () => {
  for (const separador of ["\n", "\n\n"]) {
    const texto = [
      "Despacho n.º 1/2026 de 1 de março de 2026", "Entidade Regional",
      "Portaria n.º 2/2026", "Resumo sem ponto final",
      "Portaria n.º 3/2026 de 2 de março de 2026", "Termina aqui.", "Outra Entidade",
    ].join(separador);
    // Sem ponto final, o texto simples ainda não permite identificar um cabeçalho.
    expect(parseIndex(texto).entries).toEqual([
      { entidade: null, tipo: "Despacho", numeroAto: "1/2026", dataAto: "2026-03-01", sumario: "Entidade Regional" },
      { entidade: null, tipo: "Portaria", numeroAto: "2/2026", dataAto: null, sumario: "Resumo sem ponto final" },
      { entidade: null, tipo: "Portaria", numeroAto: "3/2026", dataAto: "2026-03-02", sumario: "Termina aqui." },
    ]);
  }
  expect(parseIndex("Entidade sem atos")).toEqual(vazio);
});

test("reconhece o número de diploma regional com sufixo de região", () => {
  for (const separador of ["\n", "\n\n"]) {
    const texto = ["Assembleia Legislativa da Região Autónoma dos Açores", "Decreto Legislativo Regional n.º 12/2026/A de 3 de junho de 2026", "Aprova o regime.", "Outra Entidade", "Portaria n.º 5/2026 de 4 de junho de 2026", "Fixa valores."].join(separador);
    expect(parseIndex(texto).entries).toEqual([
      { entidade: "Assembleia Legislativa da Região Autónoma dos Açores", tipo: "Decreto Legislativo Regional", numeroAto: "12/2026/A", dataAto: "2026-06-03", sumario: "Aprova o regime." },
      { entidade: "Outra Entidade", tipo: "Portaria", numeroAto: "5/2026", dataAto: "2026-06-04", sumario: "Fixa valores." },
    ]);
  }
});

test("mantém inteiro um sumário em bloco com uma linha intermédia terminada em ponto", () => {
  expect(parseIndex("Entidade\n\nPortaria n.º 1/2026 de 1 de março de 2026\n\nPrimeira frase.\nSegunda frase.\n\nOutra Entidade").entries).toEqual([
    { entidade: "Entidade", tipo: "Portaria", numeroAto: "1/2026", dataAto: "2026-03-01", sumario: "Primeira frase. Segunda frase." },
  ]);
});

test("não trata como ato um sumário que cita outro diploma e termina em ponto", () => {
  for (const separador of ["\n", "\n\n"]) {
    const texto = ["Entidade", "Portaria n.º 1/2026 de 1 de março de 2026", "Revoga a", "Portaria n.º 39/2022 de 1 de junho de 2022."].join(separador);
    expect(parseIndex(texto).entries).toHaveLength(1);
  }
  expect(parseIndex("Entidade\n\nPortaria n.º 1/2026 de 1 de março de 2026\n\nAltera o Decreto n.º 1/2020 de 3 de maio de 2020.").entries).toEqual([
    { entidade: "Entidade", tipo: "Portaria", numeroAto: "1/2026", dataAto: "2026-03-01", sumario: "Altera o Decreto n.º 1/2020 de 3 de maio de 2020." },
  ]);
});

test("conserva hífenes na junção e referências dentro de blocos", () => {
  expect(parseIndex("Entidade\nRegional\n\nPortaria n.º 1/2026 de 1 de março de 2026\n\nLivre-\ntrânsito - acesso.\nPortaria n.º 39/2022, de 1 de junho.").entries).toEqual([
    { entidade: "Entidade Regional", tipo: "Portaria", numeroAto: "1/2026", dataAto: "2026-03-01", sumario: "Livre-trânsito - acesso. Portaria n.º 39/2022, de 1 de junho." },
  ]);
});

function criarPdf(paginas: string[]): Uint8Array {
  const objetos = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${paginas.map((_, i) => `${4 + i * 2} 0 R`).join(" ")}] /Count ${paginas.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  for (const [indice, conteudo] of paginas.entries()) {
    objetos.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + indice * 2} 0 R >>`,
      `<< /Length ${conteudo.length} >>\nstream\n${conteudo}\nendstream`,
    );
  }
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [indice, objeto] of objetos.entries()) {
    offsets.push(pdf.length);
    pdf += `${indice + 1} 0 obj\n${objeto}\nendobj\n`;
  }
  const inicio = pdf.length;
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${inicio}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

test("extrai apenas a primeira página e aceita ArrayBuffer sem alterar os bytes", async () => {
  const pdf = criarPdf(["BT /F1 10 Tf 10 700 Td (Primeira pagina) Tj ET", "BT /F1 10 Tf 10 700 Td (Segunda pagina) Tj ET"]);
  const copia = pdf.slice();
  expect(await extractFirstPageText(pdf)).toBe("Primeira pagina");
  expect(await extractFirstPageText(new Uint8Array(pdf).buffer)).toBe("Primeira pagina");
  expect(pdf).toEqual(copia);
});

test("ordena fragmentos por coordenadas, agrupa linhas e respeita o limite vertical", async () => {
  const pdf = criarPdf([[
    "BT /F1 10 Tf 1 0 0 1 60 700 Tm (direita) Tj ET",
    "BT /F1 10 Tf 1 0 0 1 10 701 Tm (esquerda) Tj ET",
    "BT /F1 10 Tf 1 0 0 1 10 684 Tm (abaixo) Tj ET",
    "BT /F1 10 Tf 1 0 0 1 10 666.5 Tm (limite) Tj ET",
    "BT /F1 10 Tf 1 0 0 1 10 648 Tm (novo   bloco) Tj ET",
    "BT /F1 10 Tf 1 0 0 1 10 600 Tm (   ) Tj ET",
  ].join("\n")]);
  expect(await extractFirstPageText(pdf)).toBe("esquerda direita\nabaixo\nlimite\n\nnovo bloco");
});

test("usa a maior altura da linha para decidir a separação entre blocos", async () => {
  const pdf = criarPdf([[
    "BT /F1 5 Tf 1 0 0 1 10 700 Tm (pequeno) Tj ET",
    "BT /F1 12 Tf 1 0 0 1 80 700 Tm (grande) Tj ET",
    "BT /F1 12 Tf 1 0 0 1 10 680 Tm (seguinte) Tj ET",
  ].join("\n")]);
  expect(await extractFirstPageText(pdf)).toBe("pequeno grande\nseguinte");
  expect(await extractFirstPageText(criarPdf([""]))).toBe("");
});

test("separa blocos quando muda o corpo de letra, mesmo com pouco espaço vertical", async () => {
  const pdf = criarPdf([[
    "BT /F1 10 Tf 1 0 0 1 10 700 Tm (sumario) Tj ET",
    "BT /F1 12 Tf 1 0 0 1 10 685 Tm (entidade) Tj ET",
    "BT /F1 12 Tf 1 0 0 1 10 670 Tm (continua) Tj ET",
  ].join("\n")]);
  expect(await extractFirstPageText(pdf)).toBe("sumario\n\nentidade\ncontinua");
});

test("comunica a ausência de páginas e liberta o documento em caso de erro", async () => {
  const documento = await unpdf.getDocumentProxy(criarPdf([""]));
  const substituicao = spyOn(unpdf, "getDocumentProxy").mockResolvedValue(documento);
  try {
    Object.defineProperty(documento, "numPages", { value: 0 });
    await expect(extractFirstPageText(new Uint8Array())).rejects.toThrow("O PDF não contém páginas");
    expect(documento.loadingTask.destroyed).toBe(true);
  } finally {
    substituicao.mockRestore();
    await documento.loadingTask.destroy();
  }
});

test("liberta o documento depois de uma extração bem sucedida", async () => {
  const documento = await unpdf.getDocumentProxy(criarPdf([""]));
  const substituicao = spyOn(unpdf, "getDocumentProxy").mockResolvedValue(documento);
  try {
    expect(await extractFirstPageText(new Uint8Array())).toBe("");
    expect(documento.loadingTask.destroyed).toBe(true);
  } finally {
    substituicao.mockRestore();
    await documento.loadingTask.destroy();
  }
});

test("mantém o contexto e liberta o documento quando a leitura da página falha", async () => {
  const documento = await unpdf.getDocumentProxy(criarPdf([""]));
  const substituicao = spyOn(unpdf, "getDocumentProxy").mockResolvedValue(documento);
  const leitura = spyOn(documento, "getPage").mockRejectedValue("falha de leitura");
  try {
    await expect(extractFirstPageText(new Uint8Array())).rejects.toThrow("primeira página do PDF: falha de leitura");
    expect(documento.loadingTask.destroyed).toBe(true);
  } finally {
    leitura.mockRestore();
    substituicao.mockRestore();
    await documento.loadingTask.destroy();
  }
});

test("recusa coordenadas de texto inválidas e liberta o documento", async () => {
  const documento = await unpdf.getDocumentProxy(criarPdf(["BT /F1 10 Tf 10 700 Td (Texto) Tj ET"]));
  const pagina = await documento.getPage(1);
  const conteudo = await pagina.getTextContent();
  for (const item of conteudo.items) {
    if ("str" in item) item.transform[4] = "inválido";
  }
  const substituicao = spyOn(unpdf, "getDocumentProxy").mockResolvedValue(documento);
  const leitura = spyOn(pagina, "getTextContent").mockResolvedValue(conteudo);
  const acesso = spyOn(documento, "getPage").mockResolvedValue(pagina);
  try {
    await expect(extractFirstPageText(new Uint8Array())).rejects.toThrow("Coordenadas de texto inválidas");
    expect(documento.loadingTask.destroyed).toBe(true);
  } finally {
    acesso.mockRestore();
    leitura.mockRestore();
    substituicao.mockRestore();
    await documento.loadingTask.destroy();
  }
});
