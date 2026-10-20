export type AvisoSource = "pt2030_xlsx" | "acores2030_plano";

// Uma linha da fonte. Só beneficiary pode ser null; os restantes arrays ficam vazios.
export type AvisoRow = {
  source: AvisoSource;
  code: string;
  title: string | null;
  status: string | null;
  program: string | null;
  program_search: string;
  funds: string[];
  objectives: string[];
  amount_eur: number | null;
  starts_on: string | null;
  ends_on: string | null;
  beneficiary: string[] | null;
  snapshot_date: string | null;
  source_url: string;
};

export type AvisoResult = Omit<AvisoRow, "program_search">;
