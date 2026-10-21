---
name: teams-native-chat
description: Send text and explicit hyperlinks as the signed-in user to a selected Microsoft Teams chat using the Teams web client's native chat service and ego-browser. Use for direct Teams chat sending without Microsoft Graph or Power Automate webhooks. Does not support channel posts, attachments, mentions, or threaded replies.
---

# Teams native chat

Use the bundled `scripts/teams-native` CLI. It calls the authenticated Teams web worker's native chat service; authentication stays inside Teams. Do not copy browser tokens, cookies, or captured request headers into files or terminal output.

## Connect and select

Read the installed `ego-browser` skill and run `ego-browser skill` before operating its browser. Requires Python 3, `ego-browser`, and a work/school account signed in to Teams web. The native API adapter was verified on 2026-10-20; this is an internal interface, so Teams updates can break it. See [native-interface.md](references/native-interface.md) when diagnosing compatibility.

```bash
CLI="$HOME/.agents/skills/teams-native-chat/scripts/teams-native"
"$CLI" connect
"$CLI" status
"$CLI" chats --query '방 이름'
```

When installed elsewhere, use this skill's actual `scripts/teams-native` path.
`connect --space ID` resumes an existing agent-owned task space with Teams on `p1`. Reuse one task space for the user's goal. Never claim a user-owned space or bypass user control. If login/consent is needed, hand the browser to the user and resume after they finish.

Check the reported account and exact room. `chats` searches Teams' synchronized local cache, not guaranteed complete server history. Use a known exact chat ID for older rooms absent from that list. `--chat-name` requires an exact unique name; ambiguous names fail. The reserved `48:notes` ID is the signed-in user's self-chat.

## Preview, send, verify

Before drafting into an ongoing conversation, read the room's messages since the user's last one (Teams web DOM in the same task space) and any linked source they reference, such as new ticket comments. Draft against the newest question, name the exact item the message is about, and leave out what the room already knows.

The user must authorize the destination and message intent. Creating this skill does not authorize announcements to coworkers. Once the user clearly requests a send, do not ask for redundant confirmation. A test send belongs in a confirmed self-chat or an explicitly designated test room.

```bash
"$CLI" send --chat-id 'EXACT_CHAT_ID' --text-file /absolute/path/message.txt --dry-run
"$CLI" send --chat-id 'EXACT_CHAT_ID' --text-file /absolute/path/message.txt --execute
"$CLI" verify --chat-id 'EXACT_CHAT_ID' --message-id 'RETURNED_MESSAGE_ID'
```

Without `--execute`, `send` only previews. `--text` is supported; for multiline text use a UTF-8 file or `--text-file -` with stdin. Text is escaped as HTML, preserving line breaks. Limit: 20,000 UTF-8 bytes, a conservative CLI limit rather than a claimed Teams limit. Mention-like strings are plain text; no notifications/mentions are synthesized.

Jira issue keys must be clickable in work announcements. Resolve the issue's real URL from the current project's configuration or source; do not invent its hostname. Pass `--link 'A20-1234' 'https://your-site.atlassian.net/browse/A20-1234'` with the same label in the message text. Repeat `--link LABEL URL` for multiple links. It emits an escaped HTML anchor; Markdown link syntax and bare issue keys otherwise remain plain text. Only HTTP(S) URLs without embedded credentials are accepted. Include identical link options in preview and execution.

The script checks the connected account and live conversation, sends through the native no-retry transport once, and reads the message back. `PASS` with `verified:true` proves matching stored content and client message ID, not that recipients read it. Do not claim a deployment was independently verified when the user supplied that fact.

`SEND_OUTCOME_UNKNOWN` or `SEND_UNVERIFIED`: do not resend automatically. Check the room or use the returned message ID with `verify`. Local `~/.local/state/teams-native-chat/last-send.json` holds the last receipt, never tokens or message content. For an unknown result without a server message ID, inspect Teams before any retry. Login expiry, permission errors, interface drift, and browser-control problems must stay explicit failures.

The connected account is pinned until `connect` is run again. A different account/tenant fails before sending. Runtime state is private local data, never part of the repository; `TEAMS_NATIVE_STATE_DIR` can override its directory.

After all operations for the goal, close the task space:

```bash
"$CLI" close
```

This closes the CLI's browser task space without logging out. Next use starts with `connect`. Report the room, send result, and verification limits concisely; link this skill when it authorizes sending on the user's behalf.

## Checks

```bash
node --test scripts/core.test.mjs
python3 scripts/teams-native --help
```

Offline tests do not prove the current Teams client interface still works. Verify an intentional self-chat send after adapter changes, only within the user's authorization.
