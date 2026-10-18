# Agents

An **Agent** is a saved persona with exactly one ongoing conversation of its own. You talk to it like any chat; it can start work in your trusted projects, which keeps running in the background and reports back into the same conversation.

## Use an Agent

1. Select **Agents** in the sidebar and **+** to create one. The editor opens in **Settings → Agent → Saved agents**: name, model, thinking level, permission, Skills and instructions. Select **Save agent**.
2. Click the Agent in the sidebar. Its conversation opens in the main pane and the sidebar stays on **Agents**. There is one conversation per Agent; it is not listed under any project.
3. Ask for work in a project, for example “check why the build fails in fateUI”. The Agent starts a **run** with the `run_in_project` tool and answers right away. When the run finishes, its result is posted into the Agent's conversation and the Agent continues from there.

The dot next to an Agent shows a run in progress, or unread items in its inbox (red when one of them failed). The **Monitor** in the inspector lists an Agent's runs while its conversation is open, and a project's Agent runs while that project is open. **Open run** shows the run's own conversation.

## Inbox and notifications

- Finished, failed and interrupted runs and Routine messages land in the **Inbox**. Select the bell in the Agents toolbar to open it; the bell shows a dot while something is unread. **Unread** filters the list and **Read all** clears it.
- Click an item to open its source: a run opens its own conversation; a Routine, or a run that never got a conversation, opens the Agent's chat. Opening an item marks it read, and so does looking at the Agent's chat.
- The inbox is kept on disk under `agents/v1/inbox/<agent id>` in the data directory, with the latest 100 items per Agent. After a crash, runs that were cut off show up as **Interrupted** once their lease runs out, about a minute after the last heartbeat. They are not replayed. Runs stopped because Fate UI closed show up as interrupted on the next start.
- While Fate UI is not the focused window, every finished or failed run raises a desktop notification; clicking it opens the same place as the inbox item. While Fate UI is focused you get the in-app toast instead, and nothing at all for the Agent chat you are looking at.
- **Mute notifications** on an Agent's row turns off its desktop notifications. Its inbox keeps filling.
- A Routine that could not send its message always notifies. A Routine that sent its message notifies only if that Routine had desktop notifications on in an earlier version.

## Where an Agent works

- **Its own folder.** Each Agent's conversation runs in a folder Fate UI owns, under the data directory at `agents/v1/homes/<agent id>`. Files, terminal and Memory Learning follow it like a project. Memory Learning's **PROJECT** store for that folder is the Agent's own memory; the **GLOBAL** profile applies as usual.
- **Your projects, through runs.** A run is an ordinary conversation in a trusted project, started with the Agent's instructions. It can use Agent Teams, GoalMax (the Agent picks `goal` mode for multi-step outcomes) and that project's Memory Learning. You can open it, read it and steer it like any session. A project switch or a session switch does not stop it.
- **Routines** send a message into the Agent's conversation on an interval, for example “every morning, check the open pull requests”. Add them on the Agent's card in Settings. They run only while Fate UI is open; missed intervals are skipped, not replayed.
- **Watches** check a public web page on an interval without waking the Agent. Add them on the Agent's card in Settings with **+ Watch**: a page address, a condition and how often to check. Only a hit posts a message into the Agent's conversation, which starts a turn, and shows a notification.

## Watches

| Condition | Hits when |
| --- | --- |
| Any change | The page's visible text differs from the last check. The first check only records the page. Edits that only change relative times such as “5 minutes ago” are ignored. The message lists up to 20 added and 20 removed lines. |
| Text appears | The text is on the page and was not at the last check, including the first check. Case and spacing are ignored. |
| Text disappears | The text is not on the page and was there at the last check, including the first check. |
| Price below / Price above | The first US dollar amount on the page (`$1,299.99`, `US$ 20`, `20 USD`) is strictly below or above the threshold and was not at the last check. A page without one counts as a failed check. |

- A watch fires once when its condition starts to hold and again only after it stopped holding. The last page fingerprint, text match and price are kept on disk, so a restart does not fire again.
- A check reads the page itself, not a browser: pages that build their text with JavaScript have no readable text and fail. The **Watch on** line shows the next check, the last price and the last hit.
- A failed check retries after 2, 4, 8 and 16 minutes. The fifth failure in a row pauses the watch with a notification, and the Agent shows **Watch paused** in the sidebar. **Resume** on the watch checks again right away. Saving a watch also checks right away; it keeps the last result unless the page, condition, text or price changed.
- Checks run only while Fate UI is open. Missed checks are skipped, not replayed, the same as Routines.
- Only public `http` and `https` pages on ports 80 and 443 are fetched. Private, loopback, link-local and cloud metadata addresses are refused, also after DNS resolution and redirects. A page may redirect five times, answer within 20 seconds and be at most 2 MB.
- Each hit is listed with the Agent's runs; **Open run** opens the Agent's conversation.

## Permissions and limits

- An Agent's **permission** (Read only, Edit files or Full access) caps its conversation and every run it starts. The permission you set in the Agent's conversation lowers it further. Project trust still applies; a run can only target a trusted project.
- **Edit files** writes without asking per file, like a normal conversation. Every change is in the run's conversation.
- **Full access** adds shell commands and MCP servers, for that Agent only. Choose it per Agent; existing Agents keep their permission.
- Agent Teams children in a run are capped at the run's permission.
- The browser is available only in the Agent's own conversation while it is the selected conversation. Runs do not use the browser.
- The Agent's conversation and its runs have `web_search` and `web_fetch` at every permission level, and the Agent uses them before the browser for simple lookups. Search queries go to Parallel; **Settings → Agent → Web search** turns search off. See [Web search and fetch](features.md#web-search-and-fetch).
- User-installed Pi extensions and project-local code are not loaded into Agent conversations or runs.
- A run stops after 30 minutes. At most four runs are active at once, and a project keeps at most four live conversations; when they are full, the run fails instead of closing your work. Interrupted runs are not replayed.
- Editing an Agent applies to its conversation the next time it starts; an idle conversation restarts right away.
- A Git worktree is a separate checkout, **not** a security sandbox. Check the diff before you integrate or publish it.
- Runs contact your configured AI provider. The app does not run Routines while closed, offline, or asleep.

## Earlier versions

- Agents saved for one project are now available everywhere.
- Earlier home chats stay as normal sessions in the projects where they were created; each Agent starts a fresh conversation in its own folder.
- A Routine from an earlier version takes the prompt of its TaskTemplate and starts turned off. TaskTemplate files stay on disk unchanged.
- Old Automations are not run. On an Agent's card, **Copy Automation** turns one into a Routine that starts turned off; the original file is unchanged.
