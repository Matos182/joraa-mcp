export function normalizeKey(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#\d+|#[xX][\da-fA-F]+|amp|lt|gt|quot|apos|nbsp);/g, (entity: string, key: string) => {
    if (!key.startsWith("#")) return ENTITIES[key]!;
    const n = key[1]?.toLowerCase() === "x" ? parseInt(key.slice(2), 16) : Number(key.slice(1));
    if (!Number.isInteger(n) || n < 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return entity;
    return String.fromCodePoint(n);
  });
}

export function cleanTitle(s: string): string | null {
  return decodeEntities(s.replace(/<[^>]*>/g, "")).replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim() || null;
}
