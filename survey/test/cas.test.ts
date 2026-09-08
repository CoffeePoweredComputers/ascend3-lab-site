import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseServiceResponse, safeNext } from '../src/auth/cas.js';
import type { Env } from '../src/env.js';

const env = { basePath: '/survey', BASE_URL: 'https://ascend3.cs.vt.edu/survey' } as unknown as Env;

test('parseServiceResponse reads uupid, falls back to user, lowercases', () => {
  const ok = `<cas:serviceResponse xmlns:cas="http://www.yale.edu/tp/cas">
    <cas:authenticationSuccess><cas:user>DHSMITH4</cas:user>
    <cas:attributes><cas:uupid>dhsmith4</cas:uupid><cas:eduPersonAffiliation>faculty</cas:eduPersonAffiliation></cas:attributes>
    </cas:authenticationSuccess></cas:serviceResponse>`;
  assert.equal(parseServiceResponse(ok), 'dhsmith4');
  const noAttrs = `<cas:serviceResponse><cas:authenticationSuccess><cas:user>Abc123</cas:user></cas:authenticationSuccess></cas:serviceResponse>`;
  assert.equal(parseServiceResponse(noAttrs), 'abc123');
});

test('parseServiceResponse rejects failures and junk', () => {
  assert.throws(() => parseServiceResponse(`<cas:serviceResponse><cas:authenticationFailure code="INVALID_TICKET">x</cas:authenticationFailure></cas:serviceResponse>`), /INVALID_TICKET/);
  assert.throws(() => parseServiceResponse('<html>nope</html>'), /unexpected/);
  assert.throws(() => parseServiceResponse('<cas:authenticationSuccess></cas:authenticationSuccess>'), /no usable PID/);
});

test('safeNext only allows in-app relative paths', () => {
  assert.equal(safeNext(env, undefined), '/survey/');
  assert.equal(safeNext(env, '/survey/s/irb-26-817'), '/survey/s/irb-26-817');
  assert.equal(safeNext(env, '/survey'), '/survey');
  assert.equal(safeNext(env, 'https://evil.example/'), '/survey/');
  assert.equal(safeNext(env, '//evil.example/'), '/survey/');
  assert.equal(safeNext(env, '/admin'), '/survey/');
  assert.equal(safeNext(env, '/survey/\\evil'), '/survey/');
});
