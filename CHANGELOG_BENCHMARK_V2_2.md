# Benchmark 2.2

Esta versão corrige problemas observados na campanha parcial anterior:

- o hidden evaluator usa um caminho absoluto para o SQLite temporário, evitando que `file:./...` seja resolvido em relação ao diretório errado;
- a readiness visual testa primeiro a porta TCP local e só depois abre o navegador;
- falha de harness/timeout não apaga o `artifactScore`: o report mostra score oficial como `-`, score de artefato separado e status da execução;
- hashes ambíguos, como o Git empty-tree hash, não são registrados como revisão do modelo;
- o report mostra tokens totais, input, output, reasoning, cache read, cache write e custo;
- falhas visuais preservam diagnóstico do servidor/browser no `visual.json` e no `report.md`.
- `Ctrl+C`/`SIGTERM` agora encerra os grupos de processos do harness, servidores E2E e smoke visual, evitando OpenCode/Chrome/Next órfãos.
- a versão da rubrica, configuração e metadata é `2.2`;
- erros internos do hidden evaluator são `evaluator_error`, separados de falhas funcionais do agente;
- o report conta erros do evaluator em coluna própria e não os soma como falhas funcionais.

Scores oficiais de execuções com timeout, erro de provider/harness ou UI não verificável continuam fora das estatísticas comparáveis. O score de artefato serve para auditoria do que foi produzido antes da falha.
