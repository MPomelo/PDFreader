import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RequestGate, selectionIdentity } from '../src/translation/client.ts';

test('the same words selected at different page positions have distinct identities', () => {
  assert.notEqual(selectionIdentity('same words', [{ page: 1, x: 0.1 }]), selectionIdentity('same words', [{ page: 2, x: 0.1 }]));
  assert.notEqual(selectionIdentity('same words', [{ page: 1, x: 0.1 }]), selectionIdentity('same words', [{ page: 1, x: 0.3 }]));
  assert.equal(selectionIdentity('', []), '');
});

test('new selections, settings and documents cancel the previous request and reject late replies', () => {
  const cancelled = [];
  const gate = new RequestGate(async id => { cancelled.push(id); });
  const first = gate.begin('first');
  assert.equal(gate.accepts(first, 'first'), true);
  const second = gate.begin('second');
  assert.deepEqual(cancelled, ['first']);
  assert.equal(gate.accepts(first, 'first'), false);
  assert.equal(gate.accepts(second, 'first'), false);
  assert.equal(gate.accepts(second, 'second'), true);
  gate.invalidate();
  assert.equal(gate.accepts(second, 'second'), false);
  assert.deepEqual(cancelled, ['first', 'second']);
});
test('a late completion cannot release or cancel a newer task', () => {
  const cancelled = [];
  const gate = new RequestGate(async id => { cancelled.push(id); });
  const first = gate.begin('one'); const second = gate.begin('two');
  gate.finish(first, 'one');
  assert.equal(gate.accepts(second, 'two'), true);
  gate.finish(second, 'two'); gate.invalidate();
  assert.deepEqual(cancelled, ['one']);
});
test('cancel transport failure still rejects the response locally', async () => {
  const gate = new RequestGate(async () => { throw Error('offline'); });
  const generation = gate.begin('old'); gate.invalidate();
  await Promise.resolve();
  assert.equal(gate.accepts(generation, 'old'), false);
});
