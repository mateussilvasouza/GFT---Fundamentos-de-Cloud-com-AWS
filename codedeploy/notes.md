# AWS CodeDeploy

## O que é

CodeDeploy é o serviço da AWS para **automatizar o deploy de aplicações** em instâncias EC2, servidores on-premises, funções Lambda ou containers ECS. Ele elimina a necessidade de entrar manualmente em cada servidor para atualizar código — e oferece estratégias seguras de deploy com rollback automático.

**Casos de uso:** deploy de APIs Node.js em frotas EC2, atualização de funções Lambda sem downtime, rolling deploys com health checks automáticos.

---

## Conceitos Fundamentais

### Application
Agrupamento lógico de deploys. Define o tipo de plataforma (EC2/on-premises, Lambda, ECS).

### Deployment Group
Conjunto de instâncias (ou funções/serviços) que recebe o deploy. Configurado com:
- Quais instâncias (por tags EC2 ou Auto Scaling Group)
- Estratégia de deploy
- Load balancer (opcional)
- Alarmes CloudWatch para rollback automático

### Deployment Configuration
Define a velocidade do deploy:

| Configuração | Descrição |
| ------------ | --------- |
| `CodeDeployDefault.AllAtOnce` | Atualiza todas as instâncias de uma vez (mais rápido, mais arriscado) |
| `CodeDeployDefault.HalfAtATime` | Atualiza 50% de cada vez |
| `CodeDeployDefault.OneAtATime` | Uma instância por vez (mais lento, mais seguro) |
| Custom | Você define a porcentagem/quantidade |

### Revision
O artefato do deploy — normalmente um arquivo ZIP no S3 contendo o código + `appspec.yml`.

### appspec.yml
Arquivo de controle que fica na raiz do pacote e instrui o CodeDeploy a:
- Copiar arquivos para o destino
- Executar scripts em cada fase do deploy (hooks)

---

## appspec.yml para EC2/on-premises

```yaml
version: 0.0
os: linux

files:
  - source: /          # raiz do pacote
    destination: /var/www/minha-api

hooks:
  BeforeInstall:
    - location: scripts/stop_server.sh
      timeout: 30
      runas: root

  AfterInstall:
    - location: scripts/install_deps.sh
      timeout: 120
      runas: ec2-user

  ApplicationStart:
    - location: scripts/start_server.sh
      timeout: 30
      runas: ec2-user

  ValidateService:
    - location: scripts/health_check.sh
      timeout: 30
      runas: ec2-user
```

### Hooks disponíveis (ordem de execução)

```
BeforeBlockTraffic     → antes de remover do load balancer
BlockTraffic           → (automático) remove do load balancer
AfterBlockTraffic      → após remover do load balancer
  │
ApplicationStop        → parar a versão atual
DownloadBundle         → (automático) baixar o artefato
BeforeInstall          → antes de copiar arquivos
Install                → (automático) copiar arquivos
AfterInstall           → após copiar (instalar deps, configurar)
  │
ApplicationStart       → iniciar a nova versão
ValidateService        → verificar se está saudável
  │
BeforeAllowTraffic     → antes de adicionar ao load balancer
AllowTraffic           → (automático) adiciona ao load balancer
AfterAllowTraffic      → após adicionar (log, notificação)
```

---

## Scripts de deploy para aplicação Node.js

### `scripts/stop_server.sh`

```bash
#!/bin/bash
# Para a aplicação antes de instalar a nova versão
if pm2 list | grep -q "minha-api"; then
  pm2 stop minha-api
fi
exit 0
```

### `scripts/install_deps.sh`

```bash
#!/bin/bash
cd /var/www/minha-api
export NVM_DIR="/home/ec2-user/.nvm"
source "$NVM_DIR/nvm.sh"
npm ci --only=production
exit 0
```

### `scripts/start_server.sh`

```bash
#!/bin/bash
cd /var/www/minha-api
export NVM_DIR="/home/ec2-user/.nvm"
source "$NVM_DIR/nvm.sh"
pm2 start index.js --name minha-api || pm2 restart minha-api
pm2 save
exit 0
```

### `scripts/health_check.sh`

```bash
#!/bin/bash
# Verifica se a aplicação está respondendo na porta 3000
for i in {1..10}; do
  if curl -sf http://localhost:3000/health > /dev/null; then
    echo "Health check passou"
    exit 0
  fi
  echo "Tentativa $i falhou, aguardando..."
  sleep 3
done
echo "Health check falhou após 10 tentativas"
exit 1
```

---

## Estrutura do pacote de deploy

```
minha-api/
├── appspec.yml          # obrigatório na raiz
├── scripts/
│   ├── stop_server.sh
│   ├── install_deps.sh
│   ├── start_server.sh
│   └── health_check.sh
├── index.js
├── package.json
└── package-lock.json
```

> **Não inclua `node_modules`** no pacote — o script `install_deps.sh` roda `npm ci` no servidor.

---

## Configurando o deploy

### 1. Instalar o CodeDeploy Agent na EC2

```bash
# Amazon Linux 2023
sudo dnf install ruby wget -y
wget https://aws-codedeploy-sa-east-1.s3.sa-east-1.amazonaws.com/latest/install
chmod +x ./install
sudo ./install auto
sudo systemctl enable codedeploy-agent
sudo systemctl start codedeploy-agent
sudo systemctl status codedeploy-agent
```

### 2. IAM Role para a instância EC2

A instância EC2 precisa de uma role com permissão para baixar o artefato do S3:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:GetObjectVersion"
      ],
      "Resource": "arn:aws:s3:::meu-bucket-deploy/*"
    }
  ]
}
```

### 3. IAM Role para o CodeDeploy

O CodeDeploy precisa de uma role com a policy gerenciada `AWSCodeDeployRole`:

- **Trusted entity:** `codedeploy.amazonaws.com`
- **Policy:** `arn:aws:iam::aws:policy/service-role/AWSCodeDeployRole`

### 4. Criar Application e Deployment Group (console)

1. **CodeDeploy** → **Applications** → **Create application**
   - **Application name:** `minha-api`
   - **Compute platform:** EC2/On-premises

2. **Create deployment group**
   - **Name:** `producao`
   - **Service role:** ARN da role CodeDeploy
   - **Deployment type:** In-place (ou Blue/Green)
   - **Environment:** Amazon EC2 instances → Tag: `Name = minha-api`
   - **Deployment config:** `CodeDeployDefault.OneAtATime`
   - **Load balancer:** selecionar se tiver um

---

## Deploy via CLI

```bash
# 1. Empacotar e enviar para S3
zip -r deploy.zip . -x "node_modules/*" ".git/*"
aws s3 cp deploy.zip s3://meu-bucket-deploy/releases/deploy-$(date +%Y%m%d%H%M%S).zip

# 2. Criar deploy
aws deploy create-deployment \
  --application-name minha-api \
  --deployment-group-name producao \
  --s3-location bucket=meu-bucket-deploy,key=releases/deploy-latest.zip,bundleType=zip \
  --description "Deploy versão 1.2.3"

# 3. Acompanhar status
DEPLOYMENT_ID=$(aws deploy list-deployments \
  --application-name minha-api \
  --deployment-group-name producao \
  --query 'deployments[0]' --output text)

aws deploy get-deployment --deployment-id $DEPLOYMENT_ID \
  --query 'deploymentInfo.status' --output text

# Aguardar conclusão
aws deploy wait deployment-successful --deployment-id $DEPLOYMENT_ID
```

---

## Usando o SDK v3 com Node.js

```bash
npm install @aws-sdk/client-codedeploy
```

```javascript
import {
  CodeDeployClient,
  CreateDeploymentCommand,
  GetDeploymentCommand,
  waitUntilDeploymentSuccessful,
} from '@aws-sdk/client-codedeploy';

const client = new CodeDeployClient({ region: 'sa-east-1' });

// Criar deploy
const { deploymentId } = await client.send(new CreateDeploymentCommand({
  applicationName: 'minha-api',
  deploymentGroupName: 'producao',
  revision: {
    revisionType: 'S3',
    s3Location: {
      bucket: 'meu-bucket-deploy',
      key: 'releases/deploy-latest.zip',
      bundleType: 'zip',
    },
  },
  description: 'Deploy v1.2.3',
}));

console.log('Deploy iniciado:', deploymentId);

// Aguardar conclusão
await waitUntilDeploymentSuccessful(
  { client, maxWaitTime: 600 },
  { deploymentId }
);

// Verificar resultado
const { deploymentInfo } = await client.send(new GetDeploymentCommand({ deploymentId }));
console.log('Status:', deploymentInfo.status);
console.log('Instâncias com sucesso:', deploymentInfo.deploymentOverview.Succeeded);
```

---

## Deploy para Lambda (appspec.yml diferente)

Para Lambda, o `appspec.yml` tem formato diferente:

```yaml
version: 0.0
Resources:
  - MinhaFuncao:
      Type: AWS::Lambda::Function
      Properties:
        Name: minha-api-lambda
        Alias: live
        CurrentVersion: "1"
        TargetVersion: "2"

Hooks:
  - BeforeAllowTraffic: ValidarNovaVersao
  - AfterAllowTraffic: NotificarDeploy
```

Estratégias de deploy para Lambda:

| Estratégia | Comportamento |
| ---------- | ------------- |
| `LambdaAllAtOnce` | Muda 100% do tráfego de uma vez |
| `LambdaLinear10PercentEvery1Minute` | 10% por minuto durante 10 min |
| `LambdaCanary10Percent5Minutes` | 10% por 5 min, depois 100% |

---

## Boas Práticas

1. **Rollback automático** — configure alarmes CloudWatch no Deployment Group; se o alarme disparar, o deploy reverte
2. **Health check em `ValidateService`** — nunca marque o deploy como sucesso sem verificar a aplicação
3. **Blue/Green deploy** em produção — cria um novo conjunto de instâncias, testa, e muda o load balancer; rollback é instantâneo
4. **Scripts idempotentes** — um script de stop que roda duas vezes não deve falhar
5. **`exit 0` em `ApplicationStop`** — se a aplicação não estava rodando, o hook não deve falhar o deploy
6. **Logs do agente** em `/var/log/aws/codedeploy-agent/` para debugar hooks que falham
