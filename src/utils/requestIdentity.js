import { randomUUID } from 'crypto';
import { generateSessionId } from './idGenerator.js';

function defineRuntimeState(target, key, value) {
  if (!Object.prototype.hasOwnProperty.call(target, key)) {
    Object.defineProperty(target, key, {
      value,
      writable: true,
      configurable: true,
      enumerable: false
    });
  }
  return target[key];
}

function ensureCloudCodeSessionId(token, preferredSessionId = null) {
  if (!token || typeof token !== 'object') {
    return preferredSessionId || generateSessionId();
  }

  if (preferredSessionId && token.sessionId !== preferredSessionId) {
    token.sessionId = preferredSessionId;
  }

  if (!token.sessionId) {
    token.sessionId = generateSessionId();
  }

  return token.sessionId;
}

export function buildAgentRequestIdentity(token, preferredSessionId = null) {
  const sessionId = ensureCloudCodeSessionId(token, preferredSessionId);
  const target = token && typeof token === 'object' ? token : {};
  const conversationId = defineRuntimeState(target, '__cloudCodeConversationId', randomUUID());
  const currentSeq = defineRuntimeState(target, '__cloudCodeRequestSeq', 0) + 1;
  target.__cloudCodeRequestSeq = currentSeq;

  return {
    sessionId,
    trajectoryId: conversationId,
    sequence: currentSeq,
    requestId: `agent/${Date.now()}/${conversationId}/${currentSeq}`
  };
}

export function clearRequestIdentityState(token) {
  if (!token || typeof token !== 'object') return;
  delete token.__cloudCodeConversationId;
  delete token.__cloudCodeRequestSeq;
}
