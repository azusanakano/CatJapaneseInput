// Reproduces the two JavaScript defects reported in review-2026-11-15.md.
// These assertions describe the reviewed revision, not desired fixed behavior.
import assert from 'node:assert/strict';
import { createEditClient, createEditServer } from '../lib/edit-protocol.mjs';
import { rankCase } from '../lib/ranking.mjs';
import { evaluateCases } from '../lib/evaluate.mjs';

let time = 0;
let advanceAfterRead = false;
let writes = 0;
let commits = 0;
const binding = { clientId: 'c', serverId: 's', sessionId: '1', privacy: 'NORMAL' };
const getBinding = () => binding;
const server = createEditServer({
  getBinding,
  now: () => time,
  prepare: input => input,
  commit: () => { commits++; },
});
const transcript = [];
const client = createEditClient({
  getBinding,
  now: () => {
    const captured = time;
    if (advanceAfterRead) {
      advanceAfterRead = false;
      time = 121;
    }
    return captured;
  },
  send: (verb, message) => {
    const reply = server.receive(verb, message);
    transcript.push({ verb, prepareBy: message.prepareBy, ackBy: message.ackBy,
      time, reply: reply.status });
    return reply;
  },
  apply: () => {
    writes++;
    time = 119;
    advanceAfterRead = true;
    return 'applied';
  },
});
client.begin('x');
const steps = [client.step(), client.step(), client.step()];
assert.deepEqual(steps, ['pending', 'pending', 'recovery']);
assert.equal(writes, 1);
assert.equal(commits, 0);
assert.equal(transcript[1].ackBy, 241);
console.log(JSON.stringify({ finding: 'R01', steps, writes, commits, transcript }, null, 2));

const protectedAttributes = [
  'USER_DICTIONARY', 'NO_MODIFICATION', 'COMMAND_CANDIDATE',
  'SPELLING_CORRECTION', 'TYPING_CORRECTION',
];
for (const attribute of protectedAttributes) {
  const sample = {
    mode: 'conversion', context: '辞書登録', acceptedTexts: ['回答'],
    segments: [{ reading: 'かいとう', candidates: [
      { id: 0, value: '回答', reading: 'かいとう' },
      { id: 1, value: '辞書登録', reading: 'かいとう', attributes: [attribute] },
    ] }],
  };
  const ranked = rankCase(sample, { score: ({ candidate }) => Number(candidate.id === 1) });
  const metrics = evaluateCases([sample]).conversion;
  assert.equal(ranked.segments[0].candidates[0].id, 1);
  assert.equal(metrics.baseline.firstCorrect, 1);
  assert.equal(metrics.currentLine.harmedFirst, 1);
  console.log(JSON.stringify({ finding: 'R02', attribute, promotion: ranked.promotion,
    firstCorrectBefore: metrics.baseline.firstCorrect,
    firstCorrectAfter: metrics.currentLine.firstCorrect }));
}
