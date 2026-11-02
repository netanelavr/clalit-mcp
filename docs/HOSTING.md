# Hosting one long-lived copy

Run locally, the session lives only as long as your MCP client keeps the server running. To keep one session alive across days and share it between several clients, run a single copy of the stdio server on an always-on machine at home and put a stdio-to-HTTP MCP proxy in front of it.

Assume none of this is reachable from the internet. Keep it on your home network or a private VPN.

```
MCP clients ──Bearer token──► MCP proxy ──stdio──► clalit-mcp   (one process, started once)
browser ──your own sign-in──► reverse proxy ──► clalit-mcp sign-in page (CLALIT_LOGIN_PORT)
```

## The proxy

Any proxy that starts the stdio server once and shares that one process between clients works, for example [TBXark/mcp-proxy](https://github.com/TBXark/mcp-proxy). Give each client its own bearer token so you can cut one off without touching the others:

```json
{
  "mcpProxy": { "addr": ":9090", "name": "mcp-proxy", "type": "streamable-http" },
  "mcpServers": {
    "clalit": {
      "command": "npx",
      "args": ["tsx", "packages/cli/src/main.ts", "mcp"],
      "env": {
        "CLALIT_CONFIG_DIR": "/data/clalit",
        "CLALIT_LOGIN_HOST": "0.0.0.0",
        "CLALIT_LOGIN_URL": "https://mcp.example.com/clalit/login/"
      },
      "options": { "authTokens": ["<random token for client A>", "<random token for client B>"] }
    }
  }
}
```

Run the proxy from the repository root (or set the working directory), on a residential connection: Clalit turns datacenter IPs away.

## The sign-in page

With `CLALIT_LOGIN_URL` set, the page starts with the server and every "please sign in" answer links to that URL. Route it through a reverse proxy that puts your own sign-in in front (for example forward authentication), either at the root of a host name or under a path. Its links and forms are relative, so under a path, strip the prefix in the reverse proxy and give `CLALIT_LOGIN_URL` with the trailing slash (`https://mcp.example.com/clalit/login/`).

Inside a container, `CLALIT_LOGIN_HOST=0.0.0.0` lets the reverse proxy reach it; don't publish that port anywhere else.

## Clients and accounts

The bearer tokens decide who may call the tools. The Clalit session decides whose records they read. There is no link between the two: every token holder reads the account that last signed in on the page. Removing a token cuts that client off without signing anyone out of Clalit, and no client ever holds Clalit credentials.

For a second person, run a second copy with its own `CLALIT_CONFIG_DIR`, its own tokens and its own sign-in host, limited to them. The stdio server cannot tell which client is calling, so one copy per account is also what keeps one account's records out of another's session.

## Image

This repository publishes no container image. To run the stdio server in a container, build one from a Node 22 image with the packages installed and Playwright's Chromium for the sign-in page (`npx playwright install --with-deps chromium`), run it with `docker run -i`, and set `CLALIT_LOGIN_HOST=0.0.0.0` behind your proxy as above.
