import assert from 'node:assert/strict';
import test from 'node:test';
import {buildMessage, resolveChat, sanitizeMessage, workerOperation} from './core.mjs';

const user = {id:'user-1', tenantId:'tenant-1', name:'사용자'};
const chat = {id:'19:chat-1', threadProperties:{threadType:'chat', topic:'검증 채팅'}};
const sendArgs = {command:'send', chatId:chat.id, text:'hello <Teams>\n다음 줄',
  clientMessageId:'123456789', account:user};

// Recreate the browser's serialization boundary, with no browser or network.
function fixture(options = {}) {
  const calls = {post:[], read:[], conversation:[]};
  let payload;
  const svc = {
    getMyConversation: async (...args) => {
      calls.conversation.push(args);
      return options.remote ?? chat;
    },
    getConversationMessage: async (...args) => {
      calls.read.push(args);
      if (options.readError) throw new Error('read failed');
      return options.stored ?? {id:'message-1', content:payload?.content,
        clientmessageid:payload?.clientmessageid, from:'8:orgid:user-1'};
    },
    getConversationMessages: async (...args) => {
      calls.messages = [...(calls.messages || []), args];
      return options.messages ?? {messages:[]};
    },
    addSflHeaders: () => ({mock:true}),
    _transportWithNoRetry: {
      postMessageToConversation: async (...args) => {
        calls.post.push(args);
        payload = args[1];
        if (options.postError) throw options.postError instanceof Error ? options.postError : new Error('response lost');
        return Object.hasOwn(options, 'postResult') ? options.postResult : {id:'message-1'};
      },
    },
  };
  const ctx = {
    currentUser:options.currentUser ?? {isAuthenticated:true, id:user.id,
      profile:{tid:user.tenantId, name:user.name}},
    services:{chatService:svc},
    managers:{conversationManager:{getConversations:async () => options.chats ?? [chat]}},
  };
  const self = {workerServer:{_stateAndRequestHandlers:new Map([
    ['graphql', {stateMachine:{isCompleted:async () => ctx}}],
  ])}};
  const evaluate = new Function('self', 'crypto', 'TextEncoder',
    `const buildMessage=${buildMessage.toString()};
     const resolveChat=${resolveChat.toString()};
     const sanitizeMessage=${sanitizeMessage.toString()};
     return (${workerOperation.toString()});`)(self, {randomUUID:() => 'mock-uuid'}, TextEncoder);
  return {calls, run:(args = {}) => evaluate({...sendArgs, ...args})};
}

test('plain text escapes all HTML delimiters and normalizes CRLF, CR and LF', () => {
  const message = buildMessage(chat.id, '&<>"\'\r\nB\rC\nD', user, '123', 'now');
  assert.equal(message.content, '<p>&amp;&lt;&gt;&quot;&#39;<br>B<br>C<br>D</p>');
  assert.equal(message.from, '8:orgid:user-1');
  assert.equal(message.conversationid, chat.id);
  assert.equal(message.clientmessageid, '123');
  assert.equal(message.composetime, 'now');
});

test('empty and whitespace-only messages fail before payload construction', () => {
  for (const text of ['', ' \r\n\t', undefined])
    assert.throws(() => buildMessage(chat.id, text, user, '123', 'now'), /EMPTY_MESSAGE/);
});

test('message limit is exactly 20000 UTF-8 bytes, including multibyte text', () => {
  assert.doesNotThrow(() => buildMessage(chat.id, '가'.repeat(6666)+'ab', user, '123', 'now'));
  assert.throws(() => buildMessage(chat.id, '가'.repeat(6667), user, '123', 'now'), /TEXT_TOO_LARGE_20000_BYTES/);
});

test('invalid client message IDs fail', () => {
  for (const id of ['', '-1', '1.2', '12x'])
    assert.throws(() => buildMessage(chat.id, 'text', user, id, 'now'), /INVALID_CLIENT_MESSAGE_ID/);
});

test('explicit hyperlink escapes query separators and HTML in the label', () => {
  const label = 'Guide & <"spec">';
  const message = buildMessage(chat.id, `Open ${label}.`, user, '123', 'now',
    [[label, 'https://example.test/guide?lang=ko&v=1']]);
  assert.equal(message.content,
    '<p>Open <a href="https://example.test/guide?lang=ko&amp;v=1">Guide &amp; &lt;&quot;spec&quot;&gt;</a>.</p>');
});

test('URL attribute quotes are encoded and cannot introduce another attribute', () => {
  const message = buildMessage(chat.id, 'Guide', user, '123', 'now',
    [['Guide', 'https://example.test/?q=" onclick="alert(1)&v=2']]);
  assert.equal(message.content,
    '<p><a href="https://example.test/?q=%22%20onclick=%22alert(1)&amp;v=2">Guide</a></p>');
});

for (const address of ['javascript:alert(1)', 'data:text/html,hello',
  'https://user:pass@example.test/', 'https://user@example.test/']) {
  test(`unsafe or credential-bearing hyperlink is rejected: ${address}`, () => {
    assert.throws(() => buildMessage(chat.id, 'Guide', user, '123', 'now',
      [['Guide', address]]), /INVALID_LINK_URL/);
  });
}

test('link labels must exist in text and cannot be configured twice', () => {
  assert.throws(() => buildMessage(chat.id, 'Guide', user, '123', 'now',
    [['Missing', 'https://example.test/']]), /INVALID_LINK_LABEL/);
  assert.throws(() => buildMessage(chat.id, 'Guide', user, '123', 'now',
    [['Guide', 'https://example.test/one'], ['Guide', 'https://example.test/two']]), /INVALID_LINK_LABEL/);
});

test('blank or multiline hyperlink labels are rejected', () => {
  for (const label of [' ', '\n', 'a\nb'])
    assert.throws(() => buildMessage(chat.id, `Guide ${label}`, user, '123', 'now',
      [[label, 'https://example.test/']]), /INVALID_LINK_LABEL/);
});

test('regular expression metacharacters in a label match literally', () => {
  const label = '.[x](v)+?*^$|\\';
  const message = buildMessage(chat.id, `Open ${label} then .xv.`, user, '123', 'now',
    [[label, 'https://example.test/']]);
  assert.equal(message.content,
    '<p>Open <a href="https://example.test/">.[x](v)+?*^$|\\</a> then .xv.</p>');
});

test('overlapping labels select the longest match and repeated text is linked', () => {
  const message = buildMessage(chat.id, 'API v2 / API / API', user, '123', 'now',
    [['API', 'https://example.test/v1'], ['API v2', 'https://example.test/v2']]);
  assert.equal(message.content,
    '<p><a href="https://example.test/v2">API v2</a> / <a href="https://example.test/v1">API</a> / <a href="https://example.test/v1">API</a></p>');
});

test('exact chat names resolve, partial names do not', () => {
  const chats = [{id:'a', name:'Team Alpha'}];
  assert.equal(resolveChat(chats, undefined, 'Team Alpha'), chats[0]);
  assert.throws(() => resolveChat(chats, undefined, 'Team'), /CHAT_NOT_FOUND/);
});

test('duplicate chat names fail and explicit ID disambiguates', () => {
  const chats = [{id:'a', name:'Team'}, {id:'b', name:'Team'}];
  assert.throws(() => resolveChat(chats, undefined, 'Team'), /AMBIGUOUS_CHAT_NAME/);
  assert.equal(resolveChat(chats, 'b'), chats[1]);
});

test('dry-run validates the target and makes zero POSTs or readbacks', async () => {
  const f = fixture();
  const result = await f.run();
  assert.equal(result.status, 'DRY_RUN');
  assert.equal(result.willSend, false);
  assert.equal(result.text, sendArgs.text);
  assert.equal(f.calls.conversation.length, 1);
  assert.equal(f.calls.post.length, 0);
  assert.equal(f.calls.read.length, 0);
});

test('dry-run validates hyperlinks and makes zero POSTs', async () => {
  const f = fixture();
  const links = [['Guide', 'https://example.test/?a=1&b=2']];
  const result = await f.run({text:'Open Guide', links});
  assert.equal(result.status, 'DRY_RUN');
  assert.equal(result.willSend, false);
  assert.deepEqual(result.links, links);
  assert.equal(f.calls.post.length, 0);
  assert.equal(f.calls.read.length, 0);
});

test('invalid hyperlink on execute fails before POST', async () => {
  const f = fixture();
  await assert.rejects(f.run({execute:true, text:'Guide', links:[['Guide', 'javascript:alert(1)']]}),
    /INVALID_LINK_URL/);
  assert.equal(f.calls.post.length, 0);
});

test('execute makes exactly one native no-retry POST followed by exact readback', async () => {
  const f = fixture();
  const result = await f.run({execute:true});
  assert.equal(result.status, 'PASS');
  assert.equal(result.verified, true);
  assert.equal(result.retry, false);
  assert.equal(result.messageId, 'message-1');
  assert.equal(f.calls.post.length, 1);
  assert.equal(f.calls.post[0][0], chat.id);
  assert.equal(f.calls.post[0][1].content, '<p>hello &lt;Teams&gt;<br>다음 줄</p>');
  assert.deepEqual(f.calls.read, [[chat.id, 'message-1']]);
});

test('native POST rejection produces uncertain outcome with no retry or readback', async () => {
  const f = fixture({postError:true});
  const result = await f.run({execute:true});
  assert.equal(result.status, 'SEND_OUTCOME_UNKNOWN');
  assert.equal(result.retry, false);
  assert.equal(result.clientMessageId, sendArgs.clientMessageId);
  assert.equal(f.calls.post.length, 1);
  assert.equal(f.calls.read.length, 0);
});

test('native HTTP 403 rejection is explicit failure without retry or readback', async () => {
  const f = fixture({postError:Object.assign(new Error('forbidden'), {serverResponse:{status:403}})});
  const result = await f.run({execute:true});
  assert.equal(result.status, 'FAIL');
  assert.equal(result.error, 'HTTP_403');
  assert.equal(result.retry, false);
  assert.equal(f.calls.post.length, 1);
  assert.equal(f.calls.read.length, 0);
});

test('a missing returned message ID is unverified and never retried', async () => {
  const f = fixture({postResult:{}});
  const result = await f.run({execute:true});
  assert.equal(result.status, 'SEND_UNVERIFIED');
  assert.equal(result.retry, false);
  assert.equal(f.calls.post.length, 1);
  assert.equal(f.calls.read.length, 0);
});

test('readback failure is unverified and never repeats the POST', async () => {
  const f = fixture({readError:true});
  const result = await f.run({execute:true});
  assert.equal(result.status, 'SEND_UNVERIFIED');
  assert.equal(result.retry, false);
  assert.equal(f.calls.post.length, 1);
  assert.equal(f.calls.read.length, 1);
});

test('readback content mismatch cannot pass', async () => {
  const f = fixture({stored:{id:'message-1', content:'different', clientmessageid:sendArgs.clientMessageId}});
  const result = await f.run({execute:true});
  assert.equal(result.status, 'SEND_UNVERIFIED');
  assert.equal(result.verified, false);
  assert.equal(f.calls.post.length, 1);
});

test('readback accepts server CRLF inserted immediately after each literal br', async () => {
  const f = fixture({stored:{id:'message-1', content:'<p>a<br>\r\nb<br>\r\n</p>',
    clientmessageid:sendArgs.clientMessageId}});
  const result = await f.run({execute:true, text:'a\nb\n'});
  assert.equal(f.calls.post[0][1].content, '<p>a<br>b<br></p>');
  assert.equal(result.status, 'PASS');
  assert.equal(result.verified, true);
  assert.equal(f.calls.post.length, 1);
  assert.equal(f.calls.read.length, 1);
});

test('normalizing server br CRLF does not hide changed actual text', async () => {
  const f = fixture({stored:{id:'message-1', content:'<p>a<br>\r\nchanged<br>\r\n</p>',
    clientmessageid:sendArgs.clientMessageId}});
  const result = await f.run({execute:true, text:'a\nb\n'});
  assert.equal(result.status, 'SEND_UNVERIFIED');
  assert.equal(result.verified, false);
  assert.equal(f.calls.post.length, 1);
  assert.equal(f.calls.read.length, 1);
});

test('readback client message ID mismatch cannot pass', async () => {
  const f = fixture({stored:{id:'message-1', content:'<p>hello &lt;Teams&gt;<br>다음 줄</p>', clientmessageid:'other'}});
  const result = await f.run({execute:true});
  assert.equal(result.status, 'SEND_UNVERIFIED');
  assert.equal(result.verified, false);
  assert.equal(f.calls.post.length, 1);
});

test('readback message ID mismatch cannot pass even when content and client ID match', async () => {
  const f = fixture({stored:{id:'another-message', content:'<p>hello &lt;Teams&gt;<br>다음 줄</p>',
    clientmessageid:sendArgs.clientMessageId}});
  const result = await f.run({execute:true});
  assert.equal(result.status, 'SEND_UNVERIFIED');
  assert.equal(result.verified, false);
  assert.equal(f.calls.post.length, 1);
  assert.equal(f.calls.read.length, 1);
});

for (const account of [{...user, id:'different'}, {...user, tenantId:'different'}]) {
  test(`account ${account.id === user.id ? 'tenant' : 'user'} mismatch prevents target lookup and send`, async () => {
    const f = fixture();
    await assert.rejects(f.run({execute:true, account}), /ACCOUNT_CHANGED_RECONNECT_REQUIRED/);
    assert.equal(f.calls.conversation.length, 0);
    assert.equal(f.calls.post.length, 0);
  });
}

test('unauthenticated session cannot send', async () => {
  const f = fixture({currentUser:{isAuthenticated:false}});
  await assert.rejects(f.run({execute:true}), /TEAMS_LOGIN_REQUIRED/);
  assert.equal(f.calls.post.length, 0);
});

test('duplicate names in synchronized chats prevent send', async () => {
  const f = fixture({chats:[chat, {...chat, id:'19:chat-2'}]});
  await assert.rejects(f.run({execute:true, chatId:undefined, chatName:'검증 채팅'}), /AMBIGUOUS_CHAT_NAME/);
  assert.equal(f.calls.conversation.length, 0);
  assert.equal(f.calls.post.length, 0);
});

test('explicit channel IDs are rejected before send', async () => {
  const f = fixture({remote:{id:'19:channel', threadProperties:{threadType:'channel'}}});
  await assert.rejects(f.run({execute:true, chatId:'19:channel'}), /UNSUPPORTED_CHAT_TYPE/);
  assert.equal(f.calls.post.length, 0);
});

test('channel entries cannot be selected by name from the chat list', async () => {
  const f = fixture({chats:[{id:'19:channel', threadProperties:{threadType:'channel', topic:'Channel'}}]});
  await assert.rejects(f.run({execute:true, chatId:undefined, chatName:'Channel'}), /CHAT_NOT_FOUND/);
  assert.equal(f.calls.post.length, 0);
});

test('remote conversation ID mismatch cannot send', async () => {
  const f = fixture({remote:{...chat, id:'19:another-chat'}});
  await assert.rejects(f.run({execute:true}), /CHAT_ID_MISMATCH/);
  assert.equal(f.calls.post.length, 0);
});

for (const memberProperties of [{isReader:true}, {role:'Reader'}, {role:'Blocked'}, {role:'Removed'}]) {
  test(`non-writable membership ${JSON.stringify(memberProperties)} prevents send`, async () => {
    const f = fixture({remote:{...chat, memberProperties}});
    await assert.rejects(f.run({execute:true}), /CHAT_NOT_WRITABLE/);
    assert.equal(f.calls.post.length, 0);
  });
}

test('self-chat streamofnotes is a supported dry-run target', async () => {
  const selfChat = {id:'48:notes', threadProperties:{threadType:'streamofnotes'}};
  const f = fixture({chats:[selfChat], remote:selfChat});
  const result = await f.run({chatId:'48:notes'});
  assert.equal(result.status, 'DRY_RUN');
  assert.equal(result.chat.kind, 'self');
  assert.equal(f.calls.post.length, 0);
});

test('explicit verify reads a known message without POST', async () => {
  const f = fixture({stored:{id:'message-1', clientmessageid:'123', from:'8:orgid:user-1'}});
  const result = await f.run({command:'verify', messageId:'message-1'});
  assert.equal(result.status, 'PASS');
  assert.equal(result.verified, true);
  assert.deepEqual(f.calls.read, [[chat.id, 'message-1']]);
  assert.equal(f.calls.post.length, 0);
});

test('mention renders a Teams person span and matching properties.mentions', () => {
  const mri = '8:orgid:00000000-0000-4000-8000-000000000001';
  const p = buildMessage('19:x@thread.v2', '홍길동 선임님 계정 만들었어요 A20-1', {id:'u', name:'me'}, '123', 'now',
    [['A20-1', 'https://example.atlassian.net/browse/A20-1']], [['홍길동 선임님', mri]]);
  assert.equal(p.content, '<p><span itemtype="http://schema.skype.com/Mention" itemscope="" itemid="0">홍길동 선임님</span> 계정 만들었어요 <a href="https://example.atlassian.net/browse/A20-1">A20-1</a></p>');
  assert.deepEqual(JSON.parse(p.properties.mentions), [{'@type':'http://schema.skype.com/Mention', itemid:0, mri,
    mentionType:'person', displayName:'홍길동 선임님'}]);
});

test('mention label absent from text or malformed MRI fails', () => {
  assert.throws(() => buildMessage('c', 'hello', {id:'u', name:'n'}, '1', 'now', [], [['길동', '8:orgid:00000000-0000-4000-8000-000000000001']]), /INVALID_MENTION_LABEL/);
  assert.throws(() => buildMessage('c', '길동 hello', {id:'u', name:'n'}, '1', 'now', [], [['길동', 'bad']]), /INVALID_MENTION_MRI/);
});

test('messages without mentions keep an empty mentions property', () => {
  assert.equal(buildMessage('c', 'hi', {id:'u', name:'n'}, '1', 'now').properties.mentions, '[]');
});

const MRI = '8:orgid:00000000-0000-4000-8000-000000000002';
const raw = (over = {}) => ({id:'1761190000000', originalarrivaltime:'2026-10-23T01:00:00.000Z',
  imdisplayname:'홍길동(Hong Gil dong) 선임', messagetype:'RichText/Html',
  from:'https://apac.ng.msg.teams.microsoft.com/v1/users/ME/contacts/8:orgid:00000000-0000-4000-8000-000000000001',
  content:'<p><span itemtype="http://schema.skype.com/Mention" itemscope="" itemid="0">김철수</span> &#51004;&#47196; 확인 &amp; 배포<br>A20-1 &lt;b&gt;</p>',
  properties:{mentions:JSON.stringify([{itemid:0, mri:MRI, mentionType:'person'}])}, skypeguid:'secret-ish', ...over});

test('sanitizeMessage strips HTML, unescapes entities and keeps only reader fields', () => {
  assert.deepEqual(sanitizeMessage(raw()), {id:'1761190000000', time:'2026-10-23T01:00:00.000Z',
    author:'홍길동(Hong Gil dong) 선임', authorMri:'8:orgid:00000000-0000-4000-8000-000000000001',
    text:'김철수 으로 확인 & 배포\nA20-1 <b>', mentions:[MRI]});
});

test('sanitizeMessage drops system and deleted messages and tolerates malformed mentions', () => {
  assert.equal(sanitizeMessage(raw({messagetype:'ThreadActivity/AddMember'})), null);
  assert.equal(sanitizeMessage(raw({properties:{deletetime:'1'}})), null);
  assert.deepEqual(sanitizeMessage(raw({properties:{mentions:'{bad'}})).mentions, []);
  assert.equal(sanitizeMessage(raw({content:'&#0;&#xD800;&unknown;x'})).text, '&unknown;x');
});

test('messages reads an exact chat once, sanitized, with no POST or readback', async () => {
  const f = fixture({messages:{messages:[raw(), raw({messagetype:'Event/Call'})]}});
  const result = await f.run({command:'messages', chatId:chat.id, limit:'5', text:undefined});
  assert.equal(result.status, 'PASS');
  assert.equal(result.order, 'newest-first');
  assert.equal(result.messages.length, 1);
  assert.deepEqual(Object.keys(result.messages[0]).sort(), ['author', 'authorMri', 'id', 'mentions', 'text', 'time']);
  assert.equal(f.calls.messages.length, 1);
  assert.deepEqual(f.calls.messages[0][0], {conversationId:chat.id, id:chat.id});
  assert.equal(f.calls.messages[0][4], 5);
  assert.equal(f.calls.post.length, 0);
  assert.equal(f.calls.read.length, 0);
});

test('messages clamps the limit and rejects a mismatched or non-chat target', async () => {
  const f = fixture();
  await f.run({command:'messages', chatId:chat.id, limit:999});
  assert.equal(f.calls.messages[0][4], 50);
  await assert.rejects(fixture({remote:{id:'other'}}).run({command:'messages', chatId:chat.id}), /CHAT_ID_MISMATCH/);
  await assert.rejects(fixture({remote:{id:chat.id, threadProperties:{threadType:'space'}}}).run({command:'messages', chatId:chat.id}),
    /UNSUPPORTED_CHAT_TYPE/);
  await assert.rejects(fixture().run({command:'messages', chatId:undefined}), /CHAT_ID_REQUIRED/);
});
