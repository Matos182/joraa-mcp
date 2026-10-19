// Um contrato tal como vem no JSON anual do Portal BASE (IMPIC), só os campos usados.
export type BaseRow = {
  idcontrato: string;
  objectoContrato?: string | null;
  descContrato?: string | null;
  adjudicante?: string[] | null;
  adjudicatarios?: string[] | null;
  tipoContrato?: string[] | null;
  tipoprocedimento?: string | null;
  precoContratual?: number | string | null;
  dataCelebracaoContrato?: string | null;
  dataPublicacao?: string | null;
  localExecucao?: string[] | null;
  NUTs?: string[] | null;
  cpv?: string[] | null;
};

export type Contract = {
  id: string;
  entity: string | null;
  entity_nif: string | null;
  contractors: string[];
  object: string | null;
  description: string | null;
  contract_type: string | null;
  procedure: string | null;
  value_eur: number | null;
  signed_on: string | null;
  published_on: string | null;
  location: string | null;
  nuts: string | null;
  cpv: string | null;
  source_url: string;
};

// Região: o sinal está no contrato. Nunca se alarga pelo NIF da entidade
// (alargar pelo NIF juntava cerca de 10 mil contratos de fora da região).
export function isAzores(r: Pick<BaseRow, "localExecucao" | "NUTs">): boolean {
  if ((r.localExecucao ?? []).some((l) => /açores/i.test(l))) return true;
  return (r.NUTs ?? []).some((n) => n.startsWith("PT2"));
}

// "23/02/2026" -> "2026-02-23"
export function isoDate(d: string | null | undefined): string | null {
  const m = d?.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

export function euros(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

const nonEmpty = (s: string | null | undefined) => (s && s.trim() ? s.trim() : null);
const joined = (a: string[] | null | undefined) => (a && a.length ? a.join("; ") : null);

export function sourceUrl(id: string): string {
  return `https://www.base.gov.pt/Base4/pt/detalhe/?type=contratos&id=${encodeURIComponent(id)}`;
}

export function toContract(r: BaseRow): Contract {
  const entity = r.adjudicante?.[0] ?? null;
  const m = entity?.match(/^(\d{9})\s*-\s*(.+)$/);
  return {
    id: String(r.idcontrato),
    entity: m ? m[2]!.trim() : nonEmpty(entity),
    entity_nif: m ? m[1]! : null,
    contractors: r.adjudicatarios ?? [],
    object: nonEmpty(r.objectoContrato),
    description: nonEmpty(r.descContrato),
    contract_type: joined(r.tipoContrato),
    procedure: nonEmpty(r.tipoprocedimento),
    value_eur: euros(r.precoContratual),
    signed_on: isoDate(r.dataCelebracaoContrato),
    published_on: isoDate(r.dataPublicacao),
    location: joined(r.localExecucao),
    nuts: joined(r.NUTs),
    cpv: joined(r.cpv),
    source_url: sourceUrl(String(r.idcontrato)),
  };
}
