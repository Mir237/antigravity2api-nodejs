import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfiguredCloudCodeRouteProfile, getConfiguredRouteProfile, getTlsConfigFilenameForUrl } from '../src/utils/requesterManager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const binDir = path.join(__dirname, '..', 'src', 'bin');

const generalConfig = JSON.parse(fs.readFileSync(path.join(binDir, 'tls_config.json'), 'utf8'));
const cloudCodeConfig = JSON.parse(fs.readFileSync(path.join(binDir, 'cloudcode_tls_config.json'), 'utf8'));

assert.equal(getTlsConfigFilenameForUrl('https://oauth2.googleapis.com/token'), 'tls_config.json');
assert.equal(getTlsConfigFilenameForUrl('https://cloudcode-pa.googleapis.com/v1internal:generateContent'), 'cloudcode_tls_config.json');
assert.equal(getTlsConfigFilenameForUrl('https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse'), 'cloudcode_tls_config.json');
assert.equal(getConfiguredCloudCodeRouteProfile('https://oauth2.googleapis.com/token', 'go'), 'general');
assert.equal(getConfiguredCloudCodeRouteProfile('https://cloudcode-pa.googleapis.com/v1internal:generateContent', 'fingerprint'), 'cloudcode');
assert.equal(getConfiguredCloudCodeRouteProfile('https://cloudcode-pa.googleapis.com/v1internal:generateContent', 'go'), 'cloudcode-go');
assert.equal(getConfiguredRouteProfile('https://oauth2.googleapis.com/token', 'fingerprint'), 'general');
assert.equal(getConfiguredRouteProfile('https://oauth2.googleapis.com/token', 'go'), 'google-go');
assert.equal(getConfiguredRouteProfile('https://www.googleapis.com/oauth2/v2/userinfo', 'go'), 'google-go');
assert.equal(getConfiguredRouteProfile('https://play.googleapis.com/log', 'go'), 'google-go');
assert.equal(getConfiguredRouteProfile('https://antigravity-unleash.goog/api/client/register', 'go'), 'general');

assert.equal(generalConfig.fingerprint.http2, false);
assert.equal(cloudCodeConfig.fingerprint.http2, true);

console.log('requester routing tests passed');
