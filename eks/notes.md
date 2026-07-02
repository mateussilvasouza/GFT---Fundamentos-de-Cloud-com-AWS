# Amazon EKS — Elastic Kubernetes Service

## O que é

EKS é o serviço de **Kubernetes gerenciado da AWS**. O Kubernetes (K8s) é um orquestrador de containers — ele decide onde cada container roda, garante que o número certo de réplicas está ativo e gerencia atualização e escala automática.

"Gerenciado" significa que a AWS controla o **control plane** (API server, etcd, scheduler) — você só gerencia os **worker nodes** onde seus containers rodam.

**Casos de uso:** aplicações em containers que precisam de alta disponibilidade, escala automática, rolling deploys sem downtime, múltiplos microsserviços.

---

## Arquitetura EKS

```
┌─────────────────────────────────────────────┐
│              AWS EKS Control Plane           │
│  (API Server, etcd, Scheduler — gerenciado) │
└─────────────┬───────────────────────────────┘
              │ kubectl / SDK
┌─────────────▼───────────────────────────────┐
│              Worker Nodes                    │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  │
│  │ Node (EC2│  │ Node (EC2│  │ Fargate  │  │
│  │ ou EKS   │  │ ou EKS   │  │ (serverl.)│  │
│  │ Managed) │  │ Managed) │  │          │  │
│  │ [Pod][Pod│  │ [Pod][Pod│  │  [Pod]   │  │
│  └──────────┘  └──────────┘  └──────────┘  │
└─────────────────────────────────────────────┘
```

### Opções de nodes

| Tipo | Descrição | Quando usar |
| ---- | --------- | ----------- |
| **Managed Node Groups** | EC2 gerenciados pela AWS (updates automáticos) | Casos gerais |
| **Self-managed Nodes** | EC2 que você configura manualmente | Controle total |
| **Fargate** | Serverless — sem gerenciar servers | Workloads isolados, batch |

---

## Conceitos Kubernetes

### Pod
Menor unidade deployável. Contém um ou mais containers que compartilham rede e storage.

### Deployment
Define quantas réplicas de um Pod devem rodar. Gerencia rolling updates e rollbacks.

### Service
Expõe um conjunto de Pods com um IP/DNS estável. Tipos: `ClusterIP` (interno), `NodePort`, `LoadBalancer` (cria um ELB na AWS).

### Ingress
Roteamento HTTP/HTTPS para múltiplos Services por path ou hostname. Requer um Ingress Controller (AWS Load Balancer Controller).

### Namespace
Isolamento lógico dentro do cluster. Usado para separar ambientes (dev, staging, prod) ou times.

### ConfigMap / Secret
ConfigMap guarda configuração não sensível. Secret guarda dados sensíveis (base64 encoded, idealmente integrado com KMS).

---

## Configuração do ambiente

### Pré-requisitos

```bash
# AWS CLI configurada
aws configure

# kubectl
curl -LO "https://dl.k8s.io/release/$(curl -sL https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"
chmod +x kubectl && sudo mv kubectl /usr/local/bin/

# eksctl (ferramenta oficial para criar clusters EKS)
curl --silent --location "https://github.com/eksctl-io/eksctl/releases/latest/download/eksctl_Linux_amd64.tar.gz" | tar xz -C /tmp
sudo mv /tmp/eksctl /usr/local/bin/
```

### Criar cluster com eksctl

```bash
eksctl create cluster \
  --name meu-cluster \
  --region sa-east-1 \
  --nodegroup-name workers \
  --node-type t3.medium \
  --nodes 2 \
  --nodes-min 1 \
  --nodes-max 4 \
  --managed

# Aguarda ~15-20 minutos
# Configura o kubeconfig automaticamente
kubectl get nodes
```

### Configurar kubeconfig manualmente

```bash
aws eks update-kubeconfig \
  --region sa-east-1 \
  --name meu-cluster

kubectl cluster-info
kubectl get nodes
```

---

## Deployando uma aplicação Node.js no EKS

### 1. Criar imagem Docker

```dockerfile
# Dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
EXPOSE 3000
CMD ["node", "index.js"]
```

```bash
docker build -t minha-api:latest .
```

### 2. Publicar no Amazon ECR

```bash
# Criar repositório
aws ecr create-repository --repository-name minha-api --region sa-east-1

# Login no ECR
aws ecr get-login-password --region sa-east-1 | \
  docker login --username AWS --password-stdin 123456789012.dkr.ecr.sa-east-1.amazonaws.com

# Tag e push
docker tag minha-api:latest 123456789012.dkr.ecr.sa-east-1.amazonaws.com/minha-api:latest
docker push 123456789012.dkr.ecr.sa-east-1.amazonaws.com/minha-api:latest
```

### 3. Criar manifesto Kubernetes

```yaml
# k8s/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: minha-api
  namespace: default
spec:
  replicas: 2
  selector:
    matchLabels:
      app: minha-api
  template:
    metadata:
      labels:
        app: minha-api
    spec:
      containers:
        - name: minha-api
          image: 123456789012.dkr.ecr.sa-east-1.amazonaws.com/minha-api:latest
          ports:
            - containerPort: 3000
          env:
            - name: NODE_ENV
              value: production
            - name: PORT
              value: "3000"
          resources:
            requests:
              cpu: "100m"
              memory: "128Mi"
            limits:
              cpu: "500m"
              memory: "512Mi"
          readinessProbe:
            httpGet:
              path: /health
              port: 3000
            initialDelaySeconds: 5
            periodSeconds: 10
---
apiVersion: v1
kind: Service
metadata:
  name: minha-api-service
spec:
  selector:
    app: minha-api
  ports:
    - port: 80
      targetPort: 3000
  type: LoadBalancer  # Cria um ELB automaticamente na AWS
```

### 4. Aplicar e verificar

```bash
kubectl apply -f k8s/deployment.yaml

# Verificar status
kubectl get pods
kubectl get deployments
kubectl get services          # aguarda EXTERNAL-IP aparecer
kubectl logs -l app=minha-api -f  # logs de todos os pods
kubectl describe pod NOME-DO-POD  # debug de um pod específico
```

### 5. Atualizar a imagem (rolling update)

```bash
kubectl set image deployment/minha-api \
  minha-api=123456789012.dkr.ecr.sa-east-1.amazonaws.com/minha-api:v2

kubectl rollout status deployment/minha-api  # aguarda update
kubectl rollout undo deployment/minha-api    # rollback se necessário
```

---

## Usando o SDK v3 para interagir com EKS

```bash
npm install @aws-sdk/client-eks
```

```javascript
import { EKSClient, DescribeClusterCommand, ListClustersCommand } from '@aws-sdk/client-eks';

const client = new EKSClient({ region: 'sa-east-1' });

// Listar clusters
const { clusters } = await client.send(new ListClustersCommand({}));
console.log(clusters); // ['meu-cluster']

// Detalhes de um cluster
const { cluster } = await client.send(new DescribeClusterCommand({
  name: 'meu-cluster',
}));
console.log(cluster.status);    // ACTIVE
console.log(cluster.endpoint);  // URL do API server
console.log(cluster.version);   // Versão do K8s
```

Para interagir com a API do Kubernetes (criar pods, deployments, etc.) a partir de Node.js, use o cliente oficial:

```bash
npm install @kubernetes/client-node
```

```javascript
import * as k8s from '@kubernetes/client-node';

const kc = new k8s.KubeConfig();
kc.loadFromDefault(); // usa ~/.kube/config

const appsV1 = kc.makeApiClient(k8s.AppsV1Api);
const coreV1 = kc.makeApiClient(k8s.CoreV1Api);

// Listar pods no namespace default
const { body } = await coreV1.listNamespacedPod('default');
for (const pod of body.items) {
  console.log(pod.metadata.name, pod.status.phase);
}

// Escalar um deployment
await appsV1.patchNamespacedDeployment(
  'minha-api',
  'default',
  [{ op: 'replace', path: '/spec/replicas', value: 5 }],
  undefined, undefined, undefined, undefined,
  { headers: { 'Content-Type': 'application/json-patch+json' } }
);
```

---

## Boas Práticas

1. **Sempre defina `resources.requests` e `resources.limits`** — sem limites, um pod pode consumir todo o node
2. **`readinessProbe`** — o Service só manda tráfego para pods prontos; evita erros durante deploy
3. **Prefira ECR** para imagens privadas — integração nativa com IAM, sem credenciais extras no cluster
4. **Namespaces por ambiente** — `kubectl create namespace staging` — isolamento sem precisar de múltiplos clusters
5. **Use HorizontalPodAutoscaler** para escala automática baseada em CPU/memória
6. **Nunca use `latest` em produção** — sempre versione as imagens (`v1.2.3` ou SHA do commit)
