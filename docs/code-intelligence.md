# Code Intelligence

Code Intelligence connects the agent to Language Server Protocol servers. It adds four read-only tools to every root session and appends fresh diagnostics to each `write`/`edit` result of the root agent.

| Tool | Input | Result |
| :-- | :-- | :-- |
| `lsp_diagnostics` | `path` | Errors, warnings, and hints for one file, sorted by severity then line. |
| `lsp_definition` | `path`, `line`, `character` (1-based) | Definition locations as `file:line:col`. |
| `lsp_references` | `path`, `line`, `character`, `includeDeclaration?` | Up to 100 reference locations. |
| `lsp_symbols` | `path` or `query` | Document outline, or workspace symbol search across enabled servers. |

All paths must resolve inside the active project. Files are read from disk and synced to the server before each request, so the agent must write first, then inspect.

## Servers

Configure servers in **Settings → Code Intelligence**. The list is stored in `~/.pi/fateGUI/lsp-servers.json` (or `$FATE_GUI_DATA_DIR/lsp-servers.json`). Each entry maps file extensions to a command and arguments. The defaults cover TypeScript and JavaScript (`typescript-language-server --stdio`), Python (`pyright-langserver --stdio`), Rust (`rust-analyzer`), Go (`gopls`), and C/C++ (`clangd`).

Fate UI does not install servers. A command is resolved from the project's `node_modules/.bin` first, then PATH. A missing server is reported to the agent as unavailable, and the lookup is not retried for five minutes.

For a TypeScript project the usual setup is:

```bash
pnpm add -D typescript-language-server typescript
```

## Lifecycle and limits

- A server starts on first use per project and exits after ten minutes idle, when the project runtime closes, or when the saved server list changes.
- Up to 64 documents stay open per project; the oldest is closed first. Files above 8 MiB are refused.
- Diagnostics wait up to four seconds for the server to publish (three seconds after an edit). A slow server such as rust-analyzer on a cold cache may report "no diagnostics received yet"; call `lsp_diagnostics` again.
- Edit feedback shows errors and warnings only, at most 20 lines. Hints and information never interrupt the agent.
- Servers run with the user's account and read the project directory directly. Fate's project file gate applies to the tool inputs, not to what the server itself reads.
