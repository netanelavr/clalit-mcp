# Contributing

## Hygiene

- Never commit HAR files, cookies, session exports, ID numbers, or real lab PDFs.
- Prefer sanitized HTML fixtures under `packages/core/test/fixtures/`.
- Do not add prescription/referral fetchers without a redacted HAR map entry and fixtures.

## Dev

```sh
npm install
npm test
npm run typecheck
```

## Scope

v1 focus is labs. Match the existing core → CLI → MCP layout. Keep errors free of upstream URLs and response bodies.
