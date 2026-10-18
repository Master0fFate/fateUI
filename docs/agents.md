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

## Gmail and Google Calendar

An Agent can read your Gmail and your primary Google Calendar, and send mail or change events after you approve each one. You use your own Google OAuth client.

1. In Google Cloud Console, create a project and enable the **Gmail API** and the **Google Calendar API**.
2. On the OAuth consent screen, choose External, add your address as a test user, then publish the app to **In production**. In Testing, Google ends the sign-in every 7 days. Google shows an unverified-app warning at sign-in; the app is your own.
3. Create an OAuth client of type **Desktop app**.
4. In **Settings → Agent → Google**, paste the client ID and secret, select **Save client**, then **Connect**. Your browser opens Google's sign-in. Fate UI asks only to read Gmail and Calendar events.
5. To let Agents send mail and change events, select **Allow sending**. Google asks for those two permissions.
6. Turn on **Google** on the card of each Agent that should use it.

- `google_mail_search`, `google_mail_read` and `google_calendar_read` read without asking. Search returns up to 20 messages; a thread shows its last 20 messages.
- `google_mail_send` and `google_calendar_change` show the exact message or change in the conversation and wait up to 30 minutes for your answer. Writing your own answer declines and passes your note to the Agent.
- Each decision and outcome is appended to `google/receipts.jsonl` in the data directory.
- If Google does not confirm a send or change, for example after a timeout or a server error, the outcome is reported as unknown and nothing is retried. Check Sent or the calendar before asking again.
- Recurring events are not changed, and attendees are not notified.
- Google tools work only in the Agent's own conversation, never in runs, and stay off for Full access Agents. Mail is text from other people; with shell access, a message could steer an Agent into sending your data elsewhere.
- The client secret and the sign-in are encrypted with the operating system's key store in `google/account.bin`. **Disconnect** revokes the sign-in at Google.
- A Routine such as “every morning, summarize my unread mail” reads without asking. A send it proposes waits in the Agent's conversation until you open it and answer; the taskbar flashes while Fate UI is in the background.

## Permissions and limits

- An Agent's **permission** (Read only, Edit files or Full access) caps its conversation and every run it starts. The permission you set in the Agent's conversation lowers it further. Project trust still applies; a run can only target a trusted project.
- **Edit files** writes without asking per file, like a normal conversation. Every change is in the run's conversation.
- **Full access** adds shell commands and MCP servers, for that Agent only, and turns Google off. Choose it per Agent; existing Agents keep their permission.
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
