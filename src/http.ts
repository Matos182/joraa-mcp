import pkg from "../package.json";

const repo = (pkg as { repository?: { url?: string } }).repository?.url;
export const USER_AGENT = `joraa-mcp/${pkg.version}${repo ? ` (+${repo})` : " (open-source MCP server)"}`;

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export type HttpOptions = {
  // Nomes exatos a que se pode ligar (sem subdomínios implícitos). Só https.
  allowedHosts: readonly string[];
  ttlMs?: number;
  // Tempo máximo de cada pedido, incluindo a leitura do corpo e todos os redirecionamentos.
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  fetch?: Fetch;
};

export type GetOptions = { maxBytes?: number };

// Cache em memória por URL e limite. O mesmo pedido dentro do TTL não volta à rede;
// o limite entra na chave para um corpo aceite com um limite largo não escapar a um mais curto.
// Cada salto (o URL pedido e cada Location) tem de ser https num nome da lista.
export function createHttp(opts: HttpOptions) {
  const ttlMs = opts.ttlMs ?? Number(process.env.JORAA_MCP_CACHE_TTL_MS ?? 60 * 60 * 1000);
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const defaultMaxBytes = opts.maxBytes ?? 512 * 1024 * 1024;
  const maxRedirects = opts.maxRedirects ?? 5;
  const allowed = new Set(opts.allowedHosts.map((h) => h.toLowerCase()));
  const doFetch: Fetch = opts.fetch ?? ((i, init) => fetch(i, init));
  const cache = new Map<string, { at: number; body: ArrayBuffer }>();

  function checkUrl(raw: string, hop: number): URL {
    const url = URL.parse(raw);
    if (!url) throw new EgressDeniedError(raw, hop, "URL inválido");
    if (url.protocol !== "https:") throw new EgressDeniedError(raw, hop, `protocolo ${url.protocol} não permitido`);
    if (url.username || url.password) throw new EgressDeniedError(raw, hop, "credenciais no URL");
    if (url.port && url.port !== "443") throw new EgressDeniedError(raw, hop, `porta ${url.port} não permitida`);
    if (!allowed.has(url.hostname)) throw new EgressDeniedError(raw, hop, `anfitrião ${url.hostname} fora da lista`);
    return url;
  }

  async function fetchOnce(url: string, maxBytes: number): Promise<ArrayBuffer> {
    const signal = AbortSignal.timeout(timeoutMs);
    let current = checkUrl(url, 0);
    for (let hop = 0; ; hop++) {
      const res = await doFetch(current.href, { headers: { "User-Agent": USER_AGENT }, redirect: "manual", signal });
      if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel();
        const location = res.headers.get("location");
        if (!location) throw new SourceUnavailableError(current.href, res.status);
        if (hop + 1 > maxRedirects) throw new EgressDeniedError(location, hop + 1, `mais de ${maxRedirects} redirecionamentos`);
        const next = URL.parse(location, current.href);
        current = checkUrl(next?.href ?? location, hop + 1);
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel();
        throw new SourceUnavailableError(current.href, res.status);
      }
      return readCapped(res, current.href, maxBytes, signal);
    }
  }

  async function get(url: string, { maxBytes = defaultMaxBytes }: GetOptions = {}): Promise<ArrayBuffer> {
    const key = `${maxBytes} ${url}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.body;
    const body = await fetchOnce(url, maxBytes);
    cache.set(key, { at: Date.now(), body });
    return body;
  }

  return {
    get,
    async json(url: string, options?: GetOptions): Promise<unknown> {
      return JSON.parse(new TextDecoder().decode(await get(url, options)));
    },
  };
}

// Lê o corpo em streaming e para assim que passa o limite, sem confiar no Content-Length.
// O sinal de timeout também interrompe um corpo que nunca acaba.
// Com Content-Length conhecido, o corpo é escrito num só buffer reservado à cabeça, sem
// juntar pedaços no fim (pico de memória de 1x e não 2x). Se chegarem mais bytes do que os
// declarados (por exemplo, um corpo descomprimido pelo fetch), passa a juntar pedaços.
async function readCapped(res: Response, url: string, maxBytes: number, signal: AbortSignal): Promise<ArrayBuffer> {
  const header = res.headers.get("content-length");
  const declared = header !== null && /^\d+$/.test(header.trim()) ? Number(header) : null;
  if (declared !== null && declared > maxBytes) {
    await res.body?.cancel();
    throw new ResponseTooLargeError(url, maxBytes);
  }
  if (!res.body) return new ArrayBuffer(0);
  const reader = res.body.getReader();
  const onAbort = () => { reader.cancel(signal.reason).catch(() => { /* o erro relevante é o do read() */ }); };
  signal.addEventListener("abort", onAbort, { once: true });
  let fixed: Uint8Array<ArrayBuffer> | null = declared !== null ? new Uint8Array(declared) : null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      if (signal.aborted) throw signal.reason;
      const { done, value } = await reader.read();
      if (signal.aborted) throw signal.reason;
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new ResponseTooLargeError(url, maxBytes);
      }
      if (fixed && total <= fixed.byteLength) {
        fixed.set(value, total - value.byteLength);
        continue;
      }
      if (fixed) {
        chunks.push(fixed.subarray(0, total - value.byteLength));
        fixed = null;
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  if (fixed) return total === fixed.byteLength ? fixed.buffer : fixed.slice(0, total).buffer;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.byteLength; }
  return out.buffer;
}

export class SourceUnavailableError extends Error {
  constructor(public url: string, public status: number) {
    super(`Fonte indisponível (HTTP ${status}): ${url}`);
  }
}

export class EgressDeniedError extends Error {
  constructor(public url: string, public hop: number, reason: string) {
    super(`Ligação recusada no salto ${hop} (${reason}): ${url}`);
  }
}

export class ResponseTooLargeError extends Error {
  constructor(public url: string, public maxBytes: number) {
    super(`Resposta acima de ${maxBytes} bytes: ${url}`);
  }
}
