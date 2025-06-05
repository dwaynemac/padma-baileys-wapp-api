import test from 'node:test';
import assert from 'node:assert/strict';
import { sessions, getActiveSessions, deleteSession, normalizeJid } from '../src/helpers.js';
import { redisClient } from '../src/use_redis_auth_state.js';

test('normalizeJid removes device part', () => {
  assert.equal(normalizeJid('12345:2@s.whatsapp.net'), '12345@s.whatsapp.net');
});

test('getActiveSessions returns active session ids', () => {
  sessions.clear();
  sessions.set('a', {});
  sessions.set('b', {});
  const ids = getActiveSessions().sort();
  assert.deepEqual(ids, ['a', 'b']);
  sessions.clear();
});

test('deleteSession removes from map and redis', async () => {
  sessions.set('x', {});
  await redisClient.hSet('x', 'creds', 'secret');
  await deleteSession('x');
  assert.equal(sessions.has('x'), false);
  const val = await redisClient.hGet('x', 'creds');
  assert.equal(val, null);
});
