# Native interface evidence

Verified against the signed-in Teams web client on 2026-10-20, client build `26091712226`. No Microsoft Graph API, app registration, or webhook is used.

Flow: CLI → ego-browser → Teams page's own worker via CDP → native `chatService` → Teams chat service → message readback.

The page redirects from `https://teams.microsoft.com/v2/` to `https://teams.cloud.microsoft/`. Its core worker URL contains `precompiled-web-worker`. Match its `parentId` to the active page's `Target.getTargetInfo` result; never select an unrelated tab's worker. Attach with non-flattened `Target.attachToTarget`, evaluate through `Target.sendMessageToTarget`, collect only the matching RPC result, and detach afterward.

```js
const ctx = await self.workerServer
  ._stateAndRequestHandlers.get('graphql').stateMachine.isCompleted();
const svc = ctx.services.chatService;
```

The string `graphql` is the Teams client's internal state-machine key, not Microsoft's Graph API.

- Current account: `ctx.currentUser.id`, `profile.tid`, `profile.name`, `isAuthenticated`.
- Local chat list: `ctx.managers.conversationManager.getConversations(undefined, 'teams-native-chat', {shouldSuppressL2LastMessageUpdates:true})`. Failure may return an empty list; treat empty as unavailable, not proof of no chats.
- Live target: `svc.getMyConversation(chatId, correlationIdString)`.
- Send without automatic offline retry: `svc._transportWithNoRetry.postMessageToConversation(chatId, message, correlationIdString, undefined, svc.addSflHeaders())`.
- Readback: `svc.getConversationMessage(chatId, serverMessageId)`.

Observed native route is `/api/chatsvc/<region>/v1/users/ME/conversations/<encoded-chat-id>/messages`. The adapter calls the service instead of hardcoding a region or bearer token. Native service model sets `authOptions.source='mfeService'` and handles the current authentication scheme. A raw legacy Skype token was not valid for this client's migrated authentication; do not replace native auth with token extraction.

Observed message type is `RichText/Html`, content type `Text`; ordinary plain text is escaped into `<p>…</p>`. The observed self-chat ID is `48:notes`. Channel thread types are deliberately rejected. POST returns an ID derived from the Location header; readback must match both content and `clientmessageid`.

Source inspection at verification time: worker factory `65647` exposed the state-machine context; conversation manager `74525`; chat service/model registration `66704`; request builders `34565` (`do` POST, `bO` GET conversation, `qi` GET message). These build-specific module numbers are evidence only and are not runtime dependencies.

Compatibility failures must stop explicitly. Never brute-force endpoints, bypass access controls, or retry an uncertain POST. Support is limited to this work/school Teams web-client shape; personal Teams, channel posts, files, mentions, and reply threading are not implemented.
