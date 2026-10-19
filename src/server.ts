import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Database } from "bun:sqlite";
import { z } from "zod";
import pkg from "../package.json";
import { countContracts, getMeta } from "./contracts/db";
import { searchContracts } from "./contracts/search";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Data no formato AAAA-MM-DD");

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
        "Resultados ordenados do mais recente para o mais antigo. Campos que a fonte não tem vêm a null.",
      inputSchema: {
        entity: z.string().optional().describe("Nome (ou parte) ou NIF da entidade adjudicante, ex.: 'EDA' ou '512000040'"),
        query: z.string().optional().describe("Palavras a procurar no objeto e na descrição do contrato, ex.: 'manutenção estradas'"),
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
      const payload = { count: results.length, last_ingest: getMeta(db, "last_ingest"), results };
      return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        structuredContent: payload,
      };
    },
  );

  return server;
}
