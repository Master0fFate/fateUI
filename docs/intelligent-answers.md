# Intelligent answers

Fate renders fenced `openui` programs as local, interactive answer blocks, alongside ordinary Markdown. It uses the real OpenUI Lang 1.0 parser and React runtime (`@openuidev/lang-core` and `@openuidev/react-lang` 1.1.1) with a Fate component library, not a new model provider or a hosted Thesys API. React stays at 18.3.1. Zod is pinned to the compatible 3.25.76 release.

## Authoring

The complete supported positional component and function schemas, safety rules, and two working examples are in `src/shared/intelligentUiPrompt.ts`. Keep that prompt synchronized with `src/renderer/features/chat/intelligent-ui/library.tsx` and `functions.ts` whenever the library changes.

Start with `root = Col([...])`. Literal `$variable` declarations hold input values and selections. Derived expressions and `@functions` calculate the answer. Bound inputs, selects, sliders, checkboxes, dates, tabs and disclosure panels update locally. Buttons need an explicit action. `@Set` changes state, `@Reset` restores defaults, and `Action([...])` sequences local steps. `@ToAssistant` prepares an ordinary follow-up draft for the user to review and send; it does not run a command or bypass chat submission.

Use UI only when interaction helps. Coding answers, prose and normal code fences remain Markdown. Charts and tables should contain actual available facts or clearly identified illustrative data. The library has no tool provider and does not pretend a local mock dashboard is live data.

```openui
root = Col([Title("Review estimate", "lg"), controls, result, reset])
$checks = 6
$reviewers = 2
controls = Row([Input($checks, "Checks", "number"), Slider($reviewers, 1, 8, 1, "Reviewers")])
result = Metric("Hours per reviewer", @Round(@Clamp(@Default($checks, 1), 1, 100) * 2 / $reviewers, 1))
reset = Button("Reset", Action([@Reset($checks), @Reset($reviewers)]), "outline")
```

## Renderer contract

Lazy-load `src/renderer/features/chat/intelligent-ui/IntelligentAnswer.tsx` only for an `openui` fence. Its named export accepts `{ source, isStreaming?, stateKey?, onFollowUp? }`. Supply the raw fenced program, without backticks. Use a stable `stateKey` containing connection/project identity, session identity, message identity and fence index; do not derive it from the changing streamed text. Distinct conversations and fences must never share keys.

`onFollowUp(text)` receives the short request plus bounded context and field values. Omitting it disables follow-up actions while preserving local interaction. Desktop chat submits an append-only composer request scoped to its connection generation, project and session. The composer rechecks that identity before applying it, preserves all existing text and attachments, clears any child-agent delivery target, and shows a review notice without sending. Session changes and busy composer operations reject the request without changing the draft. Other composer insertion/replacement APIs keep their existing behavior. The renderer never receives a main-process tool executor.

Non-clipped assistant messages in network snapshots also render OpenUI with stable connection/server, workspace generation, session and message keys. They support local interaction only: follow-up callbacks are omitted. Snapshot revision is not part of the state key. Clipped messages stay plain text; omission labels remain visible. Network Markdown disables image loading, local image reads and Mermaid rendering through `allowMedia={false}`; image alt text and diagram source remain readable.

The root CSS class is `.intelligent-answer`. Styling uses Fate theme and font tokens, supports light/dark palettes, respects compact mode, and adapts corners to skins. Charts use internal numeric geometry only. The model cannot supply SVG markup or style attributes.

## State and recovery

State is retained through navigation/remounts and reloads by `stateKey`. One localStorage envelope, `fate:intelligent-ui:state:v1`, holds an LRU cache of at most 64 blocks, 512,000 serialized state characters in total and 32,000 per block. Values are JSON-normalized, validated and isolated by their supplied keys. Writes happen after user state changes, debounced for 180 ms; page hide flushes pending changes. Storage failures fall back to in-memory state. The cache is not encrypted and should not be used to collect credentials or secrets. Very old blocks can be evicted. Anonymous blocks without a key do not persist.

Streaming programs show their resolved UI with an updating state, or `Building answer…`. They never expose raw Lang as a loading fallback. Incomplete or invalid final programs show `Interactive answer unavailable`, a short reason and recoverable `View source` details. Runtime rendering is isolated by an error boundary. Valid blocks also retain source access. Missing follow-up capabilities, streaming, and unsupported actions produce disabled buttons rather than fake actions.

## Safety limits

Programs are untrusted data. Before OpenUI rendering, Fate validates the source and parsed expression graph against the component/function/action allowlist. Bounds include 48,000 source characters, 512 lines, 256 statements, 28 source delimiter levels, bounded expression-graph traversal, 512 list items, 12,000 estimated work per expression and 24,000 across a program. Nested repeated work and circular references are rejected. Range generation, custom-function inputs/outputs, text, list and state nesting are bounded. Replacement and joining preflight their result length before allocation. Addition is normalized to a bounded operation, and state assignments validate live values before the runtime writes them, not just when persisting. Identifiers use Lang's ASCII identifier grammar and are limited to 128 characters. Quoted member names remain quoted through normalization, including vectorized array plucking.

Only genuine normalized `@Set`, `@Reset` and `@ToAssistant` steps can execute. A normalization-only private function marks immutable steps; incoming source cannot call it. `Action([...])` preserves those step identities and permits at most 16 steps; reset steps permit at most 16 state targets. Raw action-plan objects are not executable. Actual assignment ASTs are also rechecked for bounded work, pure allowed functions, scoped loop references and the absence of unnormalized addition or executable actions. SDK runtime AST, reactive-assignment and element discriminants are reserved rather than ordinary data: source objects, custom-function values and restored state cannot impersonate them. State is bounded before serialization as well as before persistence.

There are no raw HTML, iframe, script, user-supplied SVG, arbitrary CSS, remote media, map or image-search components. `Query`, `Mutation`, `@Run`, `@OpenUrl` and custom action execution are not admitted. No network request or tool action is available to a generated program. Links allow only credential-free HTTP(S) URLs and open solely after an explicit click through the existing Fate browser link flow. Markdown has no raw HTML or images. This does not change project trust or the main/renderer boundary.

OpenUI renderer observability publication is explicitly disabled. Lang Core's installation telemetry script is denied in `pnpm-workspace.yaml`. Upstream's React package may auto-mount its inspector in development builds; production eliminates that development-only import. Server-side runtime telemetry is opt-in upstream, and browser parser runtimes do not send it.

Upstream attribution and MIT terms are recorded in `THIRD_PARTY_NOTICES.md`. Fate adapts composable local interaction patterns from `thesysdev/open-intelligent-ui` commit `8ecdd17297d1f15cecfbc8750817dda5a576c401`, without its remote services or executable HTML examples.
