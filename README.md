# joraa-mcp

**Dados públicos dos Açores ao alcance de qualquer cliente MCP.**

Servidor [Model Context Protocol](https://modelcontextprotocol.io) para pesquisar a contratação pública da Região Autónoma dos Açores e, em breve, o Jornal Oficial da Região (JORAA). Cada resultado traz sempre a ligação para a fonte oficial.

[![Licença: MIT](https://img.shields.io/badge/licen%C3%A7a-MIT-blue.svg)](LICENSE)
[![Runtime: Bun](https://img.shields.io/badge/runtime-Bun-f9f1e1.svg)](https://bun.sh)
[![MCP](https://img.shields.io/badge/protocolo-MCP-6e56cf.svg)](https://modelcontextprotocol.io)

---

## Índice

- [O que faz](#o-que-faz)
- [Prompts e recurso](#prompts-e-recurso)
- [Início rápido](#início-rápido)
- [Configuração num cliente MCP](#configuração-num-cliente-mcp)
- [Modo HTTP](#modo-http)
- [Implementação atrás de nginx (TLS)](#implementação-atrás-de-nginx-tls)
- [Fontes e termos](#fontes-e-termos)
- [Princípios](#princípios)
- [Desenvolvimento](#desenvolvimento)
- [Licença](#licença)

## O que faz

| Ferramenta | Estado | Descrição |
| --- | --- | --- |
| `contracts_search` | Disponível | Contratos públicos executados nos Açores, filtrados por entidade adjudicante (nome ou NIF), palavras do objeto e datas de celebração. Devolve a entidade, os adjudicatários, o objeto, o valor em euros, a data e a ligação para o contrato no Portal BASE. |
| `avisos_search` | Disponível | Avisos de financiamento do PT2030 e do plano de avisos do Açores 2030, filtrados por palavras, programa, estado, tipo de beneficiário e data dentro da janela de candidatura. Devolve o código, o título, o programa, os fundos, os objetivos, o montante em euros, o estado, a janela, o tipo de beneficiário e a ligação para a fonte. |
| `joraa_search` · `joraa_get` | Em desenvolvimento | Publicações do Jornal Oficial por tema, data, série ou entidade, com ligação para o PDF oficial. Aguarda uma via de acesso acordada com o Centro de Edição do Jornal Oficial. |

Um contrato conta como açoriano quando o local de execução refere os Açores ou o código NUTS começa por `PT2`. Os campos que a fonte não fornece vêm a `null` e nunca são inferidos.

Na pesquisa de texto, cada palavra tem de aparecer no contrato: `query: "software licenças"` só devolve contratos com as duas. Para procurar por tema, faz uma pesquisa por palavra e junta os resultados. No campo `entity`, as palavras genéricas como "Câmara", "Municipal", "Município", "Região" ou "Secretaria" são ignoradas quando há outras, porque a grafia oficial de uma entidade muda de ano para ano na fonte. Assim, "Câmara Municipal de Angra do Heroísmo" e "Município de Angra do Heroísmo" encontram os mesmos contratos.

### Avisos de financiamento

`avisos_search` junta duas fontes que nunca se cruzam: cada resultado indica a sua em `source`.

- **Folha nacional PT2030** (`pt2030_xlsx`): uma linha por aviso, fundo e objetivo, com estado e montante. Não traz datas de candidatura nem tipo de beneficiário, que vêm a `null`.
- **Plano de avisos do Açores 2030** (`acores2030_plano`): janelas de candidatura e tipo de beneficiário. Não traz estado, que vem a `null`.

O estado ("Aberto" ou "Fechado") é o da data do instantâneo da fonte (`snapshot_date`), não o de hoje. Um aviso repartido por vários fundos ou objetivos aparece uma vez por programa, com o montante somado. Nenhuma fonte indica a dimensão da empresa (micro, pequena), por isso não há filtro de dimensão. `beneficiary: "privada"` também encontra avisos para entidades "Pública/Privada".

## Prompts e recurso

Os prompts fornecem instruções ao cliente MCP para consultar as ferramentas e apresentar os resultados com as respetivas fontes. Os argumentos com `?` são opcionais; as datas usam `AAAA-MM-DD`.

| Prompt ou recurso | Argumentos | Utilização |
| --- | --- | --- |
| `contratos_entidade` | `entidade`, `desde?`, `ate?` | Obtém até 100 contratos da entidade, lista os maiores valores dentro desses resultados e os fornecedores claramente empresariais. Não conta, ordena nem agrupa pessoas singulares. |
| `avisos_empresa` | `beneficiario?`, `tema?`, `data?` | Faz duas pesquisas: estado "Aberto" na folha nacional; janela de candidatura e tipo de beneficiário no plano regional. Sem data, usa a data de hoje nos Açores. O estado nacional é o do instantâneo, não o de hoje; não há filtro de dimensão da empresa. |
| `mapa_mercado` | `tema`, `palavras?`, `desde?` | Faz uma pesquisa por palavra, com até 100 resultados por chamada, elimina duplicados por `id` e resume compradores e valores. `palavras` separa-se por vírgulas; se omitido, usa as palavras de `tema`. |
| `joraa://fontes` | — | Recurso Markdown com fontes, contagens dos índices, anos importados, datas de atualização e limitações, lido no momento do pedido. Índices indisponíveis ou vazios indicam como importar os dados. |

As pesquisas de contratos devolvem os mais recentes, não os de maior valor. As contagens dos prompts referem-se aos resultados obtidos; quando uma chamada chega a 100, são apresentadas como limites inferiores. Os campos a `null` continuam desconhecidos e não são substituídos por zero. A pesquisa `query` mantém o AND estrito.

## Início rápido

Requer [Bun](https://bun.sh) (testado com a versão 1.4.3).

```bash
git clone https://github.com/Matos182/joraa-mcp.git
cd joraa-mcp
bun install

# Importa os contratos do ano corrente (ou indica os anos: bun run ingest 2026 2025)
bun run ingest
# Cobertura completa: todos os anos publicados, de 2012 ao corrente
bun run ingest $(seq 2012 "$(date +%Y)")

# Importa os avisos de financiamento (opcional)
bun run ingest:avisos

# Arranca o servidor em stdio
bun run start
```

O índice fica em `data/contracts.sqlite`. Para usar outro caminho, define `JORAA_MCP_DB`.

- **O índice só cobre os anos importados.** Sem argumentos, o ingest importa apenas o ano corrente; para pesquisar desde 2012, indica todos os anos, como acima.
- **Só o ingest escreve.** O servidor abre o índice só para leitura e não arranca se o ficheiro não existir: primeiro corre `bun run ingest`. Um índice criado por uma versão anterior, com outro esquema, é recusado e tem de ser importado de novo.
- **Cada ano é substituído de uma vez**, numa só transação: os contratos que desapareceram da fonte saem do índice. Um ficheiro sem contratos dos Açores é recusado e deixa o índice como estava, e as linhas sem `idcontrato` são rejeitadas.
- **Avisos num índice próprio.** `bun run ingest:avisos` cria `data/avisos.sqlite` (outro caminho: `JORAA_MCP_AVISOS_DB`) e substitui tudo numa só transação. Se uma das fontes não devolver avisos, o índice fica como estava. Sem este índice, o servidor arranca na mesma e só `avisos_search` responde com erro a pedir o ingest.
- **Downloads controlados.** Só por https e só de `dados.gov.pt` (e de `acores.portugal2030.pt`, para os avisos). Cada redirecionamento volta a ser verificado, e cada pedido tem um tempo limite e um teto de bytes (`JORAA_MCP_MAX_DOWNLOAD_BYTES`, 512 MiB por omissão).

## Configuração num cliente MCP

O servidor fala MCP por `stdio`. A configuração genérica, usada pela maioria dos clientes:

```json
{
  "mcpServers": {
    "joraa": {
      "command": "bun",
      "args": ["/caminho/para/joraa-mcp/src/index.ts"]
    }
  }
}
```

No Claude Desktop, o ficheiro `claude_desktop_config.json` fica em `~/Library/Application Support/Claude/` no macOS e em `%APPDATA%\Claude\` no Windows. Usa o mesmo bloco JSON, ajusta o caminho e reinicia a aplicação depois de editar:

```json
{
  "mcpServers": {
    "joraa": {
      "command": "bun",
      "args": ["/caminho/para/joraa-mcp/src/index.ts"]
    }
  }
}
```

Em clientes de linha de comando que aceitam registo direto, por exemplo:

```bash
claude mcp add joraa -- bun /caminho/para/joraa-mcp/src/index.ts
```

Para inspecionar as ferramentas e os schemas:

```bash
bunx @modelcontextprotocol/inspector bun src/index.ts
```

## Modo HTTP

Para servir o MCP como serviço remoto (Streamable HTTP, sem estado), em `POST /mcp`:

```bash
bun run serve
```

| Variável | Por omissão | Função |
| --- | --- | --- |
| `PORT` | `3000` | Porta de escuta. |
| `HOST` | `127.0.0.1` | Interface de escuta. |
| `JORAA_MCP_ALLOWED_HOSTS` | (vazio) | Nomes aceites no cabeçalho `Host`, separados por vírgulas. O loopback é sempre aceite. |
| `JORAA_MCP_ALLOWED_ORIGINS` | (vazio) | Origens de browser autorizadas. Pedidos com outro `Origin` recebem 403. |
| `JORAA_MCP_CACHE_TTL_MS` | `3600000` | Validade da cache dos pedidos às fontes. |
| `JORAA_MCP_DB` | `data/contracts.sqlite` | Caminho do índice de contratos. |
| `JORAA_MCP_AVISOS_DB` | `data/avisos.sqlite` | Caminho do índice de avisos. |
| `JORAA_MCP_MAX_DOWNLOAD_BYTES` | `536870912` | Teto de bytes de cada download do ingest. |

O servidor recusa:

- um `Host` malformado ou fora da lista (421, proteção contra DNS rebinding);
- um `Origin` não autorizado ou vazio (403);
- métodos diferentes de `POST` (405);
- *batches* JSON-RPC (400);
- corpos acima de 64 KiB (413).

Os erros internos respondem só `Internal Server Error`, sem detalhes.

`GET /health` responde `{"ok":true,"contracts":N,"last_ingest":"…"}` quando o índice tem contratos. Com o índice vazio ou ilegível responde 503 com `"ok":false`. Aceita só `GET`.

## Implementação atrás de nginx (TLS)

A pasta `deploy/` tem um proxy nginx pronto a usar, com TLS 1.2/1.3, cifras do perfil *intermediate* e limitação de pedidos.

```bash
# 1. Certificado autoassinado (EC P-256) para o nome escolhido
bun deploy/gen-cert.ts mcp.example.test

# 2. Servidor, com o nome permitido
JORAA_MCP_ALLOWED_HOSTS=mcp.example.test bun run serve

# 3. Proxy, validação da configuração e testes através de TLS
docker compose -f deploy/compose.yaml up -d
docker compose -f deploy/compose.yaml exec nginx nginx -t
bun test test/proxy.test.ts
```

O nginx escuta em `127.0.0.1:8443` e chega ao Bun em `127.0.0.1:3000` através de `network_mode: host`. O `server_name` em `deploy/nginx.conf` é `mcp.example.test`: tem de ser o nome do certificado e de `JORAA_MCP_ALLOWED_HOSTS`. Para expor o serviço na rede, altera as duas diretivas `listen` para a interface pretendida e aponta os clientes para `https://<nome>:8443/mcp`.

O contentor do nginx corre com `cap_drop: [ALL]` e só `CHOWN`, `SETGID` e `SETUID`. Sem `DAC_OVERRIDE`, o root do contentor só lê a chave (`0600`) se for o dono do ficheiro, o que acontece com Docker rootless. Com Docker de root, dá a chave ao grupo do serviço (`chmod 640` e `chgrp`) e acrescenta esse grupo em `group_add`. Os testes do proxy leem o certificado de `JORAA_CERT_DIR`, se definido, tal como `deploy/gen-cert.ts`.

| Camada | Responsabilidade |
| --- | --- |
| nginx | TLS; só o `server_name` configurado recebe resposta, qualquer outro Host vê a ligação fechada (444); limite de 10 pedidos/s por IP em `/mcp` (`burst=20`) e de 2 pedidos/s em `/health` e no resto (`burst=10`), com recusa imediata e 429; até 10 ligações simultâneas por IP (429); prazos de 10 s para cabeçalhos e corpo; primeiro corte do tamanho do corpo (64 KiB, 413). |
| `serve.ts` | Verificação de `Host` (421) e `Origin` (403); leitura do corpo com teto de 64 KiB (413) antes do transporte MCP; recusa de *batches* (400). |
| Schemas Zod | Forma e limites dos argumentos de cada ferramenta, por exemplo `limit` ≤ 100 e até 200 caracteres em `entity` e `query`. A pesquisa usa no máximo 8 palavras de 2 ou mais letras por campo. |

Notas de configuração:

- **Sem porta HTTP.** Um redirecionamento 301/302 pode transformar um `POST` em `GET`, e com 307/308 o corpo JSON-RPC já teria atravessado a rede em claro.
- **O `Host` original é encaminhado** para que a decisão continue no `serve.ts`. Todos os `proxy_set_header` ficam ao nível de `server`: um só dentro de `location` descarta os herdados e o `Host` passa a ser o nome do upstream.
- **Os certificados** ficam em `deploy/certs/`, fora do Git. Os clientes têm de confiar em `deploy/certs/joraa.crt`. O gerador exige `--force` para substituir ficheiros e aceita `JORAA_CERT_DIR` para outro diretório.
- **Os testes do proxy** validam o TLS com essa CA, ligam-se por omissão a `https://127.0.0.1:8443` (ou a `JORAA_PROXY_URL`) e ficam ignorados quando o proxy não está a correr.

## Fontes e termos

| Fonte | Origem | Utilização |
| --- | --- | --- |
| Contratos públicos | Dataset do IMPIC *Contratos Públicos — Portal BASE*, em [dados.gov.pt](https://dados.gov.pt/pt/datasets/66d72d488ca4b7cb2de28712/) | Dados abertos, atualizados semanalmente. Um ficheiro por ano, de 2012 em diante. |
| Avisos PT2030 | Dataset *Avisos PT2030*, em [dados.gov.pt](https://dados.gov.pt/pt/datasets/65afddb4bca3f3b9c6aac069/) | Folha de cálculo mensal; usa-se só o ficheiro `02-datasets-avisos-pt2030-*.xlsx`. O dataset não indica licença (`notspecified`). Montantes publicados em milhares de euros, convertidos para euros. |
| Plano de avisos Açores 2030 | API pública de [acores.portugal2030.pt](https://acores.portugal2030.pt) | Lista paginada dos avisos planeados. O ingest guarda só os campos do aviso e nunca descarrega os PDFs. |
| Jornal Oficial | [jo.azores.gov.pt](https://jo.azores.gov.pt), Centro de Edição do Jornal Oficial | A integração só será ativada através de uma via de acesso acordada com a entidade. |

Todos os pedidos às fontes levam um `User-Agent` que identifica o projeto e o repositório, passam por uma cache local e não usam técnicas de contorno de proteções anti-bot.

## Princípios

- **A fonte oficial primeiro.** Cada resultado aponta para o documento original.
- **Nada inventado.** Um campo ausente na fonte é `null`.
- **Pessoas singulares protegidas.** A pesquisa de texto cobre a entidade adjudicante e o objeto, nunca os adjudicatários, e o servidor não cruza dados de pessoas entre contratos.
- **Respeito pelas fontes.** Poucos pedidos, cache e identificação clara.

## Desenvolvimento

```bash
bun test          # testes (os do proxy ficam ignorados sem o proxy ativo)
bun run typecheck # verificação de tipos
```

Contribuições são bem-vindas. Abre uma *issue* antes de alterações maiores.

## Licença

[MIT](LICENSE) © 2026 Fábio Matos
