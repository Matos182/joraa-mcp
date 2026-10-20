import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Database } from "bun:sqlite";
import { openReadOnlyDb } from "./contracts/db";
import { createServer } from "./server";

let db: Database;
try {
  db = openReadOnlyDb();
} catch (error) {
  console.error(`joraa-mcp: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
const server = createServer(db);
await server.connect(new StdioServerTransport());
