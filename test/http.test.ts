import { expect, test } from "bun:test";
import { createHttp, EgressDeniedError, ResponseTooLargeError, SourceUnavailableError, USER_AGENT } from "../src/http";

type Reply = (url: string, init?: RequestInit) => Response | Promise<Response>;

function fakeFetch(reply: Reply = () => new Response(JSON.stringify({ ok: true }))) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return reply(url, init);
  };
  return { fn, calls };
}

const allowedHosts = ["example.org", "files.example.org"];

test("o mesmo pedido dentro do TTL vai à rede uma só vez", async () => {
  const f = fakeFetch();
  const http = createHttp({ allowedHosts, ttlMs: 60_000, fetch: f.fn });
  await http.json("https://example.org/a");
  await http.json("https://example.org/a");
  expect(f.calls.length).toBe(1);
});

test("fora do TTL volta à rede", async () => {
  const f = fakeFetch();
  const http = createHttp({ allowedHosts, ttlMs: 0, fetch: f.fn });
  await http.get("https://example.org/a");
  await http.get("https://example.org/a");
  expect(f.calls.length).toBe(2);
});

test("todos os pedidos levam o User-Agent do projeto e redirect manual", async () => {
  const f = fakeFetch();
  await createHttp({ allowedHosts, fetch: f.fn }).get("https://example.org/b");
  const ua = new Headers(f.calls[0]!.init?.headers).get("User-Agent");
  expect(ua).toBe(USER_AGENT);
  expect(ua).toMatch(/^joraa-mcp\/\d+\.\d+\.\d+ \(/);
  expect(f.calls[0]!.init?.redirect).toBe("manual");
  expect(f.calls[0]!.init?.signal).toBeInstanceOf(AbortSignal);
});

test("uma fonte que bloqueia dá um erro explícito e não dados vazios", async () => {
  const f = fakeFetch(() => new Response("no", { status: 403 }));
  expect(createHttp({ allowedHosts, fetch: f.fn }).get("https://example.org/c")).rejects.toBeInstanceOf(SourceUnavailableError);
});

test("só https, sem credenciais, na porta 443 e num nome exato da lista", async () => {
  const f = fakeFetch();
  const http = createHttp({ allowedHosts, fetch: f.fn });
  for (const url of [
    "http://example.org/a",
    "https://user:pw@example.org/a",
    "https://example.org:8443/a",
    "https://evil.example.org/a",
    "https://example.org.evil.test/a",
    "file:///etc/passwd",
    "não é um url",
  ]) {
    await expect(http.get(url)).rejects.toBeInstanceOf(EgressDeniedError);
  }
  expect(f.calls.length).toBe(0);
  await http.get("https://EXAMPLE.org:443/a");
  expect(f.calls.length).toBe(1);
});

test("cada redirecionamento é verificado de novo e o anfitrião recusado aparece no erro", async () => {
  const f = fakeFetch((url) => url === "https://example.org/zip"
    ? new Response(null, { status: 302, headers: { location: "https://cdn.evil.test/contratos.zip" } })
    : new Response("x"));
  const err = await createHttp({ allowedHosts, fetch: f.fn }).get("https://example.org/zip").catch((e) => e);
  expect(err).toBeInstanceOf(EgressDeniedError);
  expect(err.hop).toBe(1);
  expect(err.message).toContain("cdn.evil.test");
  expect(f.calls.map((c) => c.url)).toEqual(["https://example.org/zip"]);
});

test("um redirecionamento para http é recusado", async () => {
  const f = fakeFetch(() => new Response(null, { status: 301, headers: { location: "http://example.org/zip" } }));
  const err = await createHttp({ allowedHosts, fetch: f.fn }).get("https://example.org/zip").catch((e) => e);
  expect(err).toBeInstanceOf(EgressDeniedError);
  expect(err.message).toContain("http:");
});

test("redirecionamentos relativos e entre nomes da lista são seguidos", async () => {
  const f = fakeFetch((url) => {
    if (url === "https://example.org/a") return new Response(null, { status: 302, headers: { location: "/b" } });
    if (url === "https://example.org/b") return new Response(null, { status: 307, headers: { location: "https://files.example.org/c" } });
    return new Response("fim");
  });
  const body = await createHttp({ allowedHosts, fetch: f.fn }).get("https://example.org/a");
  expect(new TextDecoder().decode(body)).toBe("fim");
  expect(f.calls.map((c) => c.url)).toEqual(["https://example.org/a", "https://example.org/b", "https://files.example.org/c"]);
});

test("um ciclo de redirecionamentos para ao fim do limite", async () => {
  const f = fakeFetch(() => new Response(null, { status: 302, headers: { location: "/loop" } }));
  const err = await createHttp({ allowedHosts, fetch: f.fn, maxRedirects: 3 }).get("https://example.org/loop").catch((e) => e);
  expect(err).toBeInstanceOf(EgressDeniedError);
  expect(f.calls.length).toBe(4);
});

test("um 3xx sem Location é uma fonte indisponível", async () => {
  const f = fakeFetch(() => new Response(null, { status: 302 }));
  expect(createHttp({ allowedHosts, fetch: f.fn }).get("https://example.org/a")).rejects.toBeInstanceOf(SourceUnavailableError);
});

test("um Content-Length acima do limite é recusado sem ler o corpo", async () => {
  const f = fakeFetch(() => new Response("x".repeat(10), { headers: { "content-length": "1000000" } }));
  expect(createHttp({ allowedHosts, fetch: f.fn, maxBytes: 100 }).get("https://example.org/a")).rejects.toBeInstanceOf(ResponseTooLargeError);
});

test("um corpo em streaming sem Content-Length para assim que passa o limite", async () => {
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(c) { pulled++; c.enqueue(new Uint8Array(64)); },
  });
  const f = fakeFetch(() => new Response(stream));
  const http = createHttp({ allowedHosts, fetch: f.fn });
  await expect(http.get("https://example.org/a", { maxBytes: 1000 })).rejects.toBeInstanceOf(ResponseTooLargeError);
  expect(pulled).toBeLessThan(40);
});

test("a cache distingue o limite: um corpo aceite com limite largo é recusado com um curto", async () => {
  const f = fakeFetch(() => new Response("x".repeat(500)));
  const http = createHttp({ allowedHosts, ttlMs: 60_000, fetch: f.fn });
  expect((await http.get("https://example.org/a", { maxBytes: 1000 })).byteLength).toBe(500);
  await expect(http.get("https://example.org/a", { maxBytes: 100 })).rejects.toBeInstanceOf(ResponseTooLargeError);
  expect((await http.get("https://example.org/a", { maxBytes: 1000 })).byteLength).toBe(500);
  expect(f.calls.length).toBe(2);
});

function chunked(parts: number[], contentLength?: string) {
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      if (i === parts.length) return c.close();
      c.enqueue(new Uint8Array(parts[i]!).fill(i + 1));
      i++;
    },
  });
  return new Response(stream, { headers: contentLength === undefined ? {} : { "content-length": contentLength } });
}
const expected = (parts: number[]) => parts.flatMap((n, i) => Array<number>(n).fill(i + 1));

test("com Content-Length exato o corpo chega inteiro e na ordem", async () => {
  const parts = [100, 1, 250, 49];
  const http = createHttp({ allowedHosts, fetch: fakeFetch(() => chunked(parts, "400")).fn });
  const body = await http.get("https://example.org/a", { maxBytes: 400 });
  expect(body.byteLength).toBe(400);
  expect([...new Uint8Array(body)]).toEqual(expected(parts));
});

test("um corpo mais curto ou mais longo do que o Content-Length é devolvido tal como chegou", async () => {
  const short = await createHttp({ allowedHosts, fetch: fakeFetch(() => chunked([10, 20], "100")).fn }).get("https://example.org/a");
  expect([...new Uint8Array(short)]).toEqual(expected([10, 20]));
  // O fetch descomprime: o corpo pode passar o Content-Length declarado, e o limite continua a valer.
  const long = await createHttp({ allowedHosts, fetch: fakeFetch(() => chunked([30, 40, 50], "50")).fn }).get("https://example.org/a");
  expect([...new Uint8Array(long)]).toEqual(expected([30, 40, 50]));
  const over = createHttp({ allowedHosts, fetch: fakeFetch(() => chunked([30, 40, 50], "50")).fn }).get("https://example.org/a", { maxBytes: 100 });
  await expect(over).rejects.toBeInstanceOf(ResponseTooLargeError);
});

test("um corpo que nunca acaba é cortado pelo timeout", async () => {
  const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(1)); } });
  const f = fakeFetch(() => new Response(stream));
  const t0 = performance.now();
  const err = await createHttp({ allowedHosts, fetch: f.fn, timeoutMs: 100 }).get("https://example.org/a").catch((e) => e);
  expect(err).toBeInstanceOf(Error);
  expect((err as Error).name).toBe("TimeoutError");
  expect(performance.now() - t0).toBeLessThan(2000);
});

test("o timeout chega ao fetch como sinal", async () => {
  const f = fakeFetch((_url, init) => new Promise((_, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
  }));
  const err = await createHttp({ allowedHosts, fetch: f.fn, timeoutMs: 50 }).get("https://example.org/a").catch((e) => e);
  expect((err as Error).name).toBe("TimeoutError");
});
