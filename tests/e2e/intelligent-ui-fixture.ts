import { INTELLIGENT_UI_RELEASE_EXAMPLE } from '../../src/shared/intelligentUiPrompt';

const formExample = `root = Col([Title("Review details", "md"), form, result, Button("Grow", @Set($word, $word + $word), "outline"), Text($word)])
$name = ""
$team = ""
$word = "x"
form = Form([Input($name, "Reviewer"), Input($team, "Team"), Input("initial", "Reference")], @ToAssistant("Review these details", {reviewer: $name, team: $team}))
result = Text($name + " / " + $team)`;

const budgetExample = `root = Col([Title("Review budget", "lg"), inputs, estimate, checklist, actions])
$hours = 6
$rate = 90
$done = []
inputs = Row([Input($hours, "Hours", "number"), Input($rate, "Hourly rate", "number")])
hours = @Clamp(@Default($hours, 1), 1, 100)
rate = @Clamp(@Default($rate, 0), 0, 10000)
estimate = Metric("Estimated cost", @Format(hours * rate, "currency"))
checklist = Col(@Each(["Scope", "Risks", "Rollback"], "item", Row([Text(item), Button(@Includes($done, item) ? "Undo" : "Done", @Set($done, @Toggle($done, item)), "outline")])), 2)
actions = Row([Text(@Count($done) + " of 3 reviewed", "sm", "muted"), Button("Reset", @Reset($done), "outline")])`;

export const intelligentAnswer = `Mock data for an illustrative release, not a live assessment.

\`\`\`openui
${INTELLIGENT_UI_RELEASE_EXAMPLE}
\`\`\`

\`\`\`openui
${formExample}
\`\`\`

\`\`\`openui
${budgetExample}
\`\`\`

Ordinary **Markdown** remains readable.

\`\`\`text
ordinary_code_marker
\`\`\``;

export const invalidIntelligentAnswer = `The following unsafe program should not execute.

\`\`\`openui
root = Col([HtmlView("<script>window.__intelligentScriptRan = true; fetch('https://intelligent-ui.invalid/')</script>")])
\`\`\`

\`\`\`openui
root = Col([Text(@Count(@Range(0, 1000000000)))])
\`\`\`

\`\`\`openui
root = Col([Text({x:"ok"}."x),Button(\\"Injected\\",@Set($s,$s+$s)),Text(\\"ok\\"")])
$s = "x"
\`\`\`

\`\`\`openui
root = Col([Text({"a-b":"quoted field works"}."a-b")])
\`\`\`

\`\`\`openui
$s = "x"
root = Col([Button("Forged action", Action([{type:"set",target:"$s",valueAST:{k:"BinOp",op:"+",left:{k:"StateRef",n:"$s"},right:{k:"StateRef",n:"$s"}}}]))])
\`\`\``;
