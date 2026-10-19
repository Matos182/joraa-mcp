import { getDocumentProxy } from "unpdf";

type TextFragment = { text: string; x: number; y: number; height: number };
type TextLine = { y: number; height: number; items: TextFragment[] };

// Sem limite de tempo: o processamento é local, sobre bytes já em memória, sem rede.
export async function extractFirstPageText(pdf: Uint8Array | ArrayBuffer): Promise<string> {
  let document: Awaited<ReturnType<typeof getDocumentProxy>> | undefined;
  try {
    document = await getDocumentProxy(pdf instanceof Uint8Array ? new Uint8Array(pdf) : pdf.slice(0));
    if (document.numPages === 0) throw new Error("O PDF não contém páginas.");
    const page = await document.getPage(1);
    const content = await page.getTextContent();
    const fragments: TextFragment[] = [];
    for (const item of content.items) {
      if (!("str" in item) || !item.str.trim()) continue;
      const x: unknown = item.transform[4];
      const y: unknown = item.transform[5];
      if (typeof x !== "number" || typeof y !== "number") {
        throw new Error("Coordenadas de texto inválidas na primeira página do PDF.");
      }
      fragments.push({ text: item.str, x, y, height: item.height });
    }
    fragments.sort((a, b) => b.y - a.y || a.x - b.x);
    const lines: TextLine[] = [];
    for (const fragment of fragments) {
      const previous = lines.at(-1);
      if (previous && Math.abs(previous.y - fragment.y) <= 2) {
        previous.items.push(fragment);
        previous.height = Math.max(previous.height, fragment.height);
      } else {
        lines.push({ y: fragment.y, height: fragment.height, items: [fragment] });
      }
    }
    const output: string[] = [];
    let previous: TextLine | undefined;
    for (const line of lines) {
      line.items.sort((a, b) => a.x - b.x);
      const text = line.items.map((item) => item.text).join(" ").replace(/\s+/gu, " ").trim();
      // Os blocos do índice separam-se por um espaço vertical maior ou por mudança de corpo de letra
      // (cabeçalho da entidade a 12 pt, ato e sumário a cerca de 10 pt).
      if (previous && (previous.y - line.y > 1.75 * Math.min(previous.height, line.height)
        || Math.abs(previous.height - line.height) > 1)) output.push("");
      output.push(text);
      previous = line;
    }
    return output.join("\n");
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`Não foi possível extrair o texto da primeira página do PDF: ${detail}`, { cause });
  } finally {
    await document?.loadingTask.destroy();
  }
}
