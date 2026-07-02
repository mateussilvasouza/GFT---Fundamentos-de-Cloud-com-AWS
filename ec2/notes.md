# Amazon EC2 — Elastic Compute Cloud

## O que é

EC2 é o serviço de **máquinas virtuais da AWS**. Você aluga capacidade computacional na nuvem sem precisar gerenciar hardware físico. Cada instância é um servidor isolado rodando o sistema operacional e software que você escolher.

**Casos de uso:** hospedar aplicações web/APIs, servidores de banco de dados, processamento batch, ambientes de dev/staging.

---

## Conceitos Fundamentais

### AMI (Amazon Machine Image)
Template que define o sistema operacional e software pré-instalado de uma instância. Você pode usar AMIs públicas (Amazon Linux, Ubuntu, Windows) ou criar as suas.

### Instance Types
Define CPU, memória e rede disponíveis:

| Família | Uso | Exemplo |
| ------- | --- | ------- |
| `t3`, `t4g` | Propósito geral / burst | `t3.micro`, `t3.medium` |
| `m7i`, `m7g` | Memória/CPU balanceados | `m7i.large` |
| `c7i`, `c7g` | CPU intensivo | `c7i.xlarge` |
| `r7i` | Memória intensiva | `r7i.large` |
| `p3`, `g4` | GPU (ML, renderização) | `g4dn.xlarge` |

> **Free tier:** `t2.micro` ou `t3.micro` por 750 horas/mês no primeiro ano.

### Key Pairs
Par de chaves SSH para acesso à instância. A AWS guarda a pública; você guarda a privada (`.pem`). Necessário para `ssh` na instância Linux.

### Security Groups
Firewall virtual que controla tráfego de entrada (inbound) e saída (outbound) da instância. Funciona como whitelist — tudo bloqueado por padrão.

### Elastic IP
Endereço IP público estático. IPs públicos normais mudam ao reiniciar a instância; Elastic IP permanece fixo.

### User Data
Script executado automaticamente na primeira inicialização da instância. Usado para instalar dependências, clonar repositório, iniciar serviço.

---

## Ciclo de vida de uma instância

```
pending → running → stopping → stopped → terminated
                 ↘ shutting-down → terminated
```

- **Stop/Start:** instância parada não cobra por computação (cobra por EBS e Elastic IP)
- **Terminate:** deleta a instância permanentemente (EBS root também é deletado por padrão)
- **Reboot:** reinicia sem perder o IP

---

## Rodando uma aplicação Node.js no EC2

### 1. Criar a instância (console AWS)

- **AMI:** Amazon Linux 2023 ou Ubuntu 22.04 LTS
- **Instance type:** `t3.micro` (free tier) ou maior conforme necessidade
- **Security Group:** abrir porta 22 (SSH) e porta da aplicação (ex: 3000 ou 80)
- **Key pair:** criar ou selecionar existente

### 2. Conectar via SSH

```bash
chmod 400 minha-chave.pem
ssh -i minha-chave.pem ec2-user@IP_PUBLICO
# Ubuntu: ssh -i minha-chave.pem ubuntu@IP_PUBLICO
```

### 3. Instalar Node.js (via nvm)

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
source ~/.bashrc
nvm install 22
nvm use 22
node -v
```

### 4. Instalar e rodar a aplicação

```bash
# Clonar repositório
git clone https://github.com/seu-usuario/seu-repo.git
cd seu-repo
npm install

# Testar
node index.js
```

### 5. Manter rodando com PM2

PM2 é um process manager para Node.js — reinicia a aplicação em caso de crash e na inicialização do sistema.

```bash
npm install -g pm2
pm2 start index.js --name minha-api
pm2 startup       # gera comando para ativar no boot
pm2 save          # salva lista de processos
pm2 logs          # ver logs em tempo real
pm2 status        # ver status
pm2 restart minha-api
```

### 6. Usar User Data para setup automático

Ao criar a instância, em **Advanced Details → User Data**, cole o script abaixo para automatizar o setup:

```bash
#!/bin/bash
# Amazon Linux 2023
dnf update -y
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
export NVM_DIR="/root/.nvm"
source "$NVM_DIR/nvm.sh"
nvm install 22
npm install -g pm2
cd /home/ec2-user
git clone https://github.com/seu-usuario/seu-repo.git app
cd app
npm install
pm2 start index.js --name api
pm2 startup systemd -u ec2-user --hp /home/ec2-user
pm2 save
```

---

## Usando o SDK v3 para gerenciar EC2 com Node.js

```bash
npm install @aws-sdk/client-ec2
```

### Listar instâncias

```javascript
import { EC2Client, DescribeInstancesCommand } from '@aws-sdk/client-ec2';

const client = new EC2Client({ region: 'sa-east-1' });

const { Reservations } = await client.send(new DescribeInstancesCommand({}));

for (const r of Reservations) {
  for (const i of r.Instances) {
    console.log(i.InstanceId, i.State.Name, i.PublicIpAddress);
  }
}
```

### Iniciar e parar instâncias

```javascript
import { StartInstancesCommand, StopInstancesCommand } from '@aws-sdk/client-ec2';

// Parar
await client.send(new StopInstancesCommand({
  InstanceIds: ['i-0abc123def456789a'],
}));

// Iniciar
await client.send(new StartInstancesCommand({
  InstanceIds: ['i-0abc123def456789a'],
}));
```

### Criar instância por código

```javascript
import { RunInstancesCommand } from '@aws-sdk/client-ec2';

const { Instances } = await client.send(new RunInstancesCommand({
  ImageId: 'ami-0c820c196a818d66a',  // Amazon Linux 2023 em sa-east-1
  InstanceType: 't3.micro',
  MinCount: 1,
  MaxCount: 1,
  KeyName: 'minha-chave',
  SecurityGroupIds: ['sg-0abc123'],
  UserData: Buffer.from('#!/bin/bash\necho "hello" > /tmp/test').toString('base64'),
  TagSpecifications: [{
    ResourceType: 'instance',
    Tags: [{ Key: 'Name', Value: 'minha-instancia' }],
  }],
}));

console.log('Instância criada:', Instances[0].InstanceId);
```

---

## Boas Práticas

1. **Nunca use a conta root** para acesso programático — crie usuários IAM com permissões mínimas
2. **Não abra a porta 22 para 0.0.0.0/0** em produção — restrinja ao seu IP ou use AWS Systems Manager Session Manager
3. **Use IAM Instance Profile** para dar permissões à instância — nunca coloque credenciais AWS no servidor
4. **Prefira Auto Scaling Groups** para produção — garante disponibilidade e escala automaticamente
5. **Snapshots de EBS** como backup — automatize via AWS Backup ou Data Lifecycle Manager
