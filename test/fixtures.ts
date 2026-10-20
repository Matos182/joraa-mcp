import { isAzores, toContract, type BaseRow } from "../src/contracts/base";
import { openWritableDb, replaceYear } from "../src/contracts/db";

export const rows: BaseRow[] = [
  {
    idcontrato: "1001", objectoContrato: "Manutenção da rede elétrica de São Miguel",
    descContrato: "Manutenção preventiva", adjudicante: ["512000040 - EDA - Electricidade dos Açores, S.A."],
    adjudicatarios: ["500000000 - Empresa Exemplo, Lda"], tipoContrato: ["Aquisição de serviços"],
    tipoprocedimento: "Concurso público", precoContratual: 125000.5, dataCelebracaoContrato: "10/03/2026",
    dataPublicacao: "12/03/2026", localExecucao: ["Portugal"], NUTs: ["PT200"], cpv: ["50000000-5 - Reparação"],
  },
  {
    idcontrato: "1002", objectoContrato: "Reparação de estradas na ilha Terceira",
    adjudicante: ["600000001 - Secretaria Regional das Obras Públicas"],
    adjudicatarios: ["123456789 - João Exemplo Silva"], precoContratual: "9 500,25",
    dataCelebracaoContrato: "02/01/2026", localExecucao: ["Portugal, Região Autónoma dos Açores, Angra do Heroísmo"],
    NUTs: null,
  },
  {
    idcontrato: "2001", objectoContrato: "Aquisição de software em Coimbra",
    adjudicante: ["600052737 - Serviços de Ação Social de Coimbra"], adjudicatarios: [],
    precoContratual: 9000, dataCelebracaoContrato: "23/02/2026", localExecucao: ["Portugal, Coimbra, Coimbra"], NUTs: null,
  },
];

// Índice em memória (ou num ficheiro) com os contratos açorianos das linhas de exemplo.
export function seededDb(path = ":memory:", year = 2026) {
  const db = openWritableDb(path);
  replaceYear(db, year, rows.filter(isAzores).map(toContract));
  return db;
}
