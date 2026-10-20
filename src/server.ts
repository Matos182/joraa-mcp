import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Database } from "bun:sqlite";
import { z } from "zod";
import pkg from "../package.json";
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

export function createServer(db: Database) {
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

  return server;
}
