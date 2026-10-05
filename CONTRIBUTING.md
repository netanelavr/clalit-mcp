# Contributing

Never commit HAR files, cookies, session exports, ID numbers, or real lab PDFs. Prefer sanitized HTML fixtures under `packages/core/test/fixtures/`. Do not invent portal endpoints — extend only what [API sources](docs/API-SOURCES.md) documents, with matching fixtures.

```sh
npm install
npm run check
```

Keep the private-core → CLI → MCP layout. Do not document `@clalit/core` as a public SDK.
