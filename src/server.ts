import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Database } from "bun:sqlite";
import { z } from "zod";
import pkg from "../package.json";
import { countAvisos, getAvisosMeta } from "./avisos/db";
import { searchAvisos } from "./avisos/search";
import type { AvisoResult } from "./avisos/types";
import type { Contract } from "./contracts/base";
import { countContracts, getMeta } from "./contracts/db";
import { searchContracts } from "./contracts/search";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Data no formato AAAA-MM-DD");

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

export function createServer(db: Database, avisos?: Database | Error) {
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
          content: [{ type: "text", text: avisos?.message ?? "O índice de avisos não está disponível. Corre `bun run ingest:avisos` para o criar." }],
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

  return server;
}
