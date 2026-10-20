export function resolveChat(chats, id, name) {
  const hits = chats.filter(c => id ? c.id === id : c.name === name);
  if (hits.length !== 1) throw new Error(hits.length ? 'AMBIGUOUS_CHAT_NAME' : 'CHAT_NOT_FOUND');
  return hits[0];
}

export function buildMessage(chatId, text, user, clientId, now) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('EMPTY_MESSAGE');
  if (new TextEncoder().encode(text).length > 20000) throw new Error('TEXT_TOO_LARGE_20000_BYTES');
  if (!/^\d+$/.test(clientId)) throw new Error('INVALID_CLIENT_MESSAGE_ID');
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/\r\n?/g, '\n').replace(/\n/g, '<br>');
  const mri = `8:orgid:${user.id}`;
  return {id:'-1', type:'Message', conversationid:chatId, conversationLink:`blah/${chatId}`,
    from:mri, fromUserId:mri, composetime:now, originalarrivaltime:now,
    content:`<p>${escaped}</p>`, messagetype:'RichText/Html', contenttype:'Text',
    imdisplayname:user.name, clientmessageid:clientId, callId:'', state:0, version:'0',
    amsreferences:[], properties:{importance:'',subject:'',title:'',cards:'[]',links:'[]',
      mentions:'[]',onbehalfof:null,files:'[]',policyViolation:null,formatVariant:'TEAMS'}, crossPostChannels:[]};
}

// Runs inside the authenticated Teams web worker. No token crosses this boundary.
export async function workerOperation(args) {
  const machine = self.workerServer?._stateAndRequestHandlers?.get('graphql')?.stateMachine;
  if (!machine) throw new Error('TEAMS_INTERNAL_INTERFACE_CHANGED');
  const ctx = await machine.isCompleted();
  const u = ctx.currentUser;
  if (!u?.isAuthenticated || !u.id || !u.profile?.tid) throw new Error('TEAMS_LOGIN_REQUIRED');
  const user = {id:u.id, tenantId:u.profile.tid, name:u.profile.name || u.userName || u.id};
  if (args.account && (args.account.id !== user.id || args.account.tenantId !== user.tenantId))
    throw new Error('ACCOUNT_CHANGED_RECONNECT_REQUIRED');
  const svc = ctx.services?.chatService;
  if (!svc?.getMyConversation || !svc?.getConversationMessage || !svc?._transportWithNoRetry?.postMessageToConversation)
    throw new Error('TEAMS_INTERNAL_INTERFACE_CHANGED');
  if (args.command === 'status' || args.command === 'connect') return {status:'PASS', account:user};
  const raw = await ctx.managers.conversationManager.getConversations(undefined, 'teams-native-chat',
    {shouldSuppressL2LastMessageUpdates:true});
  if (!raw?.length) throw new Error('CHAT_CACHE_EMPTY_OR_UNAVAILABLE');
  const chats = raw.filter(c => c.threadProperties?.threadType === 'chat' || c.id === '48:notes')
    .map(c => ({id:c.id, name:c.id === '48:notes' ? '나와의 채팅' :
      c.threadProperties?.topic || c.chatTitle?.shortTitle || c.id,
      kind:c.id === '48:notes' ? 'self' : c.threadProperties?.productThreadType || 'Chat'}));
  if (args.command === 'chats') return {status:'PASS', source:'Teams synchronized local chat cache',
    completeServerHistory:false, account:user, chats:chats.filter(c => !args.query || c.name.toLowerCase().includes(args.query.toLowerCase()) || c.id.includes(args.query))};
  // Exact selection only. An ID may refer to an older chat absent from the local cache.
  let chat = args.chatId ? chats.find(c => c.id === args.chatId) : resolveChat(chats, undefined, args.chatName);
  const targetId = args.chatId || chat.id;
  const remote = await svc.getMyConversation(targetId, crypto.randomUUID());
  if (remote.id !== targetId) throw new Error('CHAT_ID_MISMATCH');
  if (remote.threadProperties?.threadType !== 'chat' && !(targetId === '48:notes' && remote.threadProperties?.threadType === 'streamofnotes'))
    throw new Error('UNSUPPORTED_CHAT_TYPE');
  if (remote.memberProperties?.isReader === true || /^(Reader|Blocked|Removed)$/i.test(remote.memberProperties?.role || ''))
    throw new Error('CHAT_NOT_WRITABLE');
  chat ||= {id:targetId, name:remote.threadProperties?.topic || targetId, kind:'Chat'};
  if (args.command === 'verify') {
    if (!args.messageId) throw new Error('MESSAGE_ID_REQUIRED');
    const m = await svc.getConversationMessage(chat.id, args.messageId);
    return {status:m?.id === args.messageId ? 'PASS' : 'FAIL', chat, messageId:m?.id,
      clientMessageId:m?.clientmessageid, sender:m?.from, verified: m?.id === args.messageId};
  }
  const payload = buildMessage(chat.id, args.text, user, args.clientMessageId, new Date().toISOString());
  if (!args.execute) return {status:'DRY_RUN', account:user, chat, text:args.text,
    clientMessageId:payload.clientmessageid, willSend:false};
  // Mark the irreversible boundary before invoking the native no-retry transport.
  let sent;
  try {
    sent = await svc._transportWithNoRetry.postMessageToConversation(chat.id, payload,
      crypto.randomUUID(), undefined, svc.addSflHeaders());
  } catch (error) {
    const httpStatus = error?.serverResponse?.status;
    if (httpStatus === 401 || httpStatus === 403) return {status:'FAIL', error:`HTTP_${httpStatus}`, chat, retry:false};
    return {status:'SEND_OUTCOME_UNKNOWN', chat, clientMessageId:payload.clientmessageid,
      retry:false, action:'Check this chat in Teams before any further send.'};
  }
  const messageId = String(sent?.id || sent?.messageId || '');
  if (!messageId) return {status:'SEND_UNVERIFIED', chat, clientMessageId:payload.clientmessageid,
    retry:false, action:'No message id returned. Check Teams; do not resend.'};
  try {
    const stored = await svc.getConversationMessage(chat.id, messageId);
    const verified = stored?.id === messageId && stored?.content === payload.content && stored?.clientmessageid === payload.clientmessageid;
    return {status:verified?'PASS':'SEND_UNVERIFIED', chat, messageId,
      clientMessageId:payload.clientmessageid, verified, retry:false};
  } catch {
    return {status:'SEND_UNVERIFIED', chat, messageId, clientMessageId:payload.clientmessageid, retry:false};
  }
}
