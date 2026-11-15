import assert from 'node:assert/strict';
import test from 'node:test';
import { createEditClient, createEditServer } from '../lib/edit-protocol.mjs';

function setup({ transport, apply = () => 'applied', now: suppliedNow } = {}) {
  let time = 0;
  let binding = {
    clientId: 'client', serverId: 'server', sessionId: 'session', fieldId: 'field',
    focus: 1, document: 1, reading: 1, privacy: 'NORMAL', composition: 1,
  };
  const log = [];
  const getBinding = () => binding;
  const now = suppliedNow ?? (() => time);
  const server = createEditServer({
    getBinding, now,
    prepare(input) { log.push(['prepare', input]); return { text: input }; },
    commit(plan) { log.push(['commit', plan.text]); },
  });
  const client = createEditClient({
    getBinding, now,
    apply(plan) { log.push(['apply', plan.text]); return apply(plan); },
    send(verb, message) {
      return transport ? transport(server, verb, message) : server.receive(verb, message);
    },
  });
  return {
    client, server, log, getBinding,
    setBinding(change) { binding = { ...binding, ...change }; },
    advanceTime(ms) { time += ms; },
  };
}

function finish(client) {
  for (let i = 0; i < 12; i++) {
    const status = client.step();
    if (status !== 'pending') return status;
  }
  assert.fail('Operation did not reach a terminal state');
}

for (const firstRequestArrives of ['first', 'last']) {
  test(`applies one edit when lost Prepare is retransmitted and the initial request arrives ${firstRequestArrives}`, () => {
    let initial;
    let resent = false;
    const { client, log } = setup({
      transport(server, verb, message) {
        if (verb !== 'prepare') return server.receive(verb, message);
        if (!initial) { initial = message; return undefined; }
        assert.equal(resent, false);
        resent = true;
        if (firstRequestArrives === 'first') server.receive('prepare', initial);
        const response = server.receive(verb, message);
        if (firstRequestArrives === 'last') server.receive('prepare', initial);
        assert.equal(server.receive('prepare', { ...message, input: 'other' }).status, 'rejected');
        return response;
      },
    });
    assert.equal(client.begin('あ'), 1);
    assert.equal(finish(client), 'committed');
    assert.deepEqual(log, [['prepare', 'あ'], ['apply', 'あ'], ['commit', 'あ']]);
  });
}

test('queries a stored plan and retries lost Ack with no repeated write or commit', () => {
  let ackAttempts = 0;
  const { client, log } = setup({
    transport(server, verb, message) {
      if (verb === 'prepare') { server.receive(verb, message); return undefined; }
      if (verb === 'ack' && ++ackAttempts <= 2) {
        if (ackAttempts === 2) server.receive(verb, message);
        return undefined;
      }
      return server.receive(verb, message);
    },
  });
  client.begin('い');
  assert.equal(client.step(), 'pending');
  assert.deepEqual(log, [['prepare', 'い']]);
  assert.throws(() => client.begin('other'));
  assert.equal(client.step(), 'pending');
  assert.equal(client.step(), 'pending');
  assert.deepEqual(log, [['prepare', 'い'], ['apply', 'い']]);
  assert.equal(finish(client), 'committed');
  assert.equal(ackAttempts, 3);
  assert.deepEqual(log, [['prepare', 'い'], ['apply', 'い'], ['commit', 'い']]);
  assert.equal(client.begin('次'), 2);
});

test('queries before retrying after the transport throws while delivering Prepare', () => {
  const verbs = [];
  const { client, log } = setup({
    transport(server, verb, message) {
      verbs.push(verb);
      if (verb === 'prepare' && verbs.length === 1) {
        server.receive(verb, message);
        throw new Error('response failed');
      }
      return server.receive(verb, message);
    },
  });
  client.begin('入力');
  assert.equal(finish(client), 'committed');
  assert.deepEqual(verbs, ['prepare', 'query', 'ack']);
  assert.deepEqual(log, [['prepare', '入力'], ['apply', '入力'], ['commit', '入力']]);
});

test('cancel of a not-yet-received request blocks late Prepare with the same sequence', () => {
  const { server, log, getBinding } = setup();
  const request = { sequence: 1, binding: getBinding(), input: '古い', prepareBy: 120 };
  assert.equal(server.receive('query', request).status, 'not-received');
  assert.equal(server.receive('cancel', request).status, 'cancelled');
  assert.equal(server.receive('prepare', request).status, 'rejected');
  assert.equal(server.receive('prepare', { ...request, sequence: 3 }).status, 'rejected');
  assert.deepEqual(log, []);
  assert.equal(server.receive('prepare', { ...request, sequence: 2 }).status, 'prepared');
});

test('scope or startup changes after Prepare prevent Apply and Ack', () => {
  for (const change of [{ focus: 2 }, { document: 2 }, { privacy: 'PASSWORD' }, { serverId: 'new-server' }]) {
    const { client, server, log, getBinding, setBinding } = setup();
    const oldBinding = getBinding();
    client.begin('古い');
    assert.equal(client.step(), 'pending');
    setBinding(change);
    assert.equal(client.step(), 'recovery');
    assert.equal(server.receive('ack', { sequence: 1, binding: oldBinding, ackBy: 120 }).status, 'rejected');
    assert.deepEqual(log, [['prepare', '古い']]);
  }
});

test('a scope change after a successful host write preserves the write and prevents an old Ack', () => {
  let document = '';
  const { client, log, setBinding } = setup({
    apply(plan) { document += plan.text; return 'applied'; },
  });
  client.begin('反映済み');
  assert.equal(client.step(), 'pending');
  assert.equal(client.step(), 'pending');
  setBinding({ privacy: 'PRIVATE' });
  assert.equal(client.step(), 'recovery');
  assert.equal(document, '反映済み');
  assert.deepEqual(log, [['prepare', '反映済み'], ['apply', '反映済み']]);
});

test('an unchanged write can cancel; indeterminate write requires recovery without commit', () => {
  let document = '';
  const { client, log } = setup({
    apply(plan) {
      if (plan.text === '不変') return 'unchanged';
      document += plan.text[0];
      return 'indeterminate';
    },
  });
  client.begin('不変');
  assert.equal(finish(client), 'cancelled');
  assert.equal(document, '');
  assert.equal(client.begin('部分'), 2);
  assert.equal(finish(client), 'recovery');
  assert.throws(() => client.begin('次'));
  assert.equal(document, '部');
  assert.deepEqual(log, [['prepare', '不変'], ['apply', '不変'], ['prepare', '部分'], ['apply', '部分']]);
});

test('an expired Prepare cannot write, and an expired Ack cannot learn or replay the write', () => {
  const beforeApply = setup();
  beforeApply.client.begin('未反映');
  assert.equal(beforeApply.client.step(), 'pending');
  beforeApply.advanceTime(120);
  assert.equal(beforeApply.client.step(), 'recovery');
  assert.deepEqual(beforeApply.log, [['prepare', '未反映']]);

  const beforeAck = setup();
  beforeAck.client.begin('反映済み');
  assert.equal(beforeAck.client.step(), 'pending');
  assert.equal(beforeAck.client.step(), 'pending');
  beforeAck.advanceTime(120);
  assert.equal(beforeAck.client.step(), 'recovery');
  assert.deepEqual(beforeAck.log, [['prepare', '反映済み'], ['apply', '反映済み']]);
});

test('an Apply completed before the deadline can commit when time advances after the completion check', () => {
  let time = 0;
  let ackBy;
  const { client, log } = setup({
    now() {
      const current = time;
      // Model a scheduling pause after sampling the successful Apply at 119 ms.
      if (current === 119) time = 121;
      return current;
    },
    apply() { time = 119; return 'applied'; },
    transport(server, verb, message) {
      if (verb === 'ack') ackBy = message.ackBy;
      return server.receive(verb, message);
    },
  });
  client.begin('期限直前');
  assert.equal(client.step(), 'pending');
  assert.equal(client.step(), 'pending');
  assert.equal(finish(client), 'committed');
  assert.equal(ackBy, 239);
  assert.deepEqual(log, [['prepare', '期限直前'], ['apply', '期限直前'], ['commit', '期限直前']]);
  assert.equal(client.begin('次'), 2);
});

test('an Apply completed at or after its deadline requires recovery without commit', () => {
  for (const completedAt of [120, 121]) {
    const { client, log, advanceTime } = setup({
      apply() { advanceTime(completedAt); return 'applied'; },
    });
    client.begin('期限超過');
    assert.equal(client.step(), 'pending');
    assert.equal(client.step(), 'recovery');
    assert.deepEqual(log, [['prepare', '期限超過'], ['apply', '期限超過']]);
    assert.throws(() => client.begin('次'));
  }
});

test('a composition change during Apply requires recovery even when it finishes before the deadline', () => {
  const { client, log, advanceTime, setBinding } = setup({
    apply() {
      advanceTime(119);
      setBinding({ composition: 2 });
      return 'applied';
    },
  });
  client.begin('旧範囲');
  assert.equal(client.step(), 'pending');
  assert.equal(client.step(), 'recovery');
  assert.deepEqual(log, [['prepare', '旧範囲'], ['apply', '旧範囲']]);
  assert.throws(() => client.begin('次'));
});
