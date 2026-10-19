# joraa-mcp

**Dados públicos dos Açores ao alcance de qualquer cliente MCP.**

Servidor [Model Context Protocol](https://modelcontextprotocol.io) para pesquisar a contratação pública da Região Autónoma dos Açores e, em breve, o Jornal Oficial da Região (JORAA). Cada resultado traz sempre a ligação para a fonte oficial.

[![Licença: MIT](https://img.shields.io/badge/licen%C3%A7a-MIT-blue.svg)](LICENSE)
[![Runtime: Bun](https://img.shields.io/badge/runtime-Bun-f9f1e1.svg)](https://bun.sh)
[![MCP](https://img.shields.io/badge/protocolo-MCP-6e56cf.svg)](https://modelcontextprotocol.io)

---

## Índice

- [O que faz](#o-que-faz)
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
| `joraa_search` · `joraa_get` | Em desenvolvimento | Publicações do Jornal Oficial por tema, data, série ou entidade, com ligação para o PDF oficial. Aguarda uma via de acesso acordada com o Centro de Edição do Jornal Oficial. |

Um contrato conta como açoriano quando o local de execução refere os Açores ou o código NUTS começa por `PT2`. Os campos que a fonte não fornece vêm a `null` e nunca são inferidos.

## Início rápido

Requer [Bun](https://bun.sh) (testado com a versão 1.4.3).

```bash
git clone https://github.com/Matos182/joraa-mcp.git
cd joraa-mcp
bun install

# Importa os contratos do ano corrente (ou indica os anos: bun run ingest 2026 2025)
bun run ingest

# Arranca o servidor em stdio
bun run start
```

O índice fica em `data/contracts.sqlite`. Para usar outro caminho, define `JORAA_MCP_DB`.

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

O servidor recusa um `Host` fora da lista (421, proteção contra DNS rebinding), um `Origin` não autorizado (403), métodos diferentes de `POST` (405) e corpos acima de 64 KiB. `GET /health` responde `{"ok":true}`.

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

O nginx escuta em `127.0.0.1:8443` e chega ao Bun em `127.0.0.1:3000` através de `network_mode: host`. Para expor o serviço na rede, altera a diretiva `listen` para a interface pretendida e aponta os clientes para `https://<nome>:8443/mcp`.

| Camada | Responsabilidade |
| --- | --- |
| nginx | TLS; limite de 10 pedidos/s por IP em `/mcp` (`burst=20`, recusa imediata com 429); primeiro corte do tamanho do corpo (64 KiB, 413). `/health` fica fora do limite. |
| `serve.ts` | Verificação de `Host` (421) e `Origin` (403); limite de 64 KiB no transporte MCP. |
| Schemas Zod | Forma e limites dos argumentos de cada ferramenta, por exemplo `limit` ≤ 100. |

Notas de configuração:

- **Sem porta HTTP.** Um redirecionamento 301/302 pode transformar um `POST` em `GET`, e com 307/308 o corpo JSON-RPC já teria atravessado a rede em claro.
- **O `Host` original é encaminhado** para que a decisão continue no `serve.ts`. Todos os `proxy_set_header` ficam ao nível de `server`: um só dentro de `location` descarta os herdados e o `Host` passa a ser o nome do upstream.
- **Os certificados** ficam em `deploy/certs/`, fora do Git. Os clientes têm de confiar em `deploy/certs/joraa.crt`. O gerador exige `--force` para substituir ficheiros e aceita `JORAA_CERT_DIR` para outro diretório.
- **Os testes do proxy** validam o TLS com essa CA, ligam-se por omissão a `https://127.0.0.1:8443` (ou a `JORAA_PROXY_URL`) e ficam ignorados quando o proxy não está a correr.

## Fontes e termos

| Fonte | Origem | Utilização |
| --- | --- | --- |
| Contratos públicos | Dataset do IMPIC *Contratos Públicos — Portal BASE*, em [dados.gov.pt](https://dados.gov.pt/pt/datasets/66d72d488ca4b7cb2de28712/) | Dados abertos, atualizados semanalmente. Um ficheiro por ano, de 2012 em diante. |
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
