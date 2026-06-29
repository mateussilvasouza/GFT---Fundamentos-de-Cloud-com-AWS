# Infrastructure — Pokemon CSV Export

Documentação da configuração de WAF, API Gateway, Step Functions e recursos de suporte.

## Visão Geral da Arquitetura

O API Gateway tem um **limite fixo de 29 segundos** por requisição. Como buscar 1025 Pokémons leva entre 40-90 segundos, a integração precisa ser **assíncrona**: uma chamada inicia o processo e retorna imediatamente, outra verifica quando terminou.

```
Usuário (Browser)
    │
    │  1. GET /pokemon/export
    ▼
┌─────────────────────────────────────┐
│           AWS WAF WebACL            │  Rate limit: 20 req/min por IP
│   + Bot Control managed rules       │  Bloqueia: scrapers, crawlers, bots
└─────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────┐
│  API Gateway GET /pokemon/export    │  Action: StartExecution (assíncrono)
│                                     │  Retorna imediatamente com executionArn
└─────────────────────────────────────┘
    │  { "executionArn": "...", "status": "processing" }
    ▼
Usuário aguarda (polling) e chama:

    │  2. GET /pokemon/export/status?arn=xxx
    ▼
┌─────────────────────────────────────┐
│  API Gateway GET /export/status     │  Action: DescribeExecution
│                                     │  Retorna status + downloadUrl quando pronto
└─────────────────────────────────────┘
    │
    ▼
┌──────────────────────────────────────────────────────────┐
│           Step Functions Standard Workflow                 │
│                                                           │
│  FetchPokemonList (Lambda)                                │
│      ↓                                                    │
│  FetchAllBatches (Map, MaxConcurrency: 3)                 │
│      └─ FetchPokemonBatch (Lambda × 21 batches)           │
│      ↓                                                    │
│  GenerateCsv (Lambda)                                     │
│      └─ Upload CSV → S3                                   │
│      └─ Retorna presigned URL (válida 5 min)              │
└──────────────────────────────────────────────────────────┘
    │  Quando SUCCEEDED: { "downloadUrl": "...", ... }
    ▼
Browser recebe URL → download automático do CSV
```

---

## 1. Alterar o State Machine para Standard Workflow

O tipo **Express** foi necessário para integração síncrona, mas agora usamos **Standard** — que suporta execuções longas e permite consultar o status via `DescribeExecution`.

No console Step Functions → `PokemonCsvExport` → **Editar** → altere o tipo para **Standard** antes de salvar.

> **Atenção:** ao trocar de Express para Standard, recrie a state machine se necessário — o tipo não pode ser alterado em uma state machine existente. Delete e crie novamente com o mesmo nome e o JSON de `state-machine.json`.

---

## 2. IAM Role para o API Gateway

Crie uma role que o API Gateway usará para chamar o Step Functions.

1. **IAM** → **Roles** → **Create role**
2. **Trusted entity:** AWS service → **API Gateway**
3. **Role name:** `APIGatewayStepFunctionsRole`
4. Após criar, adicione uma **inline policy** com este JSON:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "states:StartExecution",
        "states:DescribeExecution"
      ],
      "Resource": [
        "arn:aws:states:sa-east-1:287717765115:stateMachine:PokemonCsvExport",
        "arn:aws:states:sa-east-1:287717765115:execution:PokemonCsvExport:*"
      ]
    }
  ]
}
```

Copie o **ARN** desta role — será usado nos dois endpoints abaixo.

---

## 3. API Gateway — Endpoint 1: Iniciar exportação

**Recurso:** `GET /pokemon/export`

### Configuração da integração

| Campo | Valor |
| ----- | ----- |
| Tipo de integração | Serviço da AWS |
| Região | `sa-east-1` |
| Serviço | Step Functions |
| Método HTTP | POST |
| Nome da ação | `StartExecution` |
| Perfil de execução | ARN da `APIGatewayStepFunctionsRole` |

### Mapping Template — Solicitação de integração

Em **Solicitação de integração** → **Modelos de mapeamento** → Content-Type `application/json`:

```json
{
  "stateMachineArn": "arn:aws:states:sa-east-1:287717765115:stateMachine:PokemonCsvExport",
  "name": "$context.requestId",
  "input": "{}"
}
```

### Mapping Template — Resposta de integração

Em **Resposta de integração** → **200** → **Modelos de mapeamento** → `application/json`:

```velocity
{
  "executionArn": "$input.path('$.executionArn')",
  "status": "processing"
}
```

---

## 4. API Gateway — Endpoint 2: Verificar status

**Recurso:** `GET /pokemon/export/status`

Criar novo recurso: com `/export` selecionado → **Criar recurso** → nome `status` → **Criar método** → GET.

### Configuração da integração

| Campo | Valor |
| ----- | ----- |
| Tipo de integração | Serviço da AWS |
| Região | `sa-east-1` |
| Serviço | Step Functions |
| Método HTTP | POST |
| Nome da ação | `DescribeExecution` |
| Perfil de execução | ARN da `APIGatewayStepFunctionsRole` |

### Mapping Template — Solicitação de integração

O `executionArn` vem como query string `?arn=xxx`:

```json
{
  "executionArn": "$input.params('arn')"
}
```

### Mapping Template — Resposta de integração

Quando SUCCEEDED, extrai a `downloadUrl` do output. Quando ainda RUNNING, retorna só o status:

```velocity
#set($status = $input.path('$.status'))
#if($status == "SUCCEEDED")
#set($output = $util.parseJson($input.path('$.output')))
{
  "status": "SUCCEEDED",
  "downloadUrl": "$output.downloadUrl",
  "filename": "$output.filename",
  "totalRecords": $output.totalRecords
}
#elseif($status == "RUNNING")
{
  "status": "RUNNING"
}
#else
{
  "status": "$status"
}
#end
```

---

## 5. Deploy do API Gateway

**Ações** → **Implantar API** → stage `develop` → **Implantar**

A URL base gerada será algo como:
```
https://SEU-ID.execute-api.sa-east-1.amazonaws.com/develop
```

> **Atenção:** sempre reimplantar após qualquer alteração em integração ou mapping template — mudanças não entram em vigor até o deploy.

---

## 6. Rate Limiting — Usage Plan (abordagem utilizada)

Em vez do AWS WAF, foi utilizado o **Usage Plan nativo do API Gateway**, que é mais simples de configurar e suficiente para o cenário deste projeto.

### Criar Usage Plan

1. **API Gateway** → **Usage Plans** → **Create**
2. Configure throttling e quota:

| Campo | Valor sugerido |
| ----- | -------------- |
| Throttle — Rate | `20` requests/s |
| Throttle — Burst | `10` |
| Quota | `1.000` requests/dia |

3. Associe o Usage Plan ao stage `develop` da sua API
4. Crie uma **API Key** e associe ao Usage Plan
5. No método `GET /pokemon/export`, marque **API Key Required: true**

O cliente deve enviar o header `x-api-key: SUA_CHAVE` em cada requisição.

### Alternativa: AWS WAF WebACL

Para proteção adicional contra bots e ataques mais sofisticados, o WAF pode ser adicionado em cima do Usage Plan:

1. Abra **WAF & Shield** → **Web ACLs** → **Create web ACL**
2. **Resource type:** Regional — mesma região do API Gateway (`sa-east-1`)
3. **Add AWS resources** → selecionar o stage `develop` do API Gateway
4. Adicione uma regra de **Rate-based** (ex: 20 req/min por IP) e **Bot Control** se necessário

---

## 7. Lambdas

| Função | Runtime | Timeout | Memória | Env var |
| ------ | ------- | ------- | ------- | ------- |
| `fetch-pokemon-list` | Node.js 22.x | 30s | 256MB | — |
| `fetch-pokemon-batch` | Node.js 22.x | 60s | 256MB | — |
| `generate-csv` | Node.js 22.x | 30s | 512MB | `CSV_BUCKET=nome-do-bucket` |

---

## 8. Bucket S3

| Configuração | Valor |
| ------------ | ----- |
| Nome | `pokemon-csv-exports-287717765115` |
| Acesso público | Bloqueado |
| Lifecycle | Expirar `exports/` após 1 dia |

---

## 9. Fluxo completo no browser

```javascript
const API = 'https://SEU-ID.execute-api.sa-east-1.amazonaws.com/prod';

async function exportarPokemonCSV() {
  // 1. Inicia a exportação
  const { executionArn } = await fetch(`${API}/pokemon/export`).then(r => r.json());

  // 2. Faz polling até terminar (verifica a cada 5 segundos)
  let downloadUrl = null;
  while (!downloadUrl) {
    await new Promise(r => setTimeout(r, 5000));

    const result = await fetch(
      `${API}/pokemon/export/status?arn=${encodeURIComponent(executionArn)}`
    ).then(r => r.json());

    if (result.status === 'SUCCEEDED') downloadUrl = result.downloadUrl;
    if (result.status === 'FAILED') throw new Error('Exportação falhou');
  }

  // 3. Dispara o download automaticamente
  const link = document.createElement('a');
  link.href = downloadUrl;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}
```

---

## 10. Monitoramento

| Recurso | Onde verificar |
| ------- | -------------- |
| Execuções Step Functions | Step Functions → State machine → Executions |
| Logs Lambda | CloudWatch → Log groups → `/aws/lambda/NOME` |
| Métricas WAF | WAF console → Web ACL → Metrics |
| Requisições API Gateway | CloudWatch → API Gateway metrics |
