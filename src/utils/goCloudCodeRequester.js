import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import logger from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GO_WORKER_DIR = path.join(__dirname, '..', 'go', 'cloudcode_bridge');

function getWorkerBinaryName() {
  const platformMap = {
    win32: 'windows',
    linux: 'linux',
    darwin: 'darwin'
  };
  const archMap = {
    x64: 'amd64',
    arm64: 'arm64'
  };
  const platformName = platformMap[process.platform];
  const archName = archMap[process.arch];
  if (!platformName || !archName) {
    throw new Error(`Unsupported Go worker platform: ${process.platform} ${process.arch}`);
  }
  const ext = process.platform === 'win32' ? '.exe' : '';
  return `cloudcode_go_worker_${platformName}_${archName}${ext}`;
}

function fileMTimeSafe(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class GoStreamResponse {
  constructor() {
    this._status = null;
    this._headers = {};
    this._started = false;
    this._ended = false;
    this._error = null;
    this._queuedChunks = [];
    this._onStart = null;
    this._onData = null;
    this._onEnd = null;
    this._onError = null;
  }

  get status() {
    return this._status;
  }

  onStart(callback) {
    this._onStart = callback;
    if (this._started) {
      callback({ status: this._status, headers: this._headers });
    }
    return this;
  }

  onData(callback) {
    this._onData = callback;
    if (this._queuedChunks.length > 0) {
      for (const chunk of this._queuedChunks) {
        callback(chunk);
      }
      this._queuedChunks = [];
    }
    return this;
  }

  onEnd(callback) {
    this._onEnd = callback;
    if (this._ended && !this._error) {
      callback();
    }
    return this;
  }

  onError(callback) {
    this._onError = callback;
    if (this._error) {
      callback(this._error);
    }
    return this;
  }

  _handleStart(status, headers) {
    this._status = status;
    this._headers = headers || {};
    this._started = true;
    if (this._onStart) {
      this._onStart({ status, headers: this._headers });
    }
  }

  _handleData(chunk) {
    if (this._onData) {
      this._onData(chunk);
      return;
    }
    this._queuedChunks.push(chunk);
  }

  _handleEnd() {
    this._ended = true;
    if (this._onEnd) {
      this._onEnd();
    }
  }

  _handleError(error) {
    this._error = error;
    if (this._onError) {
      this._onError(error);
    }
  }
}

export class GoCloudCodeRequester {
  constructor(options = {}) {
    this.timeoutMs = options.timeoutMs || 300000;
    this.proxy = options.proxy || null;
    this.child = null;
    this.buffer = '';
    this.pending = new Map();
    this.requestSeq = 0;
    this.initPromise = null;
    this.binaryPath = options.binaryPath || this._resolveBinaryPath();
  }

  _resolveBinaryPath() {
    const binaryName = getWorkerBinaryName();
    if (typeof process.pkg !== 'undefined') {
      return path.join(path.dirname(process.execPath), 'bin', binaryName);
    }
    return path.join(os.tmpdir(), 'antigravity-go-worker', `${process.platform}-${process.arch}`, binaryName);
  }

  _getSourceFiles() {
    return [
      path.join(GO_WORKER_DIR, 'go.mod'),
      path.join(GO_WORKER_DIR, 'go.sum'),
      path.join(GO_WORKER_DIR, 'main.go'),
    ];
  }

  _isBundledBinaryAvailable() {
    return fs.existsSync(this.binaryPath);
  }

  _needsBuild() {
    if (!this._isBundledBinaryAvailable()) {
      return true;
    }
    const binaryMTime = fileMTimeSafe(this.binaryPath);
    const sourceMTime = Math.max(...this._getSourceFiles().map(fileMTimeSafe));
    return binaryMTime < sourceMTime;
  }

  _execFile(command, args, options = {}) {
    return new Promise((resolve, reject) => {
      execFile(command, args, options, (error, stdout, stderr) => {
        if (error) {
          const message = (stderr || stdout || error.message || '').trim();
          reject(new Error(message || `Command failed: ${command}`));
          return;
        }
        resolve({ stdout, stderr });
      });
    });
  }

  async _prepareBinary() {
    if (typeof process.pkg !== 'undefined') {
      if (!this._isBundledBinaryAvailable()) {
        throw new Error(`未找到打包后的 Go worker: ${this.binaryPath}`);
      }
      return;
    }

    if (!this._needsBuild()) {
      return;
    }

    fs.mkdirSync(path.dirname(this.binaryPath), { recursive: true });
    await this._execFile('go', ['build', '-o', this.binaryPath, '.'], {
      cwd: GO_WORKER_DIR,
      env: process.env,
      windowsHide: true,
    });
  }

  async _startChild() {
    const ready = createDeferred();
    const child = spawn(this.binaryPath, [], {
      cwd: path.dirname(this.binaryPath),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (chunk) => {
      this.buffer += chunk;
      let newlineIndex = this.buffer.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = this.buffer.slice(0, newlineIndex).trim();
        this.buffer = this.buffer.slice(newlineIndex + 1);
        if (line) {
          this._handleMessageLine(line, ready);
        }
        newlineIndex = this.buffer.indexOf('\n');
      }
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.trim();
      if (text) {
        logger.debug(`[GoCloudCodeRequester] ${text}`);
      }
    });

    child.on('error', (error) => {
      if (this.child === child) {
        this.child = null;
        this.initPromise = null;
      }
      ready.reject(error);
      this._rejectPending(error);
    });

    child.on('exit', (code, signal) => {
      if (this.child === child) {
        this.child = null;
        this.initPromise = null;
      }
      const error = new Error(`Go Cloud Code worker exited: code=${code ?? 'null'} signal=${signal ?? 'null'}`);
      ready.reject(error);
      this._rejectPending(error);
    });

    this.child = child;
    await ready.promise;
  }

  _handleMessageLine(line, ready) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }

    if (message.type === 'ready') {
      ready.resolve();
      return;
    }

    const entry = this.pending.get(message.id);
    if (!entry) {
      return;
    }

    if (message.type === 'response') {
      this.pending.delete(message.id);
      entry.resolve({
        status: message.status,
        headers: message.headers || {},
        body: message.body || '',
      });
      return;
    }

    if (message.type === 'stream-start') {
      entry.stream._handleStart(message.status, message.headers || {});
      return;
    }

    if (message.type === 'stream-data') {
      entry.stream._handleData(message.chunk || '');
      return;
    }

    if (message.type === 'stream-end') {
      this.pending.delete(message.id);
      entry.stream._handleEnd();
      return;
    }

    if (message.type === 'error') {
      this.pending.delete(message.id);
      const error = new Error(message.message || 'Go worker request failed');
      error.status = message.status;
      if (entry.stream) {
        entry.stream._handleError(error);
      } else {
        entry.reject(error);
      }
    }
  }

  _rejectPending(error) {
    for (const [id, entry] of this.pending.entries()) {
      this.pending.delete(id);
      if (entry.stream) {
        entry.stream._handleError(error);
      } else {
        entry.reject(error);
      }
    }
  }

  async init() {
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = (async () => {
      await this._prepareBinary();
      await this._startChild();
      logger.info('[GoCloudCodeRequester] Go HTTP/2 Cloud Code worker 已就绪');
    })();

    try {
      await this.initPromise;
    } catch (error) {
      this.initPromise = null;
      throw error;
    }
  }

  _sendMessage(message) {
    if (!this.child?.stdin || this.child.killed) {
      throw new Error('Go Cloud Code worker 未运行');
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  _buildParams(url, options = {}) {
    const method = options.method || 'POST';
    const headers = options.headers || {};
    let body = '';
    let bodyEncoding = 'utf8';
    if (options.body !== null && options.body !== undefined) {
      if (Buffer.isBuffer(options.body)) {
        body = options.body.toString('base64');
        bodyEncoding = 'base64';
      } else if (options.body instanceof Uint8Array) {
        body = Buffer.from(options.body).toString('base64');
        bodyEncoding = 'base64';
      } else {
        body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
      }
    }
    return {
      url,
      method,
      headers,
      body,
      bodyEncoding,
      timeoutMs: options.timeout_ms || this.timeoutMs,
      proxy: options.proxy || this.proxy || '',
    };
  }

  async antigravity_fetch(url, options = {}) {
    await this.init();
    const id = `req-${++this.requestSeq}`;
    const params = this._buildParams(url, options);

    const result = await new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this._sendMessage({ id, method: 'request', params });
    });

    return {
      ok: result.status >= 200 && result.status < 300,
      status: result.status,
      statusText: '',
      headers: new Map(Object.entries(result.headers || {})),
      url,
      redirected: false,
      _data: result.body || '',
      async text() {
        return this._data;
      },
      async json() {
        return JSON.parse(this._data || '{}');
      },
      async buffer() {
        return Buffer.from(this._data || '', 'utf8');
      }
    };
  }

  async antigravity_fetchStream(url, options = {}) {
    await this.init();
    const id = `stream-${++this.requestSeq}`;
    const params = this._buildParams(url, options);
    const stream = new GoStreamResponse();
    this.pending.set(id, { stream });
    this._sendMessage({ id, method: 'stream', params });
    return stream;
  }

  close() {
    if (this.child) {
      try {
        this.child.kill();
      } catch {
        // ignore
      }
    }
    this.child = null;
    this.initPromise = null;
  }
}

export function createGoCloudCodeRequester(options) {
  return new GoCloudCodeRequester(options);
}

export default {
  create: createGoCloudCodeRequester,
  GoCloudCodeRequester,
};
