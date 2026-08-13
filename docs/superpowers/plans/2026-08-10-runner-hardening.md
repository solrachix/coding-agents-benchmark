# Benchmark Runner Hardening Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tornar o runner confiável para comparar OpenCode e Codex com o mesmo benchmark, preservando uma extensão futura para outros executores.

**Architecture:** Manter os adapters atuais de OpenCode e Codex, mas compartilhar tipos e metadados de execução. O validador passa a obedecer à configuração e medir instalação separadamente. O relatório passa a funcionar também antes da primeira execução.

**Tech Stack:** TypeScript, Node.js, tsx, npm, node:test.

---

### Task 1: Testar utilitários e validação de caminhos

**Files:**
- Create: `scripts/utils.test.ts`
- Modify: `scripts/utils.ts`

- [x] Escrever testes para aceitar o root e subdiretórios, mas rejeitar caminhos com prefixo textual fora do root.
- [x] Executar os testes e confirmar a falha do comportamento de prefixo.
- [x] Corrigir a validação usando separador de caminho.
- [x] Executar novamente e confirmar aprovação.

### Task 2: Tornar validações configuráveis e medir instalação

**Files:**
- Modify: `scripts/validate-project.ts`
- Modify: `scripts/run-opencode.ts`
- Modify: `scripts/run-codex.ts`

- [x] Adicionar teste cobrindo que validações desabilitadas não são executadas.
- [x] Implementar a configuração de validações e duração real de instalação.
- [x] Propagar a duração medida para `meta.json`.
- [x] Rodar typecheck e testes do runner.

### Task 3: Fortalecer relatório e configuração de engines

**Files:**
- Modify: `scripts/generate-report.ts`
- Modify: `config/models.json`
- Modify: `README.md`

- [x] Garantir que o relatório crie `results/` quando ainda não houver execuções.
- [x] Documentar a comparação do mesmo modelo em harnesses diferentes.
- [x] Documentar Orca como camada de orquestração até existir um executor compatível.
- [x] Rodar dry-run, typecheck e geração de relatório.

### Task 4: Verificação final

- [x] Confirmar que apenas arquivos do runner foram alterados.
- [x] Executar `npm run typecheck`, testes, dry-run e `npm run report`.
- [x] Reportar limitações de execução real sem consumir créditos.
