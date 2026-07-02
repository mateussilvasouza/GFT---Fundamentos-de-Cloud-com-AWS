# AWS CloudFormation

## O que é

CloudFormation é o serviço de **Infraestrutura como Código (IaC)** da AWS. Você descreve toda sua infraestrutura em um arquivo de texto (YAML ou JSON — chamado de **template**) e o CloudFormation cria, atualiza e deleta os recursos automaticamente e de forma consistente.

**O problema que resolve:** clicar no console manualmente é lento, propenso a erro e impossível de replicar com exatidão. Com CloudFormation, você versiona a infraestrutura no git, replica ambientes identicamente e audita mudanças.

---

## Conceitos Fundamentais

### Template
Arquivo YAML ou JSON que descreve os recursos. É a "receita" da infraestrutura.

### Stack
Uma instância do template criada na AWS. Quando você cria uma stack, o CloudFormation cria todos os recursos do template. Quando você deleta a stack, todos os recursos são deletados juntos.

### Change Set
Pré-visualização das mudanças antes de aplicar uma atualização. Similar a um `git diff` para infraestrutura.

### Drift Detection
Detecta se algum recurso foi modificado manualmente fora do CloudFormation (divergência entre template e realidade).

---

## Estrutura do Template

```yaml
AWSTemplateFormatVersion: '2010-09-09'
Description: Descrição opcional da stack

# Parâmetros que podem ser passados ao criar/atualizar
Parameters:
  Ambiente:
    Type: String
    Default: dev
    AllowedValues: [dev, staging, prod]
    Description: Ambiente de deploy

# Mapeamentos estáticos
Mappings:
  InstanceTypes:
    dev:
      Type: t3.micro
    prod:
      Type: t3.medium

# Condições baseadas em parâmetros
Conditions:
  IsProducao: !Equals [!Ref Ambiente, prod]

# Recursos — a parte principal
Resources:
  NomeDoRecurso:
    Type: AWS::Servico::TipoDeRecurso
    Properties:
      Propriedade: valor

# Outputs — valores exportados após criação
Outputs:
  NomeDoOutput:
    Value: !Ref NomeDoRecurso
    Export:
      Name: !Sub "${AWS::StackName}-NomeDoRecurso"
```

---

## Funções Intrínsecas Essenciais

| Função | Uso | Exemplo |
| ------ | --- | ------- |
| `!Ref` | Referência a recurso ou parâmetro | `!Ref MinhaLambda` |
| `!GetAtt` | Atributo de um recurso | `!GetAtt MinhaLambda.Arn` |
| `!Sub` | Interpolação de string | `!Sub "arn:aws:s3:::${BucketName}"` |
| `!Join` | Concatenar lista | `!Join [",", [a, b, c]]` |
| `!Select` | Selecionar item de lista | `!Select [0, !GetAZs ""]` |
| `!If` | Condicional | `!If [IsProducao, t3.medium, t3.micro]` |
| `!ImportValue` | Importar output de outra stack | `!ImportValue outra-stack-BucketArn` |
| `!Base64` | Codificar em base64 (User Data) | `!Base64 "#!/bin/bash\necho ok"` |

---

## Exemplos Práticos

### Lambda + Role IAM + API Gateway

```yaml
AWSTemplateFormatVersion: '2010-09-09'
Description: API Node.js com Lambda e API Gateway

Parameters:
  FunctionName:
    Type: String
    Default: minha-api-lambda

Resources:

  # Role IAM para a Lambda
  LambdaRole:
    Type: AWS::IAM::Role
    Properties:
      RoleName: !Sub "${FunctionName}-role"
      AssumeRolePolicyDocument:
        Version: '2012-10-17'
        Statement:
          - Effect: Allow
            Principal:
              Service: lambda.amazonaws.com
            Action: sts:AssumeRole
      ManagedPolicyArns:
        - arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole

  # Função Lambda
  MinhaLambda:
    Type: AWS::Lambda::Function
    Properties:
      FunctionName: !Ref FunctionName
      Runtime: nodejs22.x
      Handler: index.handler
      Role: !GetAtt LambdaRole.Arn
      Timeout: 30
      MemorySize: 256
      Environment:
        Variables:
          NODE_ENV: production
      Code:
        ZipFile: |
          export const handler = async (event) => ({
            statusCode: 200,
            body: JSON.stringify({ message: 'ok' }),
          });

  # API Gateway REST API
  MinhaApi:
    Type: AWS::ApiGateway::RestApi
    Properties:
      Name: !Sub "${FunctionName}-api"

  # Recurso /hello
  HelloResource:
    Type: AWS::ApiGateway::Resource
    Properties:
      RestApiId: !Ref MinhaApi
      ParentId: !GetAtt MinhaApi.RootResourceId
      PathPart: hello

  # Método GET /hello
  HelloGet:
    Type: AWS::ApiGateway::Method
    Properties:
      RestApiId: !Ref MinhaApi
      ResourceId: !Ref HelloResource
      HttpMethod: GET
      AuthorizationType: NONE
      Integration:
        Type: AWS_PROXY
        IntegrationHttpMethod: POST
        Uri: !Sub "arn:aws:apigateway:${AWS::Region}:lambda:path/2015-03-31/functions/${MinhaLambda.Arn}/invocations"

  # Permissão para API Gateway invocar a Lambda
  LambdaPermission:
    Type: AWS::Lambda::Permission
    Properties:
      FunctionName: !Ref MinhaLambda
      Action: lambda:InvokeFunction
      Principal: apigateway.amazonaws.com
      SourceArn: !Sub "arn:aws:execute-api:${AWS::Region}:${AWS::AccountId}:${MinhaApi}/*/GET/hello"

  # Deploy da API
  ApiDeployment:
    Type: AWS::ApiGateway::Deployment
    DependsOn: HelloGet
    Properties:
      RestApiId: !Ref MinhaApi
      StageName: dev

Outputs:
  ApiUrl:
    Value: !Sub "https://${MinhaApi}.execute-api.${AWS::Region}.amazonaws.com/dev/hello"
    Description: URL da API
  LambdaArn:
    Value: !GetAtt MinhaLambda.Arn
```

### Bucket S3 com ciclo de vida

```yaml
Resources:
  MeuBucket:
    Type: AWS::S3::Bucket
    Properties:
      BucketName: !Sub "meu-bucket-${AWS::AccountId}"
      VersioningConfiguration:
        Status: Enabled
      LifecycleConfiguration:
        Rules:
          - Id: ExpirarTemporarios
            Status: Enabled
            Prefix: temp/
            ExpirationInDays: 1
          - Id: MoverParaGlacier
            Status: Enabled
            Prefix: archive/
            Transitions:
              - TransitionInDays: 30
                StorageClass: GLACIER
      PublicAccessBlockConfiguration:
        BlockPublicAcls: true
        BlockPublicPolicy: true
        IgnorePublicAcls: true
        RestrictPublicBuckets: true
```

---

## Comandos CLI

```bash
# Validar template antes de criar
aws cloudformation validate-template --template-body file://template.yaml

# Criar stack
aws cloudformation create-stack \
  --stack-name minha-stack \
  --template-body file://template.yaml \
  --parameters ParameterKey=Ambiente,ParameterValue=dev \
  --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM

# Aguardar criação completar
aws cloudformation wait stack-create-complete --stack-name minha-stack

# Criar Change Set (pré-visualizar mudanças)
aws cloudformation create-change-set \
  --stack-name minha-stack \
  --change-set-name minha-mudanca \
  --template-body file://template.yaml

aws cloudformation describe-change-set \
  --stack-name minha-stack \
  --change-set-name minha-mudanca

# Executar Change Set
aws cloudformation execute-change-set \
  --stack-name minha-stack \
  --change-set-name minha-mudanca

# Atualizar stack diretamente
aws cloudformation update-stack \
  --stack-name minha-stack \
  --template-body file://template.yaml \
  --capabilities CAPABILITY_IAM

# Ver outputs da stack
aws cloudformation describe-stacks \
  --stack-name minha-stack \
  --query 'Stacks[0].Outputs'

# Detectar drift
aws cloudformation detect-stack-drift --stack-name minha-stack

# Deletar stack
aws cloudformation delete-stack --stack-name minha-stack
aws cloudformation wait stack-delete-complete --stack-name minha-stack
```

---

## Usando o SDK v3 com Node.js

```bash
npm install @aws-sdk/client-cloudformation
```

```javascript
import {
  CloudFormationClient,
  CreateStackCommand,
  DescribeStacksCommand,
  waitUntilStackCreateComplete,
} from '@aws-sdk/client-cloudformation';
import { readFileSync } from 'fs';

const client = new CloudFormationClient({ region: 'sa-east-1' });

// Criar stack
await client.send(new CreateStackCommand({
  StackName: 'minha-stack',
  TemplateBody: readFileSync('./template.yaml', 'utf-8'),
  Parameters: [
    { ParameterKey: 'Ambiente', ParameterValue: 'dev' },
  ],
  Capabilities: ['CAPABILITY_IAM', 'CAPABILITY_NAMED_IAM'],
}));

// Aguardar criação
await waitUntilStackCreateComplete(
  { client, maxWaitTime: 600 },
  { StackName: 'minha-stack' }
);

// Ler outputs
const { Stacks } = await client.send(new DescribeStacksCommand({
  StackName: 'minha-stack',
}));

const outputs = Object.fromEntries(
  Stacks[0].Outputs.map(o => [o.OutputKey, o.OutputValue])
);
console.log('API URL:', outputs.ApiUrl);
```

---

## Boas Práticas

1. **Change Sets antes de atualizar produção** — nunca `update-stack` direto em prod sem pré-visualizar
2. **`DeletionPolicy: Retain`** em recursos críticos (RDS, S3) — previne deleção acidental ao remover da stack
3. **`DependsOn` explícito** quando o CloudFormation não detecta dependências automaticamente
4. **Uma stack por ambiente** — `minha-app-dev`, `minha-app-prod` — facilita isolamento
5. **Parâmetros com `AllowedValues`** — valida entradas e evita erros humanos
6. **Outputs + `Export`** para compartilhar recursos entre stacks sem hardcodar ARNs
