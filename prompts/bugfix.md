Você está em um projeto TypeScript existente.

Corrija o projeto sem reescrever tudo do zero.

## Objetivo

Faça os comandos abaixo passarem:

```bash
npm install
npm run typecheck
npm test
npm run build
npm run lint
```

## Regras

1. Não remova nem modifique os testes existentes para fazer passar; trate `tests/` como parte imutável do benchmark.
2. Não ignore erros com `any`, `ts-ignore` ou `eslint-disable`, exceto se houver justificativa muito forte.
3. Não substitua a implementação real por mocks.
4. Mantenha a arquitetura atual sempre que possível.
5. Corrija a causa raiz dos problemas.
6. Não altere os scripts `typecheck`, `test`, `build` e `lint` do `package.json` para contornar validações.
7. Atualize o README se necessário.

## Entrega esperada

Implemente as correções diretamente nos arquivos do projeto.
