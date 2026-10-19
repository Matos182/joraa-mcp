import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

// Só se aceitam nomes LDH em minúsculas; não se normaliza a entrada.
export function isValidHostname(hostname: string): boolean {
  if (hostname.length > 253 || /[^a-z0-9.-]/.test(hostname)) return false;
  if (hostname !== "localhost" && !hostname.includes(".")) return false;
  return hostname.split(".").every((label) =>
    label.length >= 1 && label.length <= 63 && !label.startsWith("-") && !label.endsWith("-")
  );
}

async function main(args: string[]): Promise<void> {
  const names = args.filter((arg) => arg !== "--force");
  if (names.length > 1 || names.some((arg) => arg.startsWith("--"))) {
    throw new Error("Uso: bun deploy/gen-cert.ts [hostname] [--force]");
  }
  const hostname = names[0] ?? "localhost";
  if (!isValidHostname(hostname)) {
    throw new Error(`Nome inválido: ${JSON.stringify(hostname)}. Use localhost ou um nome DNS com ponto, rótulos LDH em minúsculas de 1–63 caracteres e até 253 caracteres no total.`);
  }

  const dir = resolve(import.meta.dir, process.env.JORAA_CERT_DIR ?? "certs");
  const crt = join(dir, "joraa.crt");
  const key = join(dir, "joraa.key");
  if (!args.includes("--force") && (existsSync(crt) || existsSync(key))) {
    throw new Error(`Já existe um certificado ou uma chave em ${dir}; use --force para substituir.`);
  }
  mkdirSync(dir, { recursive: true });
  const child = Bun.spawn([
    "/usr/bin/openssl", "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1",
    "-nodes", "-sha256", "-days", "365", "-keyout", key, "-out", crt, "-subj", `/CN=${hostname}`,
    "-addext", `subjectAltName=${[...new Set([hostname, "localhost"])].map((n) => `DNS:${n}`).join(",")},IP:127.0.0.1,IP:::1`,
    // Sem keyUsage: o cliente confia neste certificado como a sua própria CA, e o BoringSSL
    // (o do Bun) recusa-o como emissor de si mesmo se houver keyUsage sem keyCertSign.
    "-addext", "extendedKeyUsage=serverAuth",
    "-addext", "basicConstraints=critical,CA:FALSE",
  ], { stdout: "ignore", stderr: "pipe", timeout: 30_000, killSignal: "SIGKILL" });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (code !== 0) {
    throw new Error(`OpenSSL falhou ao gerar ${crt} (código ${code}, sinal ${child.signalCode ?? "nenhum"}):\n${stderr}`);
  }
  chmodSync(key, 0o600);
  console.log(`Certificado: ${crt}\nChave: ${key}`);
}

if (import.meta.main) {
  try {
    await main(Bun.argv.slice(2));
  } catch (error) {
    console.error(`gen-cert: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
