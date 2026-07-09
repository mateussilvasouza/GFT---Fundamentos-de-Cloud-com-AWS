# Testando o pipeline localmente com LocalStack

Antes de implementar tudo na AWS real (ver [infrastructure.md](./infrastructure.md)), o pipeline completo — 3 Lambdas + Step Functions + S3 — foi validado localmente com **LocalStack**, simulando os serviços AWS num container Docker. Isso permite testar o fluxo inteiro (incluindo o `Map` state com concorrência e chamadas reais à PokeAPI) sem custo e sem depender de uma conta AWS.

## Por que LocalStack

- Simula a API da AWS localmente (S3, Lambda, Step Functions, IAM etc.) via container Docker, na porta `4566`
- `awslocal` é um wrapper do AWS CLI que já aponta para o endpoint local — evita repetir `--endpoint-url=http://localhost:4566` em todo comando
- Permite errar rápido e iterar no `state-machine.json` e nos Lambdas sem esperar deploy real

## Pré-requisitos

```bash
docker ps               # confirma que o container localstack-main está healthy
awslocal --version       # wrapper do aws cli para o endpoint local
awslocal configure list  # confirma região configurada (usado aqui: us-east-1)
```

---

## Passo a passo completo

### 1. Bucket S3 (destino do CSV gerado)

```bash
awslocal s3 mb s3://pokemon-csv-exports-local
awslocal s3 ls   # confirma que foi criado
```

### 2. Empacotar as 3 Lambdas

Nenhuma delas tem dependências em `node_modules` — `fetch` é nativo do Node 22, e o `generate-csv` usa `@aws-sdk/client-s3` / `@aws-sdk/s3-request-presigner`, que já vêm **pré-instalados no runtime gerenciado `nodejs22.x`** (tanto na AWS real quanto na imagem do LocalStack). Por isso basta zipar o `index.mjs` de cada uma:

```bash
cd lambdas/fetch-pokemon-list  && zip function.zip index.mjs && cd -
cd lambdas/fetch-pokemon-batch && zip function.zip index.mjs && cd -
cd lambdas/generate-csv        && zip function.zip index.mjs && cd -
```

### 3. Role de execução das Lambdas (IAM)

```bash
awslocal iam create-role \
  --role-name lambda-execution-role \
  --assume-role-policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Principal": {"Service": "lambda.amazonaws.com"},
      "Action": "sts:AssumeRole"
    }]
  }'
```

### 4. Criar as 3 funções Lambda

```bash
awslocal lambda create-function \
  --function-name fetch-pokemon-list \
  --runtime nodejs22.x \
  --role arn:aws:iam::000000000000:role/lambda-execution-role \
  --handler index.handler \
  --zip-file fileb://lambdas/fetch-pokemon-list/function.zip \
  --timeout 30 --memory-size 256

awslocal lambda create-function \
  --function-name fetch-pokemon-batch \
  --runtime nodejs22.x \
  --role arn:aws:iam::000000000000:role/lambda-execution-role \
  --handler index.handler \
  --zip-file fileb://lambdas/fetch-pokemon-batch/function.zip \
  --timeout 60 --memory-size 256

awslocal lambda create-function \
  --function-name generate-csv \
  --runtime nodejs22.x \
  --role arn:aws:iam::000000000000:role/lambda-execution-role \
  --handler index.handler \
  --zip-file fileb://lambdas/generate-csv/function.zip \
  --timeout 30 --memory-size 512 \
  --environment Variables="{CSV_BUCKET=pokemon-csv-exports-local}"
```

Timeout e memória seguem a tabela definida em [infrastructure.md § 7](./infrastructure.md#7-lambdas).

### 5. Role de execução da Step Functions

```bash
awslocal iam create-role \
  --role-name step-functions-execution-role \
  --assume-role-policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Principal": {"Service": "states.amazonaws.com"},
      "Action": "sts:AssumeRole"
    }]
  }'
```

### 6. Resolver os placeholders do `state-machine.json`

O `state-machine.json` usa `${FetchPokemonListFunctionArn}`, `${FetchPokemonBatchFunctionArn}` e `${GenerateCsvFunctionArn}` como placeholders de template (pensados para substituição via CloudFormation/SAM). O `create-state-machine` **não resolve `${...}` sozinho** — é preciso gerar uma cópia já resolvida:

```bash
sed \
  -e 's|${FetchPokemonListFunctionArn}|arn:aws:lambda:us-east-1:000000000000:function:fetch-pokemon-list|' \
  -e 's|${FetchPokemonBatchFunctionArn}|arn:aws:lambda:us-east-1:000000000000:function:fetch-pokemon-batch|' \
  -e 's|${GenerateCsvFunctionArn}|arn:aws:lambda:us-east-1:000000000000:function:generate-csv|' \
  state-machine.json > state-machine.resolved.json
```

### 7. Criar a state machine

```bash
awslocal stepfunctions create-state-machine \
  --name PokemonCsvExport \
  --definition file://state-machine.resolved.json \
  --role-arn arn:aws:iam::000000000000:role/step-functions-execution-role \
  --type STANDARD
```

### 8. Executar

```bash
awslocal stepfunctions start-execution \
  --state-machine-arn arn:aws:states:us-east-1:000000000000:stateMachine:PokemonCsvExport \
  --input '{}'
```

### 9. Acompanhar e validar o resultado

```bash
# status geral
awslocal stepfunctions describe-execution \
  --execution-arn "<executionArn retornado no passo 8>"

# arquivo gerado no bucket
awslocal s3api list-objects-v2 \
  --bucket pokemon-csv-exports-local \
  --query 'Contents[].{Key:Key,LastModified:LastModified}'
```

---

## Debug: encontrando o erro real de uma execução `FAILED`

Todas as três Tasks do `state-machine.json` (`FetchPokemonList`, o Map de batches, `GenerateCsv`) têm `Catch` apontando para o mesmo estado `ExportError`, que sempre devolve a mensagem genérica:

```
"Erro durante a exportação do CSV. Verifique os logs do CloudWatch."
```

Ou seja, `describe-execution` **nunca diz qual etapa falhou**. Para achar a causa real, event a event:

```bash
awslocal stepfunctions get-execution-history \
  --execution-arn "<executionArn>" \
  --reverse-order
```

Procure por eventos `TaskFailed` / `LambdaFunctionFailed` — o `error`/`cause` ali é o erro de verdade lançado pela Lambda.

---

## Como rodar este caso de teste do zero

Para reexecutar tudo do início (útil depois de alterar código de uma Lambda ou o `state-machine.json`):

```bash
# 1. Limpar recursos antigos (se existirem)
awslocal stepfunctions delete-state-machine \
  --state-machine-arn arn:aws:states:us-east-1:000000000000:stateMachine:PokemonCsvExport
awslocal lambda delete-function --function-name fetch-pokemon-list
awslocal lambda delete-function --function-name fetch-pokemon-batch
awslocal lambda delete-function --function-name generate-csv
awslocal s3 rb s3://pokemon-csv-exports-local --force

# 2. Repetir os passos 1 a 9 acima
```

Para apenas atualizar o código de uma Lambda já criada (sem recriar tudo):

```bash
cd lambdas/generate-csv && zip function.zip index.mjs && cd -
awslocal lambda update-function-code \
  --function-name generate-csv \
  --zip-file fileb://lambdas/generate-csv/function.zip
```

---

## Lições práticas — rodando este projeto no LocalStack

### 1. ARN de IAM tem sintaxe própria — `::` antes da conta

`arn:aws:iam::000000000000:role/nome` — dois-pontos duplo entre `iam` e o account ID, porque recursos IAM não têm região. Escrever `arn:aws:iam:000000000000:role/...` (um só `:`) faz o CLI tentar interpretar `000000000000` como região e falha.

### 2. `--zip-file fileb://` é resolvido a partir do diretório atual

Como as 3 Lambdas geram um `function.zip` de mesmo nome (um por pasta), o caminho relativo só aponta pro zip certo se o comando for executado (ou o caminho completo for passado) a partir da pasta correspondente. Nome de arquivo zip é irrelevante para o Lambda — só os bytes enviados importam.

### 3. Placeholders `${...}` no ASL não são resolvidos pelo CLI

`state-machine.json` foi escrito pensando em substituição via CloudFormation/SAM. O `awslocal stepfunctions create-state-machine` espera um JSON já com os ARNs finais — é preciso gerar essa versão resolvida manualmente (`sed`, `envsubst` ou similar) antes do deploy, tanto local quanto real.

### 4. Variável de ambiente da Lambda não vem de arquivo `.env`

O runtime da Lambda (local ou AWS real) não lê arquivos `.env` do disco — não há `dotenv` importado no código. Um `.env` na pasta do projeto serve só como documentação/referência de quais variáveis são necessárias; o valor efetivo precisa ser passado via `--environment Variables="{CHAVE=valor}"` no `create-function` ou `update-function-configuration`.

### 5. Mensagens de erro genéricas em `Catch` escondem a causa raiz

Como todas as Tasks compartilham o mesmo estado de erro (`ExportError`) com uma `Cause` fixa, `describe-execution` não diferencia "falhou buscando a lista" de "falhou gerando o CSV". `get-execution-history --reverse-order` é o único jeito de achar o erro real por trás de uma execução `FAILED`.

### 6. O "esperar terminar" do Map state é automático, não precisa configurar

O `fetch-pokemon-batch` roda com `Promise.all` dentro do handler (só retorna quando todos os itens do batch terminam) e a integração `arn:aws:states:::lambda:invoke` é síncrona por padrão (Step Functions só avança após a resposta do Lambda). O `Map` state, por semântica própria, só segue para `Next` depois que **todas** as iterações terminam, respeitando `MaxConcurrency`. Nenhum `.sync` ou `waitForTaskToken` é necessário aqui — isso só existe para integrações que rodam jobs assíncronos (ECS, Glue, Batch).

### 7. Tempo de execução é um sinal de diagnóstico

Uma execução que falha em poucos segundos (ex: ~9s) quase certamente não chegou a processar os 21 batches — o problema está nas primeiras etapas (`FetchPokemonList` ou logo no início do `Map`), não em algo tardio como `GenerateCsv`.

---

## Diferenças relevantes: LocalStack vs. AWS real

| Aspecto | LocalStack | AWS real |
| ------- | ---------- | -------- |
| Validação de permissões IAM | Não aplicada por padrão (`ENFORCE_IAM` desligado) | Sempre aplicada — role precisa ter as policies corretas |
| Account ID | Fixo, `000000000000` | ID real da conta |
| Custo | Zero | Cobrado por transição de estado / invocação / storage |
| Acesso à internet (PokeAPI) | Sai pela rede do host/Docker — funciona, mas depende da config de rede local | Sempre funciona (saída padrão da VPC/Lambda) |
| Persistência entre restarts | Efêmera por padrão (a menos que configurado `PERSISTENCE=1`) | Permanente |

Para a implementação final na AWS (console), ver [infrastructure.md](./infrastructure.md).

---

## Referências

- [awscli-local (awslocal)](https://github.com/localstack/awscli-local) — wrapper do AWS CLI usado em todos os comandos deste guia
- [LocalStack — Documentação oficial](https://docs.localstack.cloud/)
