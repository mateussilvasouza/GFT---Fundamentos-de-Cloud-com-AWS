# AWS Step Functions — Anotações de Estudo

## O que é AWS Step Functions?

AWS Step Functions é um serviço de **orquestração serverless** que permite coordenar componentes distribuídos de uma aplicação usando **fluxos de trabalho visuais**. Em vez de costurar lógica de orquestração dentro do código de cada serviço, o Step Functions centraliza essa lógica em uma **State Machine**.

**Problema que resolve:** em sistemas distribuídos, coordenar a ordem de execução, lidar com falhas parciais e manter o estado entre passos é extremamente complexo. Step Functions abstrai essa complexidade.

---

## Amazon States Language (ASL)

State Machines são definidas em **ASL**, um formato JSON (ou YAML) com estrutura padronizada:

```json
{
  "Comment": "Descrição opcional do workflow",
  "StartAt": "NomeDoEstadoInicial",
  "States": {
    "NomeDoEstado": {
      "Type": "Task|Choice|Wait|Parallel|Map|Pass|Succeed|Fail",
      "Next": "ProximoEstado",
      "End": true
    }
  }
}
```

### Campos obrigatórios
- `StartAt` — nome do estado inicial
- `States` — mapa com todos os estados
- Cada estado precisa de `Type` e (`Next` ou `End: true`)

---

## Tipos de Estado em Detalhe

### Task
Executa uma unidade de trabalho delegada a um serviço AWS.

```json
"InvocarLambda": {
  "Type": "Task",
  "Resource": "arn:aws:states:::lambda:invoke",
  "Parameters": {
    "FunctionName": "minha-funcao",
    "Payload.$": "$"
  },
  "Next": "ProximoPasso"
}
```

Integrações suportadas (Optimized): Lambda, DynamoDB, SNS, SQS, ECS, Glue, SageMaker, Bedrock, e mais de 220 serviços via SDK integration.

**Dois padrões de integração:**
- **Request/Response** (padrão) — Step Functions envia a requisição e avança imediatamente
- **`.sync`** — aguarda o job terminar (ex: ECS task, Glue job)
- **`.waitForTaskToken`** — pausa até receber um callback com o token

### Choice
Ramificação condicional sem executar trabalho. Equivalente a um `if/else if/else`.

```json
"VerificarEstoque": {
  "Type": "Choice",
  "Choices": [
    {
      "Variable": "$.quantidade",
      "NumericGreaterThan": 0,
      "Next": "ProcessarPedido"
    }
  ],
  "Default": "ProdutoSemEstoque"
}
```

Operadores disponíveis: `StringEquals`, `NumericGreaterThan`, `BooleanEquals`, `IsPresent`, `IsNull`, `And`, `Or`, `Not`, e outros.

### Wait
Pausa a execução por um período determinado.

```json
"AguardarConfirmacao": {
  "Type": "Wait",
  "Seconds": 30,
  "Next": "VerificarStatus"
}
```

Opções: `Seconds`, `Timestamp`, `SecondsPath` (do input), `TimestampPath` (do input).

### Parallel
Executa múltiplos branches simultaneamente. A execução só avança quando **todos** os branches terminam.

```json
"ProcessarEmParalelo": {
  "Type": "Parallel",
  "Branches": [
    { "StartAt": "EnviarEmail", "States": { ... } },
    { "StartAt": "AtualizarBanco", "States": { ... } }
  ],
  "Next": "Finalizar"
}
```

O resultado é um array com a saída de cada branch.

### Map
Itera sobre cada item de um array, executando o mesmo fluxo para cada um. Equivalente a um `forEach` paralelo.

```json
"ProcessarItens": {
  "Type": "Map",
  "ItemsPath": "$.itens",
  "MaxConcurrency": 5,
  "Iterator": {
    "StartAt": "ProcessarItem",
    "States": { ... }
  },
  "Next": "Finalizar"
}
```

`MaxConcurrency: 0` significa sem limite. `MaxConcurrency: 1` é processamento sequencial.

### Pass
Transforma ou injeta dados sem executar trabalho externo. Útil para testes e transformações simples.

```json
"InjetarDefaults": {
  "Type": "Pass",
  "Result": { "status": "pendente" },
  "ResultPath": "$.metadata",
  "Next": "ProximoPasso"
}
```

---

## Input/Output Processing

Um dos conceitos mais importantes do Step Functions: como os dados fluem entre estados.

| Campo | O que faz |
| ----- | --------- |
| `InputPath` | Filtra parte do input do estado |
| `Parameters` | Constrói o payload enviado ao serviço (suporta `.$` para referenciar dados dinâmicos) |
| `ResultSelector` | Filtra/transforma o resultado bruto do serviço |
| `ResultPath` | Define onde o resultado é inserido no estado (ex: `$.resultado`) |
| `OutputPath` | Filtra o que vai para o próximo estado |

Sufixo `.$` em qualquer campo indica que o valor é uma **referência** ao input (usando JsonPath).

**Exemplo:** `"FunctionName.$": "$.lambdaArn"` — pega o ARN da Lambda do input em vez de hardcodá-lo.

---

## Tratamento de Erros

### Retry
Tentativas automáticas em caso de falha. Configurado por lista de erros:

```json
"Retry": [
  {
    "ErrorEquals": ["Lambda.ServiceException", "Lambda.TooManyRequestsException"],
    "IntervalSeconds": 2,
    "MaxAttempts": 3,
    "BackoffRate": 2
  }
]
```

- `BackoffRate`: multiplicador do intervalo a cada tentativa (backoff exponencial)
- `MaxAttempts: 0` desativa retentativas para aquele erro

### Catch
Captura erros após esgotar retentativas e redireciona o fluxo:

```json
"Catch": [
  {
    "ErrorEquals": ["States.ALL"],
    "ResultPath": "$.erro",
    "Next": "TratarErro"
  }
]
```

`States.ALL` captura qualquer erro. Erros built-in incluem: `States.Timeout`, `States.TaskFailed`, `States.HeartbeatTimeout`.

### Ordem de avaliação
1. `Retry` tenta primeiro
2. Após esgotar retentativas, `Catch` intercepta
3. Se nenhum `Catch` bate, a execução falha

---

## Standard vs Express Workflows

| Característica | Standard | Express |
| -------------- | -------- | ------- |
| Duração máx. | 1 ano | 5 minutos |
| Taxa de execução | 2.000/s | 100.000/s |
| Execuções simultâneas | 1 milhão | Ilimitado |
| Semântica de execução | Exatamente uma vez | Pelo menos uma vez |
| Histórico de execução | Console + CloudWatch | Apenas CloudWatch Logs |
| Custo | Por transição de estado | Por execução + GB/s |

**Quando usar Standard:** processos longos, pedidos de e-commerce, workflows de aprovação humana, processos que precisam de auditoria.

**Quando usar Express:** IoT, ingestão de dados em tempo real, processamento de eventos de alta frequência.

---

## Padrões de Uso Comuns

### 1. Orquestração de Microserviços
Coordena múltiplas Lambdas em sequência, com tratamento de erros centralizado. Elimina dependências diretas entre funções.

### 2. Human in the Loop
Usa `.waitForTaskToken` para pausar o workflow até uma aprovação humana (via e-mail, app, etc.). O humano envia o token de volta para retomar.

### 3. Saga Pattern (Compensating Transactions)
Em transações distribuídas, se um passo falha, `Catch` dispara ações de compensação para desfazer o que foi feito anteriormente.

### 4. Fan-out / Fan-in
`Parallel` ou `Map` lança processamento simultâneo. Step Functions agrega os resultados antes de prosseguir.

### 5. ETL e Data Pipelines
Coordena jobs Glue, consultas Athena e chamadas SageMaker em sequência com dependências.

---

## Monitoramento e Observabilidade

- **Console AWS:** visualização gráfica de cada execução, estado ativo em tempo real
- **CloudWatch Metrics:** `ExecutionsStarted`, `ExecutionsFailed`, `ExecutionTime`
- **CloudWatch Logs:** log de cada transição de estado (configurável por nível: ERROR, ALL, OFF)
- **X-Ray:** rastreamento distribuído pelo workflow inteiro, incluindo chamadas Lambda
- **EventBridge:** eventos de mudança de status da execução (started, succeeded, failed)

---

## Boas Práticas

1. **Funções Lambda idempotentes** — Standard Workflow garante exatamente uma execução, mas Retry pode re-invocar. Projete Lambdas que tolerem execuções duplicadas.

2. **Não coloque lógica de orquestração dentro da Lambda** — se uma Lambda chama outra Lambda, considere mover esse controle para o Step Functions.

3. **Use ResultPath para preservar o input original** — `"ResultPath": "$.resultado"` insere o output no campo `resultado` sem sobrescrever o input.

4. **Timeouts explícitos** — sempre configure `TimeoutSeconds` nos estados `Task` para evitar execuções travadas indefinidamente.

5. **Limite o tamanho do payload** — o estado interno tem limite de 256 KB. Para dados maiores, salve no S3 e passe apenas a referência.

6. **Prefira SDK Integration para novos serviços** — usando `arn:aws:states:::aws-sdk:serviceName:apiAction` você acessa qualquer API da AWS sem precisar de uma Lambda intermediária.

---

## Integração com Outros Serviços

```
Step Functions
├── AWS Lambda         → Lógica de negócio customizada
├── Amazon DynamoDB    → Persistência de estado, PutItem, GetItem
├── Amazon SNS         → Notificações, fan-out de mensagens
├── Amazon SQS         → Fila de mensagens, desacoplamento
├── AWS Glue           → Jobs de ETL (.sync aguarda conclusão)
├── Amazon ECS/Fargate → Containers de longa duração
├── Amazon Bedrock     → Chamadas a modelos de IA generativa
├── Amazon SageMaker   → Treinamento e inferência de ML
└── Amazon EventBridge → Disparar execuções por eventos
```

---

## Custo (referência)

- **Standard:** $0,025 por 1.000 transições de estado
- **Express:** $1,00 por 1 milhão de execuções + $0,00001 por GB/s de duração
- **Free tier:** 4.000 transições/mês (Standard) | 1 milhão de execuções/mês (Express)

---

## Lições Práticas — Implementação do Pokemon CSV Export

Registro dos erros reais encontrados ao implementar o pipeline de exportação de 1025 Pokémons, e o raciocínio por trás de cada solução.

### 1. Express vs Standard: a escolha errada tem consequências sérias

**Problema:** a state machine foi criada como Express Workflow. Quando o API Gateway tentou chamar `DescribeExecution` para verificar o status, a operação retornou erro — Express Workflow não suporta `DescribeExecution`.

**Causa raiz:** Express é pensado para eventos de alta frequência e curta duração. O histórico de execução fica apenas nos logs do CloudWatch — não há API para consultar o status de uma execução específica em andamento.

**Solução:** deletar a state machine e recriar como **Standard Workflow**. O tipo não pode ser alterado em uma state machine existente.

**Regra:** se o fluxo precisa de `DescribeExecution` (padrão async de polling), use **Standard** obrigatoriamente.

---

### 2. O limite de 29 segundos do API Gateway exige padrão assíncrono

**Problema:** buscar 1025 Pokémons leva entre 40–90 segundos. O API Gateway tem um timeout fixo e inegociável de 29 segundos — qualquer integração que demore mais retorna `{"message": "Endpoint request timed out"}`.

**Solução:** padrão assíncrono com dois endpoints:

| Endpoint | Action | Comportamento |
| -------- | ------ | ------------- |
| `GET /pokemon/export` | `StartExecution` | Retorna imediatamente com `executionArn` |
| `GET /pokemon/export/status?arn=xxx` | `DescribeExecution` | Retorna status + `downloadUrl` quando pronto |

O browser faz polling no segundo endpoint a cada 5 segundos. Quando o status for `SUCCEEDED`, extrai a `downloadUrl` e dispara o download.

**Importante:** só funciona com Standard Workflow (ver lição 1).

---

### 3. IAM: StartExecution e DescribeExecution precisam de ARNs diferentes

**Problema:** após configurar `DescribeExecution`, o API Gateway retornou `AccessDeniedException`. A policy IAM estava correta quanto às actions, mas o `Resource` apontava para o ARN da state machine nos dois casos.

**Causa raiz:** `DescribeExecution` opera sobre uma **execução** (`execution:`), não sobre a state machine. São recursos distintos e precisam de ARNs distintos:

```json
{
  "Statement": [
    {
      "Action": "states:StartExecution",
      "Resource": "arn:aws:states:REGION:ACCOUNT:stateMachine:NomeDaStateMachine"
    },
    {
      "Action": "states:DescribeExecution",
      "Resource": "arn:aws:states:REGION:ACCOUNT:execution:NomeDaStateMachine:*"
    }
  ]
}
```

O `*` no final do ARN de execução cobre todas as execuções da state machine.

---

### 4. PokeAPI: pokémons com formas precisam de fallback

**Problema:** `fetch-pokemon-list` usa `/pokemon-species` para buscar os 1025 Pokémons base. Mas alguns nomes de species (ex: `wormadam`, `deoxys`, `giratina`) não existem no endpoint `/pokemon/{name}` — retornam 404. Esses Pokémons só existem com o nome da forma padrão (ex: `wormadam-plant`, `deoxys-normal`).

**Solução no `fetch-pokemon-batch`:** quando `/pokemon/{name}` retorna 404, busca a URL da species (que veio no item do batch), lê o campo `varieties`, encontra aquela com `is_default: true`, e busca o Pokémon pela URL da variedade.

```
/pokemon/wormadam          → 404
/pokemon-species/wormadam  → varieties: [{is_default: true, pokemon: {url: ".../wormadam-plant"}}]
/pokemon/wormadam-plant    → 200 ✓
```

---

### 5. PokeAPI rate limit exige retry e concorrência controlada

**Problema:** com `MaxConcurrency: 5` no Map state, múltiplos batches sendo processados em paralelo geravam muitas requisições simultâneas à PokeAPI, que respondia com `502 Bad Gateway` para alguns pokémons.

**Solução em duas partes:**

1. **Reduzir `MaxConcurrency` para 3** no Map state — menos batches rodando ao mesmo tempo
2. **Retry com backoff exponencial** no `fetchJson` da Lambda: em 502, 503 ou 429, aguarda 500ms × tentativa antes de tentar novamente (até 4 tentativas)

**Resultado:** zero falhas de rate limit na execução final.

---

### 6. Mapping template do API Gateway: $input.body vs $util.parseJson

**Problema:** o template de resposta do endpoint `/export` usava `$input.path('$.executionArn')` para extrair o ARN, mas retornava string vazia.

**Causa raiz:** `$input.path()` interpreta o JSON de resposta do Step Functions — e o campo `executionArn` estava presente. Porém, quando o corpo vem como string (não como JSON nativo), o parsing pode falhar silenciosamente.

**Solução:** usar `$util.parseJson($input.body)` para forçar o parse e então acessar os campos:

```velocity
#set($body = $util.parseJson($input.body))
{
  "executionArn": "$body.executionArn",
  "status": "processing"
}
```

---

### 7. Deploy do API Gateway é obrigatório após qualquer mudança

**Problema:** alterações nos mapping templates não têm efeito imediato — o comportamento antigo persiste. Isso causou confusão ao debugar porque o código parecia certo mas o resultado não mudava.

**Regra:** após qualquer mudança em integração, template ou método, sempre clicar em **Ações → Implantar API** para o stage em uso. Sem deploy, nenhuma mudança entra em produção.
