import {buildMessage, resolveChat, sanitizeMessage, workerOperation} from './core.mjs';

export async function workerEval(page, task, expression) {
  const pageId = (await page.cdp('Target.getTargetInfo')).targetInfo.targetId;
  const targets = (await task.cdp('Target.getTargets')).targetInfos;
  const workers = targets.filter(t => t.type === 'worker' && t.parentId === pageId &&
    t.url.startsWith('https://teams.cloud.microsoft/') && t.url.includes('precompiled-web-worker'));
  if (workers.length !== 1) throw new Error('TEAMS_WORKER_NOT_READY');
  const {sessionId} = await page.cdp('Target.attachToTarget', {targetId:workers[0].targetId, flatten:false});
  const id = Math.floor(Math.random()*1e8);
  try {
    await page.cdp('Target.sendMessageToTarget', {sessionId, message:JSON.stringify({id,
      method:'Runtime.evaluate', params:{expression, returnByValue:true, awaitPromise:true}})});
    const deadline = Date.now()+25000;
    while (Date.now() < deadline) {
      for (const event of await page.events()) {
        if (event.method !== 'Target.receivedMessageFromTarget' || event.params.sessionId !== sessionId) continue;
        const msg = JSON.parse(event.params.message);
        if (msg.id !== id) continue;
        if (msg.error || msg.result?.exceptionDetails) throw new Error('WORKER_EVALUATION_FAILED');
        return msg.result.result.value;
      }
      await new Promise(r => setTimeout(r,50));
    }
    throw new Error('WORKER_TIMEOUT');
  } finally {
    await page.cdp('Target.detachFromTarget',{sessionId}).catch(()=>{});
  }
}

// ego restarts drop task spaces, so a saved space id can disappear. connect then opens a new
// agent-owned space on the same profile (same Teams login); other commands report it as a code.
async function connectSpace(spaceId) {
  if (spaceId == null) return taskSpace('teams-native-chat');
  try { return await taskSpace(spaceId); }
  catch (e) {
    if (!/task space not found/i.test(e.message || '')) throw e;
    return taskSpace('teams-native-chat');
  }
}

export async function run(args) {
  let task, page;
  try {
    if (args.command === 'connect') {
      task = await connectSpace(args.spaceId);
      page = task.page('p1');
      const url = await page.url();
      // workerEval only attaches to the teams.cloud.microsoft worker; a page left on
      // teams.microsoft.com (e.g. after opening a deep link) never becomes ready.
      if (!url.startsWith('https://teams.cloud.microsoft/'))
        await page.goto('https://teams.cloud.microsoft/');
    } else {
      task = await taskSpace(args.spaceId);
      if (args.command === 'close') {
        await task.finish({keep:[]});
        return {status:'PASS', closed:true};
      }
      page = task.page('p1');
    }
    const expression = `(()=>{const buildMessage=${buildMessage.toString()};const resolveChat=${resolveChat.toString()};const sanitizeMessage=${sanitizeMessage.toString()};return (${workerOperation.toString()})(${JSON.stringify(args)}).catch(e=>({status:'FAIL',error: /^[A-Z][A-Z0-9_]+$/.test(e.message||'')?e.message:'TEAMS_NATIVE_REQUEST_FAILED'}));})()`;
    let result;
    const deadline = Date.now()+35000;
    do {
      try {
        result = await workerEval(page,task,expression);
        // A freshly opened Teams page exposes the worker before its chat service is wired.
        if (args.command === 'connect' && result?.error === 'TEAMS_INTERNAL_INTERFACE_CHANGED' && Date.now() < deadline) {
          await new Promise(r=>setTimeout(r,1000)); continue;
        }
        break;
      }
      catch (e) {
        if (args.command !== 'connect' || e.message !== 'TEAMS_WORKER_NOT_READY' || Date.now() >= deadline) throw e;
        await new Promise(r=>setTimeout(r,500));
      }
    } while (true);
    return {...result, spaceId:task.spaceId};
  } catch (e) {
    // A timeout after an execute request must never trigger another POST.
    const message = e.message || '';
    return {status:args.execute?'SEND_OUTCOME_UNKNOWN':'BLOCKED',
      error: /^[A-Z][A-Z0-9_]+$/.test(message)?message
        : /task space not found/i.test(message)?'TASK_SPACE_NOT_FOUND':'BROWSER_UNAVAILABLE_OR_CONTROL_REQUIRED',
      spaceId:task?.spaceId, retry:false, clientMessageId:args.clientMessageId};
  }
}
