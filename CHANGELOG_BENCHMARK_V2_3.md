# Benchmark 2.3

- Consolidação da versão atual em `~/projects/benchmark`.
- Novo harness `copilot-sdk`, separado de OpenCode e Codex.
- Modelos Copilot ativos: GPT-5.6 Luna, GPT-5.4 mini, Kimi K2.7 Code, MAI-Code-1.1-Flash e Claude Haiku 4.5.
- Uso estruturado por sessão via `session.rpc.usage.getMetrics()`, preservando tokens, AI credits e custo de premium requests.
- Os dados de modelo observados vêm apenas de `modelMetrics`; revisão e fingerprint continuam `null` quando o provider não os expõe.
- `rounds` permanece em `2`, conforme a configuração atual de smoke/campanha do projeto.
- Nenhum modelo é executado durante validação, typecheck, testes ou dry-run.
- SDK atualizado para `@github/copilot-sdk` `1.0.9`, com tipos oficiais do pacote; o mock local de tipos foi removido.
- O runtime registra versões do SDK e do Copilot CLI no metadata da execução e no ambiente da campanha.
- Falha de `getMetrics()` não invalida uma execução funcional; a telemetria fica como indisponível.
