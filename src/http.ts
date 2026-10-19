import pkg from "../package.json";

const repo = (pkg as { repository?: { url?: string } }).repository?.url;
export const USER_AGENT = `joraa-mcp/${pkg.version}${repo ? ` (+${repo})` : " (open-source MCP server)"}`;

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

// Cache em memória por URL. O mesmo pedido dentro do TTL não volta à rede.
export function createHttp(opts: { ttlMs?: number; fetch?: Fetch } = {}) {
  const ttlMs = opts.ttlMs ?? Number(process.env.JORAA_MCP_CACHE_TTL_MS ?? 60 * 60 * 1000);
  const doFetch: Fetch = opts.fetch ?? ((i, init) => fetch(i, init));
  const cache = new Map<string, { at: number; body: ArrayBuffer }>();

  async function get(url: string): Promise<ArrayBuffer> {
    const hit = cache.get(url);
    if (hit && Date.now() - hit.at < ttlMs) return hit.body;
    const res = await doFetch(url, { headers: { "User-Agent": USER_AGENT } });
    if (!res.ok) throw new SourceUnavailableError(url, res.status);
    const body = await res.arrayBuffer();
    cache.set(url, { at: Date.now(), body });
    return body;
  }

  return {
    get,
    async json<T = unknown>(url: string): Promise<T> {
      return JSON.parse(new TextDecoder().decode(await get(url)));
    },
  };
}

export class SourceUnavailableError extends Error {
  constructor(public url: string, public status: number) {
    super(`Fonte indisponível (HTTP ${status}): ${url}`);
  }
}
