import assert from 'node:assert/strict';
import { isCloudCodeHost, isCloudCodeUrl } from '../src/utils/cloudCodeTransport.js';

assert.equal(isCloudCodeHost('cloudcode-pa.googleapis.com'), true);
assert.equal(isCloudCodeHost('daily-cloudcode-pa.googleapis.com'), true);
assert.equal(isCloudCodeHost('daily-cloudcode-pa.sandbox.googleapis.com'), true);
assert.equal(isCloudCodeHost('play.googleapis.com'), false);

assert.equal(isCloudCodeUrl('https://cloudcode-pa.googleapis.com/v1internal:generateContent'), true);
assert.equal(isCloudCodeUrl('https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse'), true);
assert.equal(isCloudCodeUrl('https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:fetchAvailableModels'), true);
assert.equal(isCloudCodeUrl('https://antigravity-unleash.goog/api/client/register'), false);
assert.equal(isCloudCodeUrl('not-a-url'), false);

console.log('cloud code routing tests passed');
