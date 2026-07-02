# AWS CLI — Command Line Interface

## O que é

A AWS CLI é uma ferramenta de linha de comando que permite interagir com todos os serviços AWS diretamente do terminal. É essencial para automação, scripts de CI/CD e operações rápidas sem precisar abrir o console.

**Casos de uso:** scripts de deploy, automação de infraestrutura, integração com CI/CD, diagnóstico rápido de recursos.

---

## Instalação

```bash
# Linux (x86_64)
curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"
unzip awscliv2.zip
sudo ./aws/install

# macOS
brew install awscli

# Windows
# Baixar o instalador MSI em: https://awscli.amazonaws.com/AWSCLIV2.msi

# Verificar instalação
aws --version
```

---

## Configuração

### Configuração básica

```bash
aws configure
# AWS Access Key ID: AKIAIOSFODNN7EXAMPLE
# AWS Secret Access Key: wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
# Default region name: sa-east-1
# Default output format: json  (ou: yaml, table, text)
```

As credenciais ficam em `~/.aws/credentials` e a config em `~/.aws/config`.

### Múltiplos perfis (profiles)

```bash
# Criar perfil adicional
aws configure --profile producao

# Usar perfil específico
aws s3 ls --profile producao

# Definir perfil padrão da sessão
export AWS_PROFILE=producao
```

### Arquivo `~/.aws/config` (exemplo)

```ini
[default]
region = sa-east-1
output = json

[profile producao]
region = us-east-1
output = table
role_arn = arn:aws:iam::123456789012:role/AdminRole
source_profile = default
```

### Variáveis de ambiente (útil em CI/CD)

```bash
export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE
export AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI...
export AWS_DEFAULT_REGION=sa-east-1
```

---

## Comandos Essenciais por Serviço

### Identidade e Conta

```bash
# Verificar qual identidade está configurada
aws sts get-caller-identity

# Retorno: Account, UserId, Arn
```

### EC2

```bash
# Listar instâncias
aws ec2 describe-instances \
  --query 'Reservations[*].Instances[*].[InstanceId,State.Name,PublicIpAddress,Tags[?Key==`Name`].Value|[0]]' \
  --output table

# Iniciar / parar instância
aws ec2 start-instances --instance-ids i-0abc123def456789a
aws ec2 stop-instances --instance-ids i-0abc123def456789a

# Criar key pair
aws ec2 create-key-pair --key-name minha-chave --query 'KeyMaterial' --output text > minha-chave.pem
chmod 400 minha-chave.pem
```

### S3

```bash
# Listar buckets
aws s3 ls

# Listar conteúdo de um bucket
aws s3 ls s3://meu-bucket/pasta/

# Upload de arquivo
aws s3 cp arquivo.txt s3://meu-bucket/destino/

# Download de arquivo
aws s3 cp s3://meu-bucket/arquivo.txt ./local/

# Sync de diretório (como rsync)
aws s3 sync ./dist s3://meu-bucket/app/ --delete

# Remover objeto
aws s3 rm s3://meu-bucket/arquivo.txt

# Gerar presigned URL (válida por 1 hora)
aws s3 presign s3://meu-bucket/arquivo.txt --expires-in 3600
```

### Lambda

```bash
# Listar funções
aws lambda list-functions --query 'Functions[*].[FunctionName,Runtime,LastModified]' --output table

# Invocar função
aws lambda invoke \
  --function-name minha-funcao \
  --payload '{"key": "value"}' \
  --cli-binary-format raw-in-base64-out \
  output.json && cat output.json

# Atualizar código (a partir de arquivo zip)
zip -r funcao.zip index.mjs node_modules/
aws lambda update-function-code \
  --function-name minha-funcao \
  --zip-file fileb://funcao.zip

# Ver logs recentes
aws logs tail /aws/lambda/minha-funcao --follow
```

### CloudFormation

```bash
# Criar stack
aws cloudformation create-stack \
  --stack-name minha-stack \
  --template-body file://template.yaml \
  --parameters ParameterKey=Env,ParameterValue=dev \
  --capabilities CAPABILITY_IAM

# Atualizar stack
aws cloudformation update-stack \
  --stack-name minha-stack \
  --template-body file://template.yaml

# Ver status da stack
aws cloudformation describe-stacks --stack-name minha-stack

# Aguardar deploy completar
aws cloudformation wait stack-create-complete --stack-name minha-stack

# Deletar stack
aws cloudformation delete-stack --stack-name minha-stack
```

### IAM

```bash
# Listar usuários
aws iam list-users --output table

# Criar usuário
aws iam create-user --user-name novo-usuario

# Anexar policy
aws iam attach-user-policy \
  --user-name novo-usuario \
  --policy-arn arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess
```

---

## Flags e Recursos Úteis

### `--query` — filtrar saída com JMESPath

```bash
# Pegar só os nomes das funções Lambda
aws lambda list-functions --query 'Functions[*].FunctionName' --output text

# Filtrar instâncias rodando
aws ec2 describe-instances \
  --filters "Name=instance-state-name,Values=running" \
  --query 'Reservations[*].Instances[*].InstanceId' \
  --output text
```

### `--output` — formatos de saída

```bash
--output json    # padrão, para scripts
--output yaml    # legível e estruturado
--output table   # visual, ótimo para leitura rápida
--output text    # bruto, para shell scripts (awk, grep, etc.)
```

### `--dry-run` — simular sem executar (EC2)

```bash
aws ec2 run-instances --dry-run --image-id ami-xxx --instance-type t3.micro
```

### `--no-cli-pager` — desativar paginação

```bash
aws ec2 describe-instances --no-cli-pager
```

---

## Usando a CLI em Scripts Node.js

A CLI pode ser invocada a partir de Node.js via `child_process` para automações simples. Para uso mais robusto, prefira o SDK v3 diretamente.

```javascript
import { execSync } from 'child_process';

// Listar funções Lambda e parsear o JSON
const output = execSync(
  'aws lambda list-functions --output json',
  { encoding: 'utf-8' }
);
const { Functions } = JSON.parse(output);
console.log(Functions.map(f => f.FunctionName));
```

Para scripts de CI/CD em `package.json`:

```json
{
  "scripts": {
    "deploy:lambda": "zip -r funcao.zip index.mjs && aws lambda update-function-code --function-name minha-funcao --zip-file fileb://funcao.zip",
    "sync:s3": "aws s3 sync ./dist s3://meu-bucket --delete",
    "logs": "aws logs tail /aws/lambda/minha-funcao --follow"
  }
}
```

---

## Boas Práticas

1. **Nunca commite credenciais** — use variáveis de ambiente ou IAM roles
2. **Use perfis** (`--profile`) para separar ambientes dev/staging/prod
3. **`--query` + `--output text`** para shell scripts — evita parsear JSON manualmente
4. **`aws cloudformation wait`** em CI/CD — bloqueia até o deploy terminar
5. **`aws logs tail --follow`** para debug em tempo real sem precisar do console
