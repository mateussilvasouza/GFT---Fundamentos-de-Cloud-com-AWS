# AWS KMS — Key Management Service

## O que é

KMS é o serviço da AWS para **criar, gerenciar e usar chaves de criptografia**. Em vez de gerar e guardar chaves manualmente (o que é arriscado), o KMS faz isso de forma segura — as chaves nunca saem da infraestrutura gerenciada da AWS em texto claro.

**Casos de uso:** criptografar dados sensíveis em S3, RDS, DynamoDB e EBS; assinar tokens JWT; proteger secrets; atender requisitos de compliance (LGPD, PCI-DSS, HIPAA).

---

## Conceitos Fundamentais

### KMS Key (antes chamada de CMK — Customer Master Key)
Chave gerenciada pelo KMS. Pode ser:

| Tipo | Gerenciada por | Custo | Quando usar |
| ---- | -------------- | ----- | ----------- |
| **AWS Managed** | AWS (automático) | Grátis | Criptografia básica de serviços AWS |
| **Customer Managed** | Você (via console/SDK) | $1/mês + uso | Controle de rotação, policies e auditoria |
| **Custom Key Store** | Você (em HSM dedicado) | Alto | Requisitos de compliance extremos |

### Envelope Encryption
KMS não criptografa dados grandes diretamente. O padrão é:

```
1. KMS gera uma Data Key (chave de dados)
2. Você usa a Data Key para criptografar seus dados localmente (mais rápido)
3. KMS criptografa a própria Data Key com a KMS Key
4. Você armazena: dados criptografados + Data Key criptografada (safe to store together)

Para descriptografar:
1. KMS descriptografa a Data Key
2. Você usa a Data Key descriptografada para descriptografar os dados
3. A Data Key descriptografada é descartada da memória
```

### Key Policy
Política JSON que define quem pode usar e gerenciar a chave. Diferente de IAM policies — a Key Policy é obrigatória e tem precedência.

### Grants
Permissão temporária e programática para usar uma chave. Útil para delegar acesso sem alterar policies.

### Aliases
Nome legível para a chave. Ex: `alias/minha-chave-producao` em vez do UUID da key.

---

## Criando uma chave (console AWS)

1. **KMS** → **Customer managed keys** → **Create key**
2. **Key type:** Symmetric (AES-256-GCM) para a maioria dos casos
3. **Key usage:** Encrypt and decrypt
4. **Alias:** `minha-chave-app`
5. **Key administrators:** usuários/roles que podem gerenciar (não necessariamente usar) a chave
6. **Key users:** usuários/roles que podem usar a chave para criptografar/descriptografar

---

## Operações Fundamentais com Node.js

```bash
npm install @aws-sdk/client-kms
```

### Criptografar dados

```javascript
import { KMSClient, EncryptCommand } from '@aws-sdk/client-kms';

const client = new KMSClient({ region: 'sa-east-1' });

const plaintext = 'dados-sensiveis-aqui';

const { CiphertextBlob } = await client.send(new EncryptCommand({
  KeyId: 'alias/minha-chave-app',          // alias ou ARN da key
  Plaintext: Buffer.from(plaintext, 'utf-8'),
}));

// CiphertextBlob é um Uint8Array — serializar para armazenar
const encrypted = Buffer.from(CiphertextBlob).toString('base64');
console.log('Criptografado:', encrypted);
```

### Descriptografar dados

```javascript
import { DecryptCommand } from '@aws-sdk/client-kms';

const encrypted = 'BASE64_DO_CIPHERTEXT_BLOB';

const { Plaintext } = await client.send(new DecryptCommand({
  CiphertextBlob: Buffer.from(encrypted, 'base64'),
  // KeyId não é necessário — o KMS identifica qual key foi usada pelo ciphertext
}));

const decrypted = Buffer.from(Plaintext).toString('utf-8');
console.log('Descriptografado:', decrypted);
```

### Gerar Data Key (envelope encryption)

```javascript
import { GenerateDataKeyCommand } from '@aws-sdk/client-kms';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const client = new KMSClient({ region: 'sa-east-1' });

// 1. Gerar Data Key via KMS
const { Plaintext: dataKeyPlaintext, CiphertextBlob: dataKeyCiphertext } =
  await client.send(new GenerateDataKeyCommand({
    KeyId: 'alias/minha-chave-app',
    KeySpec: 'AES_256',
  }));

// 2. Criptografar dados localmente com a Data Key
const iv = randomBytes(16);
const cipher = createCipheriv('aes-256-cbc', Buffer.from(dataKeyPlaintext), iv);

let encryptedData = cipher.update('dados muito grandes...', 'utf-8', 'base64');
encryptedData += cipher.final('base64');

// 3. Armazenar: dados criptografados + Data Key criptografada + IV
// dataKeyPlaintext deve ser descartado da memória após o uso
const bundle = {
  encryptedData,
  encryptedDataKey: Buffer.from(dataKeyCiphertext).toString('base64'),
  iv: iv.toString('base64'),
};

// Para descriptografar depois:
// 1. KMS.decrypt(encryptedDataKey) → dataKey
// 2. aes-256-cbc.decrypt(encryptedData, dataKey, iv) → plaintext
```

### Gerar Data Key sem Plaintext (proteção extra)

Se você não precisa usar a chave agora (ex: vai armazenar para uso futuro), use `GenerateDataKeyWithoutPlaintext` — assim a chave em texto claro nunca fica na memória do processo.

```javascript
import { GenerateDataKeyWithoutPlaintextCommand } from '@aws-sdk/client-kms';

const { CiphertextBlob } = await client.send(
  new GenerateDataKeyWithoutPlaintextCommand({
    KeyId: 'alias/minha-chave-app',
    KeySpec: 'AES_256',
  })
);
// Armazene CiphertextBlob — descriptografe via KMS quando for usar
```

---

## Integração com outros serviços AWS

O KMS se integra nativamente — você especifica a chave e o serviço faz tudo:

### S3

```javascript
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

await new S3Client({ region: 'sa-east-1' }).send(new PutObjectCommand({
  Bucket: 'meu-bucket',
  Key: 'arquivo-sensivel.txt',
  Body: 'conteúdo',
  ServerSideEncryption: 'aws:kms',
  SSEKMSKeyId: 'alias/minha-chave-app',  // omitir para usar a chave padrão S3
}));
```

### Secrets Manager (armazenar secrets criptografados com KMS)

```javascript
import { SecretsManagerClient, CreateSecretCommand, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const sm = new SecretsManagerClient({ region: 'sa-east-1' });

// Criar secret criptografado com KMS
await sm.send(new CreateSecretCommand({
  Name: 'meu-app/db-password',
  SecretString: JSON.stringify({ password: 'senha-secreta' }),
  KmsKeyId: 'alias/minha-chave-app',
}));

// Ler secret
const { SecretString } = await sm.send(new GetSecretValueCommand({
  SecretId: 'meu-app/db-password',
}));
const { password } = JSON.parse(SecretString);
```

---

## Rotação Automática de Chaves

Para Customer Managed Keys simétricas, o KMS pode rotar automaticamente a chave a cada ano — sem invalidar dados já criptografados (o KMS mantém versões antigas internamente).

```bash
# Ativar rotação via CLI
aws kms enable-key-rotation --key-id alias/minha-chave-app

# Verificar
aws kms get-key-rotation-status --key-id alias/minha-chave-app
```

---

## Monitoramento e Auditoria

Todo uso de chave KMS é registrado automaticamente no **AWS CloudTrail**:

```bash
# Ver eventos de uso de uma chave específica
aws cloudtrail lookup-events \
  --lookup-attributes AttributeKey=ResourceName,AttributeValue=alias/minha-chave-app \
  --query 'Events[*].[EventTime,EventName,Username]' \
  --output table
```

---

## Boas Práticas

1. **Nunca armazene chaves KMS em variáveis de ambiente** — a chave fica no KMS; use o Key ID/alias
2. **Use aliases** (`alias/nome`) em vez de ARNs no código — facilita rotação e mudança de chave
3. **Descarte dataKeyPlaintext da memória** imediatamente após uso em envelope encryption
4. **Key Policy minimalista** — dê acesso `kms:Decrypt` apenas às roles que realmente precisam
5. **CloudTrail ativo** — auditoria de uso de chaves é requisito de compliance
6. **Contexto de criptografia (EncryptionContext)** — par chave/valor adicionado à operação; obrigatório fornecer na descriptografia, protege contra uso indevido do ciphertext
