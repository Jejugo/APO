# ADR 0004 — Embeddings locais com transformers.js

**Status:** aceito em 2026-10-11 (início do M5, entrega M5.7).

## Contexto

A memória do Project (seção 22 do PLAN.md) guarda trechos da documentação e memórias destiladas das Features em `memories` (pgvector) e busca por similaridade antes do planner e de cada Task. É preciso gerar embeddings, e o TECHNICAL_PLAN pedia a decisão no início do M5 entre duas opções locais:

- **Ollama:** serviço separado (HTTP), reaproveitável na VM do homelab (M6). Não estava instalado no Mac de desenvolvimento.
- **transformers.js:** roda no próprio processo do daemon (ONNX via `onnxruntime-node`), sem serviço extra.

Embedding por API remota foi descartado: o conteúdo é o código e a documentação do usuário, e a regra do projeto é não depender de um serviço externo para funcionar (o Jev já é a única dependência remota opcional).

## Decisão

**transformers.js** (`@huggingface/transformers` 3.x) com o modelo **`Xenova/multilingual-e5-small`**, quantizado (`q8`), 384 dimensões.

- Multilíngue porque objetivos, documentação e convenções do usuário são em português.
- Prefixos `query:` / `passage:` do e5 aplicados pelo `TransformersEmbeddingProvider`.
- Modelo baixado uma vez para `~/.apo/models` (129 MB); o daemon pré-carrega no boot.
- Medido no Mac: ~7 s para baixar e carregar na primeira vez, **~18 ms** por lote pequeno depois.
- `sharp` (dependência opcional de imagem) fica com build bloqueado no `pnpm-workspace.yaml`; só `onnxruntime-node` e `protobufjs` rodam scripts de instalação.

## Consequências

- Nenhum serviço novo para instalar ou manter; a memória funciona no `pnpm install`.
- O daemon fica ~130 MB maior em memória com o modelo carregado.
- A dimensão (384) está fixa na coluna `memories.embedding vector(384)`. Trocar de modelo exige migration e reindexação (a coluna `embedding_model` registra qual modelo gerou cada vetor).
- `EmbeddingProvider` é uma interface: Ollama continua possível no M6 se a VM já tiver um, sem mexer em ingestão nem retrieval.
- Testes usam o `HashingEmbeddingProvider` (determinístico, sem modelo).
