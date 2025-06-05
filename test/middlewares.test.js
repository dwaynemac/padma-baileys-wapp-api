import test from 'node:test';
import assert from 'node:assert/strict';
import { requireSession, apiKeyAuth, requestLogger } from '../src/middlewares.js';
import { sessions } from '../src/helpers.js';

function mockRes() {
  const res = {};
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (obj) => { res.body = obj; return res; };
  return res;
}

test('requireSession returns 404 when session missing', () => {
  const req = { params: { sessionId: 'absent' } };
  const res = mockRes();
  let called = false;
  requireSession(req, res, () => { called = true; });
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { error: 'Session not found' });
  assert.equal(called, false);
});

test('requireSession attaches session and calls next', () => {
  const req = { params: { sessionId: 'sid' } };
  const sessionData = { foo: 'bar' };
  sessions.set('sid', sessionData);
  const res = mockRes();
  let called = false;
  requireSession(req, res, () => { called = true; });
  assert.equal(called, true);
  assert.equal(req.session, sessionData);
  sessions.clear();
});

test('apiKeyAuth rejects invalid keys', () => {
  const mw = apiKeyAuth('secret');
  const req = { headers: { 'x-api-key': 'bad' } };
  const res = mockRes();
  let called = false;
  mw(req, res, () => { called = true; });
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { error: 'Api key not found or invalid' });
  assert.equal(called, false);
});

test('apiKeyAuth allows valid key', () => {
  const mw = apiKeyAuth('secret');
  const req = { headers: { 'x-api-key': 'secret' } };
  const res = mockRes();
  let called = false;
  mw(req, res, () => { called = true; });
  assert.equal(called, true);
});

test('requestLogger calls next without modifying res', () => {
  const req = { method: 'GET', url: '/path', query: {}, ip: '::1' };
  const res = mockRes();
  let called = false;
  requestLogger(req, res, () => { called = true; });
  assert.equal(called, true);
});
