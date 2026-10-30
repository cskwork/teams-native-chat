export function resolveChat(chats, id, name) {
  const hits = chats.filter(c => id ? c.id === id : c.name === name);
  if (hits.length !== 1) throw new Error(hits.length ? 'AMBIGUOUS_CHAT_NAME' : 'CHAT_NOT_FOUND');
  return hits[0];
}

// mentions: [[label, mri]] — label must appear in text; rendered as a Teams person mention.
export function buildMessage(chatId, text, user, clientId, now, links = [], mentions = []) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('EMPTY_MESSAGE');
  if (new TextEncoder().encode(text).length > 20000) throw new Error('TEXT_TOO_LARGE_20000_BYTES');
  if (!/^\d+$/.test(clientId)) throw new Error('INVALID_CLIENT_MESSAGE_ID');
  const escape = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/\r\n?/g, '\n').replace(/\n/g, '<br>');
  const targets = new Map();
  for (const [label, address] of links) {
    if (!label?.trim() || /[\r\n]/.test(label) || !text.includes(label) || targets.has(label))
      throw new Error('INVALID_LINK_LABEL');
    let url;
    try { url = new URL(address); } catch { throw new Error('INVALID_LINK_URL'); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
      throw new Error('INVALID_LINK_URL');
    targets.set(label, url.href);
  }
  const mentionIds = new Map();
  for (const [label, mri] of mentions) {
    if (!label?.trim() || /[\r\n]/.test(label) || !text.includes(label) || targets.has(label) || mentionIds.has(label))
      throw new Error('INVALID_MENTION_LABEL');
    if (!/^8:orgid:[0-9a-f-]{36}$/.test(mri || '')) throw new Error('INVALID_MENTION_MRI');
    mentionIds.set(label, {itemid:mentionIds.size, mri});
  }
  const labels = [...targets.keys(), ...mentionIds.keys()].sort((a,b) => b.length-a.length);
  const pattern = labels.map(label => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const escaped = labels.length ? text.split(new RegExp(`(${pattern})`, 'g')).map(part =>
    targets.has(part) ? `<a href="${escape(targets.get(part))}">${escape(part)}</a>`
      : mentionIds.has(part) ? `<span itemtype="http://schema.skype.com/Mention" itemscope="" itemid="${mentionIds.get(part).itemid}">${escape(part)}</span>`
      : escape(part)).join('') : escape(text);
  const mentionProps = [...mentionIds].map(([label, m]) => ({'@type':'http://schema.skype.com/Mention',
    itemid:m.itemid, mri:m.mri, mentionType:'person', displayName:label}));
  const mri = `8:orgid:${user.id}`;
  return {id:'-1', type:'Message', conversationid:chatId, conversationLink:`blah/${chatId}`,
    from:mri, fromUserId:mri, composetime:now, originalarrivaltime:now,
    content:`<p>${escaped}</p>`, messagetype:'RichText/Html', contenttype:'Text',
    imdisplayname:user.name, clientmessageid:clientId, callId:'', state:0, version:'0',
    amsreferences:[], properties:{importance:'',subject:'',title:'',cards:'[]',links:'[]',
      mentions:JSON.stringify(mentionProps),onbehalfof:null,files:'[]',policyViolation:null,formatVariant:'TEAMS'}, crossPostChannels:[]};
}

// Read-only: one raw Teams message -> the fields a reader needs. Raw HTML, tokens and
// other properties never leave the worker. Returns null for system/deleted messages.
export function sanitizeMessage(m) {
  if (!m || typeof m !== 'object' || !/^(RichText\/Html|RichText|Text)$/.test(m.messagetype || '')) return null;
  if (m.properties?.deletetime) return null;
  const named = {amp:'&', lt:'<', gt:'>', quot:'"', apos:"'", nbsp:' '};
  const code = n => Number.isInteger(n) && n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '';
  const text = String(m.content || '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|blockquote|h[1-6])>/gi, '\n').replace(/<[^>]*>/g, '')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (all, e) => e[0] !== '#' ? (named[e.toLowerCase()] ?? all)
      : code(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))))
    .split('\n').map(line => line.replace(/[ \t ]+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  let raw = m.properties?.mentions;
  if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { raw = []; } }
  const mentions = [...new Set((Array.isArray(raw) ? raw : []).map(x => x?.mri).filter(x => typeof x === 'string' && /^8:orgid:[0-9a-f-]{36}$/i.test(x)))];
  return {id:String(m.id ?? ''), time:m.originalarrivaltime || m.composetime || '', author:m.imdisplayname || '',
    authorMri:String(m.from || '').split('/').pop(), text:text.slice(0, 4000), mentions};
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
  if (args.command === 'messages') {
    // Read-only room read: exact chat ID, newest first, sanitized fields only.
    if (!args.chatId) throw new Error('CHAT_ID_REQUIRED');
    if (!svc.getConversationMessages) throw new Error('TEAMS_INTERNAL_INTERFACE_CHANGED');
    const remote = await svc.getMyConversation(args.chatId, crypto.randomUUID());
    if (remote?.id !== args.chatId) throw new Error('CHAT_ID_MISMATCH');
    // The self-chat is a streamofnotes thread; send already accepts it (see below), so reads do too.
    if (remote.threadProperties?.threadType !== 'chat' && !(args.chatId === '48:notes' && remote.threadProperties?.threadType === 'streamofnotes'))
      throw new Error('UNSUPPORTED_CHAT_TYPE');
    const limit = Math.min(Math.max(Number.parseInt(args.limit, 10) || 20, 1), 50);
    const r = await svc.getConversationMessages({conversationId:args.chatId, id:args.chatId},
      {id:crypto.randomUUID(), appendEventData() {}}, 1, '', limit);
    if (!Array.isArray(r?.messages)) throw new Error('TEAMS_INTERNAL_INTERFACE_CHANGED');
    return {status:'PASS', account:user, chat:{id:args.chatId, name:remote.threadProperties?.topic || args.chatId},
      order:'newest-first', messages:r.messages.slice(0, limit).map(sanitizeMessage).filter(Boolean)};
  }
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
  // --mention LABEL MEMBER: MEMBER is matched against display names of current chat members seen in recent messages.
  const mentions = [];
  if (args.mentions?.length) {
    const roster = await svc.getThreadMembers(chat.id);
    const memberIds = new Set((roster?.members || []).map(x => x.id));
    const recent = await svc.getConversationMessages({conversationId:chat.id}, crypto.randomUUID());
    const names = new Map();
    for (const x of recent?.messages || []) {
      const mri = (x.from || '').split('/').pop();
      if (memberIds.has(mri) && x.imdisplayname) names.set(mri, x.imdisplayname);
    }
    for (const [label, who] of args.mentions) {
      const hits = [...names].filter(([, n]) => n.includes(who));
      if (hits.length !== 1) throw new Error(hits.length ? 'AMBIGUOUS_MENTION_MEMBER' : 'MENTION_MEMBER_NOT_FOUND');
      mentions.push([label, hits[0][0], hits[0][1]]);
    }
  }
  const payload = buildMessage(chat.id, args.text, user, args.clientMessageId, new Date().toISOString(), args.links,
    mentions.map(([label, mri]) => [label, mri]));
  if (!args.execute) return {status:'DRY_RUN', account:user, chat, text:args.text,
    links:args.links || [], mentions:mentions.map(([label, mri, name]) => ({label, member:name, mri})),
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
    // Teams inserts formatting CRLF after <br>; it is not additional message text.
    const storedContent = stored?.content?.replace(/<br>\r\n/g, '<br>');
    const verified = stored?.id === messageId && storedContent === payload.content && stored?.clientmessageid === payload.clientmessageid;
    return {status:verified?'PASS':'SEND_UNVERIFIED', chat, messageId,
      clientMessageId:payload.clientmessageid, verified, retry:false};
  } catch {
    return {status:'SEND_UNVERIFIED', chat, messageId, clientMessageId:payload.clientmessageid, retry:false};
  }
}
