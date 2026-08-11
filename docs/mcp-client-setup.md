# MCP Client Setup

Use this page when your client supports MCP but is not listed in [AI Client Setup](./ai-client-setup.md).

## What the Client Must Run

Build first:

```bash
npm run setup:local
```

Then configure your client to run:

```bash
node /absolute/path/to/easyeda_mcp/dist/index.js
```

The path must point to the compiled `dist/index.js` file.

## Generic JSON Shape

Many MCP clients use a config similar to this:

```json
{
  "mcpServers": {
    "easyeda-pro": {
      "command": "node",
      "args": ["/absolute/path/to/easyeda_mcp/dist/index.js"]
    }
  }
}
```

On Windows, use an absolute path such as:

```json
{
  "mcpServers": {
    "easyeda-pro": {
      "command": "node",
      "args": ["C:\\Users\\you\\Documents\\easyeda_mcp\\dist\\index.js"]
    }
  }
}
```

## Startup Order

Use this order to avoid connection confusion:

1. start the MCP client
2. let it launch the MCP server
3. open EasyEDA Pro
4. open your schematic or PCB
5. load or reconnect the extension
6. run `easyeda_doctor`

Only one local MCP server can own the default EasyEDA bridge port at a time. If
another client already owns `127.0.0.1:8765`, the server remains initialized and
retries until the port is released. This keeps the MCP tool catalog available
and lets a waiting client recover without restarting it.

## What Happens at Runtime

The MCP client talks to the server over `stdio`.

The server opens a local WebSocket bridge for the EasyEDA Pro extension:

```text
ws://127.0.0.1:8765
```

The extension connects to that bridge and calls EasyEDA Pro APIs on behalf of MCP tools.

## Optional Bridge Endpoint

Defaults:

- host: `127.0.0.1`
- port: `8765`

Optional environment variables:

- `EASYEDA_MCP_WS_HOST`
- `EASYEDA_MCP_WS_PORT`
- `EASYEDA_MCP_WS_RETRY_MS` (defaults to `1000`)

Only host and port changes require updating the extension bridge target.

## Verify

Ask your MCP client:

```text
Run easyeda_live_status.
```

Then:

```text
Run easyeda_doctor.
```

If the client can see the tools but the extension is disconnected, go to [Troubleshooting](./troubleshooting.md#extension-is-not-connected).

## After Tool Changes

If you add or rename MCP tools:

1. rebuild with `npm run setup:local`
2. restart the MCP client session
3. reconnect the EasyEDA Pro extension

Most MCP clients cache tool catalogs for the life of a session.
