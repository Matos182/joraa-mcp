import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Database } from "bun:sqlite";
import { openAvisosReadOnlyDb } from "./avisos/db";
import { openReadOnlyDb } from "./contracts/db";
import { createServer } from "./server";

let db: Database;
try {
  db = openReadOnlyDb();
} catch (error) {
  console.error(`joraa-mcp: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
let avisos: Database | Error;
try {
  avisos = openAvisosReadOnlyDb();
} catch (e) {
  avisos = e instanceof Error ? e : new Error(String(e));
  console.error(`joraa-mcp: ${avisos.message}`);
}
const server = createServer(db, avisos);
await server.connect(new StdioServerTransport());
