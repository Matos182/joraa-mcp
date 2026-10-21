import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError, type GetPromptResult, type ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import type { Database } from "bun:sqlite";
import { z } from "zod";
import pkg from "../package.json";
import { countAvisos, getAvisosMeta } from "./avisos/db";
import { searchAvisos } from "./avisos/search";
import { normalizeKey } from "./avisos/text";
import type { AvisoResult } from "./avisos/types";
import type { Contract } from "./contracts/base";
import { countContracts, getMeta, listIngestedYears } from "./contracts/db";
import { MAX_TERMS, MIN_TERM_LENGTH, searchContracts } from "./contracts/search";

// Data de hoje nos Açores (AAAA-MM-DD); o fuso trata da hora de verão.
export function todayInAzores(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Atlantic/Azores" }).format(now);
}

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Data no formato AAAA-MM-DD");

const BENEFICIARIES = new Set(["publica", "privada"]);

// Palavras de ligação que, como prefixo FTS, apanhariam quase qualquer objeto de contrato.
const STOPWORDS = new Set([
  "a", "à", "às", "ao", "aos", "as", "o", "os", "um", "uma", "uns", "umas", "e", "ou", "de", "da", "das", "do", "dos",
  "em", "na", "nas", "no", "nos", "para", "por", "pela", "pelas", "pelo", "pelos", "com", "sem", "sob", "entre",
]);

// Lista de pesquisas do mapa_mercado: sem palavras de ligação, sem repetidos, no máximo MAX_TERMS.
export function marketWords(tema: string, palavras?: string): string[] {
  const raw = palavras === undefined
    ? (tema.match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => [...w].length >= MIN_TERM_LENGTH && !STOPWORDS.has(w.toLowerCase()))
    : palavras.split(",").map((w) => w.trim()).filter(Boolean);
  const seen = new Set<string>();
  return raw.filter((w) => !seen.has(w.toLowerCase()) && seen.add(w.toLowerCase())).slice(0, MAX_TERMS);
}

function assertRange(desde?: string, ate?: string): void {
  if (desde !== undefined && ate !== undefined && desde > ate) {
    throw new McpError(ErrorCode.InvalidParams, "desde é posterior a ate");
  }
}

// Resumo em texto para quem não lê structuredContent. Nunca repete o resultado inteiro.
const SUMMARY_LINES = 10;

export function summarize(results: Contract[], lastIngest: string | null): string {
  const head = `${results.length} contrato(s) encontrado(s)${lastIngest ? `; índice atualizado em ${lastIngest}` : ""}. ` +
    "Os dados completos estão em structuredContent.";
  const lines = results.slice(0, SUMMARY_LINES).map((c) => {
    const object = c.object && c.object.length > 80 ? `${c.object.slice(0, 79)}…` : c.object;
    const value = c.value_eur === null ? "valor n/d" : `${c.value_eur} EUR`;
    return `- ${c.signed_on ?? "sem data"} · ${c.entity ?? "entidade n/d"} · ${object ?? "objeto n/d"} · ${value} · ${c.source_url}`;
  });
  const more = results.length > SUMMARY_LINES ? [`(+${results.length - SUMMARY_LINES} em structuredContent)`] : [];
  return [head, ...lines, ...more].join("\n");
}

export function summarizeAvisos(results: AvisoResult[], lastIngest: string | null): string {
  const head = `${results.length} aviso(s) encontrado(s)${lastIngest ? `; índice atualizado em ${lastIngest}` : ""}. ` +
    "Os dados completos estão em structuredContent.";
  const lines = results.slice(0, 8).map((a) => {
    const title = a.title && a.title.length > 80 ? `${a.title.slice(0, 79)}…` : a.title;
    const amount = a.amount_eur === null ? "montante n/d" : `${a.amount_eur} EUR`;
    const window = a.starts_on && a.ends_on ? `${a.starts_on}–${a.ends_on}` : "sem janela";
    return `- ${a.code} · ${title ?? "título n/d"} · ${a.program ?? "programa n/d"} · ${a.status ?? "estado n/d"} · ${amount} · ${window} · ${a.source_url}`;
  });
  const more = results.length > 8 ? [`(+${results.length - 8} em structuredContent)`] : [];
  // O texto da fonte não pode introduzir linhas extra nem parecer JSON.
  return [head, ...lines, ...more].map((line) => line.replace(/[{}\r\n\u2028\u2029]/g, " ")).join("\n");
}

export function describeSources(db: Database, avisos?: Database | Error): string {
  let contractsText: string;
  try {
    const count = countContracts(db);
    contractsText = count === 0
      ? "O índice de contratos está vazio. Corre `bun run ingest` para importar os dados."
      : `${count} contrato(s) no índice.\n\n` +
        `- last_ingest: ${getMeta(db, "last_ingest") ?? "n/d"}\n` +
        `- Anos importados: ${listIngestedYears(db).join(", ") || "n/d"}`;
  } catch {
    contractsText = "Não foi possível ler o índice de contratos. Corre `bun run ingest` para o recriar.";
  }

  let avisosText: string;
  if (avisos === undefined || avisos instanceof Error) {
    avisosText = "O índice de avisos não está disponível. Corre `bun run ingest:avisos` para o criar.";
  } else {
    try {
      const count = countAvisos(avisos);
      avisosText = count === 0
        ? "O índice de avisos está vazio. Corre `bun run ingest:avisos` para importar os dados."
        : `${count} aviso(s) no índice (linhas das fontes, antes do agrupamento da pesquisa).\n\n` +
          `- last_ingest: ${getAvisosMeta(avisos, "last_ingest") ?? "n/d"}\n` +
          `- pt2030_xlsx: ${getAvisosMeta(avisos, "count_pt2030_xlsx") ?? "n/d"}\n` +
          `- acores2030_plano: ${getAvisosMeta(avisos, "count_acores2030_plano") ?? "n/d"}`;
    } catch {
      avisosText = "Não foi possível ler o índice de avisos. Corre `bun run ingest:avisos` para o recriar.";
    }
  }

  return [
    "# Fontes e cobertura",
    "## Fontes",
    "- Contratos do Portal BASE via dados.gov.pt: um ZIP por ano.\n" +
      "- Avisos PT2030: ficheiro XLSX do dados.gov.pt.\n" +
      "- Plano de avisos Açores 2030: API WordPress de acores.portugal2030.pt.",
    "## Contratos", contractsText,
    "## Avisos", avisosText,
    "## Limitações",
    "- Contratos dos Açores: filtro por localExecucao ou NUTS com prefixo PT2; só os anos importados estão cobertos.\n" +
      "- query exige todas as palavras (AND estrito); para temas, faz uma pesquisa por palavra.\n" +
      '- Nos avisos, "Aberto" reflete snapshot_date, a data do instantâneo da fonte, não o estado de hoje.\n' +
      "- O XLSX não traz datas de candidatura nem tipo de beneficiário (null). O plano regional vem sem estado (null). " +
      "Não combines status com open_on ou beneficiary: estes filtros pertencem a fontes diferentes.\n" +
      "- Nenhuma fonte de avisos permite filtrar pela dimensão da empresa.\n" +
      "- O JORAA ainda não está indexado: o sítio bloqueia o acesso automatizado. " +
      "Está pendente uma via de acesso acordada com o Centro de Edição do Jornal Oficial.",
  ].join("\n\n");
}

export function createServer(db: Database, avisos?: Database | Error): McpServer {
  const server = new McpServer({ name: "joraa-mcp", version: pkg.version });

  server.registerTool(
    "contracts_search",
    {
      title: "Pesquisar contratos públicos nos Açores",
      description:
        "Pesquisa contratos públicos executados na Região Autónoma dos Açores, a partir do Portal BASE (IMPIC, dados.gov.pt). " +
        "Um contrato conta como açoriano quando o local de execução refere os Açores ou o código NUTS é PT2. " +
        "Devolve a entidade adjudicante, os adjudicatários, o objeto, o valor em euros, a data de celebração e o link para o contrato no BASE. " +
        "Filtra por entidade adjudicante (nome ou NIF de 9 dígitos), por palavras do objeto e por datas de celebração. " +
        "Usa no máximo 8 palavras de 2 ou mais caracteres por campo. " +
        "Resultados ordenados do mais recente para o mais antigo. Campos que a fonte não tem vêm a null. " +
        "Cobre os anos importados para o índice; numa instalação completa, de 2012 ao ano corrente.",
      inputSchema: {
        entity: z.string().max(200).optional().describe("Nome (ou parte) ou NIF da entidade adjudicante, ex.: 'EDA' ou '512000040'"),
        query: z.string().max(200).optional().describe("Palavras a procurar no objeto e na descrição do contrato, ex.: 'manutenção estradas'"),
        from: isoDate.optional().describe("Data de celebração mínima (AAAA-MM-DD)"),
        to: isoDate.optional().describe("Data de celebração máxima (AAAA-MM-DD)"),
        limit: z.number().int().min(1).max(100).optional().describe("Máximo de resultados (por omissão 20)"),
      },
    },
    async (args) => {
      if (countContracts(db) === 0) {
        return {
          isError: true,
          content: [{ type: "text", text: "O índice de contratos está vazio. Corre `bun run ingest` para importar os dados do Portal BASE." }],
        };
      }
      const results = searchContracts(db, args);
      const lastIngest = getMeta(db, "last_ingest");
      const payload = { count: results.length, last_ingest: lastIngest, results };
      return {
        content: [{ type: "text", text: summarize(results, lastIngest) }],
        structuredContent: payload,
      };
    },
  );

  server.registerTool(
    "avisos_search",
    {
      title: "Pesquisar avisos de financiamento",
      description:
        "Pesquisa avisos PT2030 do dados.gov.pt (folha de cálculo mensal) e o plano de avisos do Açores 2030. " +
        "O estado vem da data do instantâneo da fonte (snapshot_date), não de hoje. " +
        "As linhas da folha nacional trazem estado e montantes, mas não datas de candidatura nem tipo de beneficiário. " +
        "As linhas do plano regional trazem janelas de candidatura e tipo de beneficiário, mas não estado. " +
        "A dimensão da empresa (micro, pequena) não existe em nenhuma fonte, por isso não há filtro de dimensão. " +
        "Um aviso repartido por vários fundos ou objetivos aparece uma vez por programa, com o montante somado. " +
        "Campos ausentes vêm a null.",
      inputSchema: {
        query: z.string().max(200).optional().describe("Palavras a procurar no título, programa, objetivos e fundos"),
        program: z.string().max(100).optional().describe("Código ou nome do programa, ex.: 'ACORES2030'"),
        status: z.enum(["Aberto", "Fechado"]).optional().describe("Estado no instantâneo da fonte nacional"),
        beneficiary: z.string().max(20).optional().describe("'publica' ou 'privada', sem distinguir acentos nem maiúsculas"),
        open_on: isoDate.optional().describe("Data dentro da janela de candidatura, incluindo os limites (AAAA-MM-DD)"),
        limit: z.number().int().min(1).max(100).optional().describe("Máximo de resultados (por omissão 20)"),
      },
    },
    async (args) => {
      if (avisos === undefined || avisos instanceof Error) {
        return {
          isError: true,
          // A causa (com o caminho do ficheiro) fica no stderr do arranque; ao cliente vai só o aviso genérico.
          content: [{ type: "text", text: "O índice de avisos não está disponível. Corre `bun run ingest:avisos` para o criar." }],
        };
      }
      let operation = "contar os avisos";
      try {
        if (countAvisos(avisos) === 0) {
          return {
            isError: true,
            content: [{ type: "text", text: "O índice de avisos está vazio. Corre `bun run ingest:avisos` para importar os dados." }],
          };
        }
        operation = "pesquisar o índice de avisos";
        const results = searchAvisos(avisos, args);
        operation = "ler a data de atualização do índice de avisos";
        const lastIngest = getAvisosMeta(avisos, "last_ingest");
        return {
          content: [{ type: "text", text: summarizeAvisos(results, lastIngest) }],
          structuredContent: { count: results.length, last_ingest: lastIngest, results },
        };
      } catch {
        // Identifica a operação sem expor valores do índice presentes no erro.
        return {
          isError: true,
          content: [{ type: "text", text: `Não foi possível ${operation}. Corre \`bun run ingest:avisos\` para o recriar.` }],
        };
      }
    },
  );

  server.registerPrompt(
    "contratos_entidade",
    {
      title: "Contratos de uma entidade",
      description: "Resume os contratos obtidos para uma entidade, os maiores valores e os fornecedores empresariais.",
      argsSchema: {
        entidade: z.string().trim().min(1).max(200).describe("Nome ou NIF da entidade adjudicante"),
        desde: isoDate.optional().describe("Data de celebração mínima (AAAA-MM-DD)"),
        ate: isoDate.optional().describe("Data de celebração máxima (AAAA-MM-DD)"),
      },
    },
    ({ entidade, desde, ate }): GetPromptResult => {
      assertRange(desde, ate);
      const call = { name: "contracts_search", arguments: { entity: entidade, from: desde, to: ate, limit: 100 } };
      const text = [
        `Entidade: ${entidade}.`,
        `Chama contracts_search com:\n\`\`\`json\n${JSON.stringify(call)}\n\`\`\``,
        "Indica o número de contratos obtidos. structuredContent.count conta apenas os resultados devolvidos, não o total do universo. " +
          "Se chegar a 100, apresenta-o como limite inferior: a ferramenta limita os resultados a 100.",
        "Os resultados vêm ordenados por data, do mais recente para o mais antigo. " +
          "Lista os maiores contratos por value_eur apenas dentro dos resultados obtidos, cada um com a ligação source_url. " +
          "Quando o adjudicatário for uma pessoa singular, ou não for claramente uma empresa, não o nomeies nessa lista.",
        "Lista os principais fornecedores de contractors apenas quando forem claramente empresas (Lda, S.A., Unipessoal, etc.). " +
          "Nunca contar, ordenar ou agrupar pessoas singulares; se a natureza do fornecedor não for clara, não o incluas nessa lista.",
        "Não inventes campos que venham a null nem os substituas por zero. Usa apenas os valores conhecidos e assinala as lacunas. " +
          "Se a ferramenta devolver um erro, comunica-o; não o apresentes como ausência de contratos.",
      ].join("\n\n");
      return { messages: [{ role: "user", content: { type: "text", text } }] };
    },
  );

  server.registerPrompt(
    "avisos_empresa",
    {
      title: "Avisos para uma empresa",
      description: "Consulta separadamente os avisos abertos na folha nacional e as janelas do plano regional.",
      argsSchema: {
        beneficiario: z.string().max(20).optional()
          .refine((v) => v === undefined || BENEFICIARIES.has(normalizeKey(v)), "beneficiario tem de ser 'publica' ou 'privada'")
          .describe("Tipo de beneficiário: 'publica' ou 'privada'"),
        tema: z.string().max(200).optional().describe("Palavras a pesquisar nos avisos"),
        data: isoDate.optional().describe("Data dentro da janela de candidatura (AAAA-MM-DD); por omissão, hoje nos Açores"),
      },
    },
    ({ beneficiario, tema, data }): GetPromptResult => {
      const national = { name: "avisos_search", arguments: { status: "Aberto", query: tema, limit: 100 } };
      const regional = { name: "avisos_search", arguments: {
        open_on: data ?? todayInAzores(), beneficiary: beneficiario && normalizeKey(beneficiario), query: tema, limit: 100,
      } };
      const text = [
        "Faz duas chamadas a avisos_search. Os campos destas fontes não se cruzam: status só existe na folha nacional " +
          "(pt2030_xlsx); open_on e beneficiary só existem no plano regional (acores2030_plano). " +
          "Não combines status com open_on ou beneficiary numa chamada, pois não obterias resultados.",
        `A — Folha nacional:\n\`\`\`json\n${JSON.stringify(national)}\n\`\`\``,
        `B — Plano regional:\n\`\`\`json\n${JSON.stringify(regional)}\n\`\`\``,
        'O estado "Aberto" reflete snapshot_date, a data do instantâneo da fonte, não o de hoje. ' +
          "Sem data indicada, open_on usa a data de hoje nos Açores, no formato AAAA-MM-DD. " +
          "Não existe filtro de dimensão da empresa; não infiras elegibilidade por dimensão.",
        "Apresenta cada aviso com a ligação source_url e identifica a fonte. " +
          "As datas e o tipo de beneficiário da folha nacional vêm a null; o plano regional não tem status. " +
          "Não inventes campos ausentes nem substituas null por zero. As contagens referem-se apenas aos resultados obtidos; " +
          "se uma chamada chegar a 100, apresenta a sua contagem como limite inferior. " +
          "Comunica qualquer erro de uma chamada e assinala que a consulta ficou incompleta.",
      ].join("\n\n");
      return { messages: [{ role: "user", content: { type: "text", text } }] };
    },
  );

  server.registerPrompt(
    "mapa_mercado",
    {
      title: "Mapa de um mercado",
      description: "Pesquisa contratos por palavra, elimina duplicados e resume compradores e valores obtidos.",
      argsSchema: {
        tema: z.string().trim().min(1).max(200).describe("Tema do mercado a consultar"),
        palavras: z.string().max(200).optional().describe("Palavras separadas por vírgulas; por omissão, as palavras do tema"),
        desde: isoDate.optional().describe("Data de celebração mínima (AAAA-MM-DD)"),
      },
    },
    ({ tema, palavras, desde }): GetPromptResult => {
      const words = marketWords(tema, palavras);
      const calls = words.map((query) => ({ name: "contracts_search", arguments: { query, from: desde, limit: 100 } }));
      const text = [
        `Tema: ${tema}.\nPalavras: ${JSON.stringify(words)}.`,
        "query exige todas as palavras (AND estrito por definição). Faz uma chamada a contracts_search por palavra da lista, " +
          "com limit: 100 e from quando indicado. Uma entrada com várias palavras continua a exigir todas elas.",
        calls.length
          ? calls.map((call) => `\`\`\`json\n${JSON.stringify(call)}\n\`\`\``).join("\n\n")
          : "Não há palavras para pesquisar. Pede palavras ao utilizador antes de chamar a ferramenta; não faças uma pesquisa sem filtro.",
        "Junta os resultados e elimina duplicados por id antes de contar ou somar. Resume os principais compradores (entity) " +
          "e os valores conhecidos (value_eur), sempre com ligações source_url. Os resumos descrevem apenas os resultados obtidos.",
        "Se alguma chamada chegar a 100 resultados, apresenta a contagem deduplicada como limite inferior. " +
          "structuredContent.count é limitado por limit, não é um total do mercado. As chamadas devolvem os contratos mais recentes.",
        "Nunca agregues pessoas singulares entre os adjudicatários (contractors), nem as contes, ordenes ou agrupes. " +
          "Não inventes valores null nem os substituas por zero; assinala os valores desconhecidos. " +
          "Comunica os erros das chamadas e identifica qualquer resumo parcial.",
      ].join("\n\n");
      return { messages: [{ role: "user", content: { type: "text", text } }] };
    },
  );

  server.registerResource(
    "fontes",
    "joraa://fontes",
    {
      title: "Fontes e cobertura dos índices",
      description: "Fontes, contagens, anos importados, datas de atualização e limitações dos dados disponíveis.",
      mimeType: "text/markdown",
    },
    (uri): ReadResourceResult => ({
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: describeSources(db, avisos) }],
    }),
  );

  return server;
}
