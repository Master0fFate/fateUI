# Hooks

Hooks are shell commands that Fate UI runs on the agent tool lifecycle. They are implemented as a Pi SDK inline extension, so they observe the same `tool_call`, `tool_result`, `agent_end`, and `session_start` events the Pi runtime exposes to any extension. Hooks apply to root agent sessions in the project.

Configure hooks in **Settings → Hooks**. The list is stored in `~/.pi/fateGUI/hooks.json` (or `$FATE_GUI_DATA_DIR/hooks.json`). Reopen the project after saving so new sessions load the changed list. Project files cannot add hooks.

## Events

| Event | When | Exit code 2 means |
| :-- | :-- | :-- |
| `PreToolUse` | Before a tool runs. `matcher` is a regular expression tested against the tool name. | Block the call. stderr is returned to the model as the reason. |
| `PostToolUse` | After a tool returns. Same matcher. | Append stderr to the tool result as `[hook name: …]`. |
| `Stop` | When the agent loop ends. | Send stderr back to the agent as a follow-up message so it continues. `stopHookActive` is true on a continuation; at most five continuations run per user turn. |
| `SessionStart` | When a session starts or resumes. | No special meaning. stdout from exit code 0 is delivered as context on the first turn. |

Exit code 0 means continue. Any other exit code, a timeout, or a spawn failure is reported as a warning notice and otherwise ignored.

## Input

Each hook receives one JSON object on stdin:

```json
{
  "event": "PreToolUse",
  "sessionId": "…",
  "projectDir": "C:/work/app",
  "permissionLevel": "edit",
  "toolName": "edit",
  "toolCallId": "…",
  "toolInput": { "path": "src/app.ts", "edits": [] },
  "toolResult": "…",
  "toolIsError": false,
  "lastAssistantMessage": "…",
  "stopHookActive": false
}
```

`toolResult`, `toolIsError`, and `lastAssistantMessage` are present only for the events that have them. The environment also carries `FATE_PROJECT_DIR`, `FATE_HOOK_EVENT`, and `FATE_TOOL_NAME`. Commands run through the system shell in the project directory, with the user's account and no sandbox. stdout and stderr are each bounded to 64 KiB. The default timeout is 60 seconds; the maximum is 600.

## Examples

Format a file after every write or edit:

```
event: PostToolUse   matcher: ^(write|edit)$
command: jq -r .toolInput.path | xargs pnpm exec prettier --write
```

Refuse writes under `.github/`:

```
event: PreToolUse   matcher: ^(write|edit)$
command: jq -e '.toolInput.path | startswith(".github/") | not' >/dev/null || { echo "Workflow files are reviewed by hand." >&2; exit 2; }
```

Require a passing typecheck before the agent stops:

```
event: Stop
command: pnpm typecheck >/dev/null 2>&1 || { echo "pnpm typecheck fails. Fix the errors before finishing." >&2; exit 2; }
```

## Limits

- A hook is not a security boundary. A Full-access agent can run the same command the hook runs.
- Hooks see tool input as the model sent it. A `PreToolUse` block does not undo work another tool already did.
- The Pi SDK runs `tool_call` handlers in extension load order. Fate's hooks run after user-installed global Pi extensions.
