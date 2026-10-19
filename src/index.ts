import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { openDb } from "./contracts/db";
import { createServer } from "./server";

const server = createServer(openDb());
await server.connect(new StdioServerTransport());
