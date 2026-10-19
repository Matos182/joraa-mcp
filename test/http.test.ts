import { expect, test } from "bun:test";
import { createHttp, SourceUnavailableError, USER_AGENT } from "../src/http";

function fakeFetch(status = 200) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ ok: true }), { status });
  };
  return { fn, calls };
}

test("o mesmo pedido dentro do TTL vai à rede uma só vez", async () => {
  const f = fakeFetch();
  const http = createHttp({ ttlMs: 60_000, fetch: f.fn });
  await http.json("https://example.org/a");
  await http.json("https://example.org/a");
  expect(f.calls.length).toBe(1);
});

test("fora do TTL volta à rede", async () => {
  const f = fakeFetch();
  const http = createHttp({ ttlMs: 0, fetch: f.fn });
  await http.get("https://example.org/a");
  await http.get("https://example.org/a");
  expect(f.calls.length).toBe(2);
});

test("todos os pedidos levam o User-Agent do projeto", async () => {
  const f = fakeFetch();
  await createHttp({ fetch: f.fn }).get("https://example.org/b");
  const ua = new Headers(f.calls[0]!.init?.headers).get("User-Agent");
  expect(ua).toBe(USER_AGENT);
  expect(ua).toMatch(/^joraa-mcp\/\d+\.\d+\.\d+ \(/);
});

test("uma fonte que bloqueia dá um erro explícito e não dados vazios", async () => {
  const f = fakeFetch(403);
  expect(createHttp({ fetch: f.fn }).get("https://example.org/c")).rejects.toBeInstanceOf(SourceUnavailableError);
});
