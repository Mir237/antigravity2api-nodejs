import assert from 'node:assert/strict';
import { buildAgentRequestIdentity, clearRequestIdentityState } from '../src/utils/requestIdentity.js';
import { buildAuthorizedHeaders } from '../src/utils/googleAuth.js';
import { generateRequestBody } from '../src/utils/converters/openai.js';

function testRequestIdentityReusesSessionAndIncrementsSequence() {
  const token = {
    access_token: 'access-a',
    refresh_token: 'refresh-a',
    projectId: 'project-a',
    sessionId: 'stable-session-a'
  };

  clearRequestIdentityState(token);

  const first = buildAgentRequestIdentity(token);
  const second = buildAgentRequestIdentity(token);

  assert.equal(first.sessionId, 'stable-session-a');
  assert.equal(second.sessionId, 'stable-session-a');
  assert.equal(first.requestId.split('/')[0], 'agent');
  assert.equal(first.requestId.split('/')[2], second.requestId.split('/')[2]);
  assert.equal(first.requestId.split('/')[3], '1');
  assert.equal(second.requestId.split('/')[3], '2');
}

function testRequestIdentityGeneratesMissingSessionId() {
  const token = {
    access_token: 'access-b',
    refresh_token: 'refresh-b',
    projectId: 'project-b'
  };

  clearRequestIdentityState(token);

  const first = buildAgentRequestIdentity(token);
  const second = buildAgentRequestIdentity(token);

  assert.ok(token.sessionId);
  assert.equal(first.sessionId, token.sessionId);
  assert.equal(second.sessionId, token.sessionId);
}

function testOpenAIConverterUsesStableSessionAndSequentialRequestIds() {
  const token = {
    access_token: 'access-c',
    refresh_token: 'refresh-c',
    projectId: 'project-c',
    sessionId: 'stable-session-c'
  };

  clearRequestIdentityState(token);

  const requestOne = generateRequestBody(
    [{ role: 'user', content: 'hello' }],
    'gemini-2.5-pro',
    {},
    [],
    token
  );
  const requestTwo = generateRequestBody(
    [{ role: 'user', content: 'hello again' }],
    'gemini-2.5-pro',
    {},
    [],
    token
  );

  assert.equal(requestOne.request.sessionId, 'stable-session-c');
  assert.equal(requestTwo.request.sessionId, 'stable-session-c');
  assert.equal(requestOne.requestId.split('/')[2], requestTwo.requestId.split('/')[2]);
  assert.equal(requestOne.requestId.split('/')[3], '1');
  assert.equal(requestTwo.requestId.split('/')[3], '2');
}

function testAuthorizedHeadersDoNotIncludeQuotaProjectWhenPresent() {
  const headers = buildAuthorizedHeaders(
    {
      access_token: 'access-d',
      quotaProjectId: 'billing-project-123'
    },
    {
      host: 'example.googleapis.com',
      userAgent: 'antigravity-test',
      transferEncoding: 'chunked'
    }
  );

  assert.equal(headers.Host, 'example.googleapis.com');
  assert.equal(headers['User-Agent'], 'antigravity-test');
  assert.ok(!Object.prototype.hasOwnProperty.call(headers, 'x-goog-user-project'));
  assert.equal(headers['Transfer-Encoding'], 'chunked');
}

function testAuthorizedHeadersDoNotFallbackToProjectId() {
  const headers = buildAuthorizedHeaders(
    {
      access_token: 'access-f',
      projectId: 'cloud-code-project-456'
    },
    { host: 'example.googleapis.com' }
  );

  assert.ok(!Object.prototype.hasOwnProperty.call(headers, 'x-goog-user-project'));
}

function testAuthorizedHeadersOmitQuotaProjectWhenAbsent() {
  const headers = buildAuthorizedHeaders(
    { access_token: 'access-e' },
    { host: 'example.googleapis.com' }
  );

  assert.ok(!Object.prototype.hasOwnProperty.call(headers, 'x-goog-user-project'));
}

testRequestIdentityReusesSessionAndIncrementsSequence();
testRequestIdentityGeneratesMissingSessionId();
testOpenAIConverterUsesStableSessionAndSequentialRequestIds();
testAuthorizedHeadersDoNotIncludeQuotaProjectWhenPresent();
testAuthorizedHeadersDoNotFallbackToProjectId();
testAuthorizedHeadersOmitQuotaProjectWhenAbsent();

console.log('request identity tests passed');
