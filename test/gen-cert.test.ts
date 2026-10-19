import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isValidHostname } from "../deploy/gen-cert";

test("aceita nomes DNS em minúsculas e localhost", () => {
  for (const hostname of ["mcp.example.test", "localhost", "a-b.example", `${"a".repeat(63)}.example`, `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(61)}`]) {
    expect(isValidHostname(hostname)).toBe(true);
  }
});

test("recusa injeções, maiúsculas e nomes fora dos limites DNS", () => {
  for (const hostname of ["a,DNS:evil.example", "x/CN=evil", "", "Joraa.example", `${"a".repeat(64)}.example`, "-a.example", "a-.example", "1.2.3.4,IP:5.6.7.8", "example", ".example", "a..example", "a.example.", "a_b.example", "a.example\n", `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(62)}`]) {
    expect(isValidHostname(hostname)).toBe(false);
  }
});

async function run(command: string[], env?: Record<string, string | undefined>): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(command, { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe", timeout: 30_000, killSignal: "SIGKILL" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, stdout, stderr };
}

const script = resolve(import.meta.dir, "../deploy/gen-cert.ts");

test("gera os SANs, protege a chave e exige --force para substituir", async () => {
  const dir = mkdtempSync(join(tmpdir(), "joraa-cert-"));
  const env = { JORAA_CERT_DIR: dir };
  const crt = join(dir, "joraa.crt");
  const key = join(dir, "joraa.key");
  try {
    const generated = await run([process.execPath, script, "mcp.example.test"], env);
    expect(generated.stderr).toBe("");
    expect(generated.code).toBe(0);
    expect(generated.stdout).toContain(crt);
    expect(generated.stdout).toContain(key);
    expect(statSync(key).mode & 0o777).toBe(0o600);
    const inspected = await run(["/usr/bin/openssl", "x509", "-noout", "-ext", "subjectAltName", "-in", crt]);
    expect(inspected.stderr).toBe("");
    expect(inspected.code).toBe(0);
    for (const san of ["DNS:mcp.example.test", "DNS:localhost", "IP Address:127.0.0.1", "IP Address:0:0:0:0:0:0:0:1"]) {
      expect(inspected.stdout).toContain(san);
    }
    const original = readFileSync(crt, "utf8");
    const refused = await run([process.execPath, script, "mcp.example.test"], env);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("--force");
    expect(readFileSync(crt, "utf8")).toBe(original);
    const replaced = await run([process.execPath, script, "outro.example", "--force"], env);
    expect(replaced.code).toBe(0);
    expect(replaced.stderr).toBe("");
    expect(readFileSync(crt, "utf8")).not.toBe(original);
    expect(statSync(key).mode & 0o777).toBe(0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 120_000);

test("falhas de escrita e do OpenSSL são comunicadas com contexto", async () => {
  const dir = mkdtempSync(join(tmpdir(), "joraa-cert-"));
  try {
    const blocked = join(dir, "ficheiro");
    writeFileSync(blocked, "não é um diretório");
    const mkdirError = await run([process.execPath, script], { JORAA_CERT_DIR: blocked });
    expect(mkdirError.code).toBe(1);
    expect(mkdirError.stderr).toContain("gen-cert:");
    expect(mkdirError.stderr).toContain(blocked);
    mkdirSync(join(dir, "joraa.key"));
    const opensslError = await run([process.execPath, script, "--force"], { JORAA_CERT_DIR: dir });
    expect(opensslError.code).toBe(1);
    expect(opensslError.stderr).toContain("OpenSSL falhou");
    expect(opensslError.stderr).toContain("req:");
    expect(opensslError.stderr).toContain(join(dir, "joraa.key"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 120_000);

test("a CLI recusa um nome inválido, argumentos a mais e uma chave já existente", async () => {
  const dir = mkdtempSync(join(tmpdir(), "joraa-cert-"));
  const env = { JORAA_CERT_DIR: dir };
  try {
    for (const args of [["a,DNS:evil.example"], ["a.example", "b.example"], ["--unknown"]]) {
      const result = await run([process.execPath, script, ...args], env);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("gen-cert");
    }
    writeFileSync(join(dir, "joraa.key"), "não substituir");
    const result = await run([process.execPath, script], env);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--force");
    expect(readFileSync(join(dir, "joraa.key"), "utf8")).toBe("não substituir");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 120_000);
