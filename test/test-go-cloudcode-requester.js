import assert from 'node:assert/strict';
import { GoCloudCodeRequester } from '../src/utils/goCloudCodeRequester.js';

const requester = new GoCloudCodeRequester({ binaryPath: 'unused-for-unit-test' });

const textParams = requester._buildParams('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { Host: 'oauth2.googleapis.com' },
  body: 'grant_type=refresh_token'
});

assert.equal(textParams.body, 'grant_type=refresh_token');
assert.equal(textParams.bodyEncoding, 'utf8');

const bufferParams = requester._buildParams('https://play.googleapis.com/log', {
  method: 'POST',
  headers: { Host: 'play.googleapis.com' },
  body: Buffer.from([0x01, 0x02, 0x03, 0x04])
});

assert.equal(bufferParams.body, Buffer.from([0x01, 0x02, 0x03, 0x04]).toString('base64'));
assert.equal(bufferParams.bodyEncoding, 'base64');

const uint8ArrayParams = requester._buildParams('https://play.googleapis.com/log', {
  method: 'POST',
  headers: { Host: 'play.googleapis.com' },
  body: new Uint8Array([0x0a, 0x0b, 0x0c])
});

assert.equal(uint8ArrayParams.body, Buffer.from([0x0a, 0x0b, 0x0c]).toString('base64'));
assert.equal(uint8ArrayParams.bodyEncoding, 'base64');

console.log('go cloudcode requester tests passed');
