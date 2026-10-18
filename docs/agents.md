# Agents

An **Agent** is a saved persona with exactly one ongoing conversation of its own. You talk to it like any chat; it can start work in your trusted projects, which keeps running in the background and reports back into the same conversation.

## Use an Agent

1. Select **Agents** in the sidebar and **+** to create one. The editor opens in **Settings → Agent → Saved agents**: name, model, thinking level, permission, Skills and instructions. Select **Save agent**.
2. Click the Agent in the sidebar. Its conversation opens in the main pane and the sidebar stays on **Agents**. There is one conversation per Agent; it is not listed under any project.
3. Ask for work in a project, for example “check why the build fails in fateUI”. The Agent starts a **run** with the `run_in_project` tool and answers right away. When the run finishes, its result is posted into the Agent's conversation and the Agent continues from there.

The dot next to an Agent shows a run in progress, a new result, or a failed run. The **Monitor** in the inspector lists an Agent's runs while its conversation is open, and a project's Agent runs while that project is open. **Open run** shows the run's own conversation.

## Where an Agent works

- **Its own folder.** Each Agent's conversation runs in a folder Fate UI owns, under the data directory at `agents/v1/homes/<agent id>`. Files, terminal and Memory Learning follow it like a project. Memory Learning's **PROJECT** store for that folder is the Agent's own memory; the **GLOBAL** profile applies as usual.
- **Your projects, through runs.** A run is an ordinary conversation in a trusted project, started with the Agent's instructions. It can use Agent Teams, GoalMax (the Agent picks `goal` mode for multi-step outcomes) and that project's Memory Learning. You can open it, read it and steer it like any session. A project switch or a session switch does not stop it.
- **Routines** send a message into the Agent's conversation on an interval, for example “every morning, check the open pull requests”. Add them on the Agent's card in Settings. They run only while Fate UI is open; missed intervals are skipped, not replayed.

## Permissions and limits

- An Agent's **permission** (Read only, Edit files or Full access) caps its conversation and every run it starts. The permission you set in the Agent's conversation lowers it further. Project trust still applies; a run can only target a trusted project.
- **Edit files** writes without asking per file, like a normal conversation. Every change is in the run's conversation.
- **Full access** adds shell commands and MCP servers, for that Agent only. Choose it per Agent; existing Agents keep their permission.
- Agent Teams children in a run are capped at the run's permission.
- The browser is available only in the Agent's own conversation while it is the selected conversation. Runs do not use the browser.
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
