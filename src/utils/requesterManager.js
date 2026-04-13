import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import axios from 'axios';
import fingerprintRequester from '../requester.js';
import goCloudCodeRequester from './goCloudCodeRequester.js';
import config from '../config/config.js';
import logger from './logger.js';
import { isCloudCodeUrl } from './cloudCodeTransport.js';
import { buildAxiosRequestConfig } from './httpClient.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 统一请求器管理类
 *
 * - 根据 config.useNativeAxios 决定使用 TLS 指纹请求器还是 axios
 * - 支持热重载：调用 reload() 后下次请求时重新初始化
 * - TLS 请求器初始化失败时自动降级到 axios
 * - Google 请求在 go 模式下优先统一进入 Go worker；TLS 指纹链仅作 fallback
 * - 指纹请求器仍不支持二进制 body，这类请求会在 TLS fallback 时继续降级到 axios
 */
class RequesterManager {
  constructor() {
    this._tlsRequester = null;
    this._cloudCodeTlsRequester = null;
    this._goCloudCodeRequester = null;
    this._generalTlsInitFailed = false;
    this._cloudCodeTlsInitFailed = false;
    this._goCloudCodeInitFailed = false;
    this._initPromise = null;
  }

  // ==================== 初始化 ====================

  _ensureInit() {
    if (this._initPromise) return this._initPromise;
    this._initPromise = this._doInit();
    return this._initPromise;
  }

  async _doInit() {
    if (config.useNativeAxios === true) {
      this._generalTlsInitFailed = true;
      this._cloudCodeTlsInitFailed = true;
      this._goCloudCodeInitFailed = true;
      logger.info('[RequesterManager] 使用原生 axios 请求');
      return;
    }

    await this._initGeneralTlsRequester();
    await this._initCloudCodeTlsRequester();
    await this._initGoCloudCodeRequester();
  }

  _getConfigPath(filename) {
    const isPkg = typeof process.pkg !== 'undefined';
    return isPkg
      ? path.join(path.dirname(process.execPath), 'bin', filename)
      : path.join(__dirname, '..', 'bin', filename);
  }

  _createFingerprintRequester(configFilename) {
    return fingerprintRequester.create({
      configPath: this._getConfigPath(configFilename),
      timeout: config.timeout ? Math.ceil(config.timeout / 1000) : 30,
      proxy: config.proxy || null,
    });
  }

  async _initGeneralTlsRequester() {
    try {
      const requester = this._createFingerprintRequester('tls_config.json');
      await this._probeBinary(requester.binaryPath);
      this._tlsRequester = requester;
      logger.info('[RequesterManager] 使用 FingerprintRequester（通用 TLS 指纹）请求');
    } catch (error) {
      logger.warn('[RequesterManager] 通用 FingerprintRequester 初始化失败，自动降级使用 axios:', error.message);
      this._generalTlsInitFailed = true;
    }
  }

  async _initCloudCodeTlsRequester() {
    try {
      const requester = this._createFingerprintRequester('cloudcode_tls_config.json');
      await this._probeBinary(requester.binaryPath);
      this._cloudCodeTlsRequester = requester;
      logger.info('[RequesterManager] 使用 FingerprintRequester（Cloud Code TLS 指纹）请求');
    } catch (error) {
      logger.warn('[RequesterManager] Cloud Code FingerprintRequester 初始化失败，将回退到通用 TLS 指纹或 axios:', error.message);
      this._cloudCodeTlsInitFailed = true;
    }
  }

  async _initGoCloudCodeRequester() {
    if (config.cloudCodeTransport !== 'go') {
      return;
    }

    try {
      const requester = goCloudCodeRequester.create({
        timeoutMs: config.timeout,
        proxy: config.proxy || null,
      });
      await requester.init();
      this._goCloudCodeRequester = requester;
      logger.info('[RequesterManager] 使用 Go Google HTTP/2 请求');
    } catch (error) {
      logger.warn('[RequesterManager] Go Google HTTP/2 初始化失败，将回退到指纹请求器:', error.message);
      this._goCloudCodeInitFailed = true;
    }
  }

  /**
   * 主动 spawn 二进制文件做可执行性探测，立即关闭进程
   * 若 spawn 失败（UNKNOWN / ENOENT 等）则抛出错误，触发降级
   */
  _probeBinary(binaryPath) {
    return new Promise((resolve, reject) => {
      const proc = spawn(binaryPath);
      proc.on('error', (err) => {
        reject(new Error(`二进制文件无法执行: ${err.message}`));
      });
      // 进程成功启动后立即关闭，不需要等待它完成
      proc.on('spawn', () => {
        proc.kill();
        resolve();
      });
      // 兼容旧版 Node（无 'spawn' 事件）：stdout 有数据也说明进程已启动
      proc.stdout.once('data', () => {
        proc.kill();
        resolve();
      });
      proc.stdin.end();
    });
  }

  get _useAxios() {
    return this._generalTlsInitFailed || !this._tlsRequester;
  }

  _isGoogleApiUrl(url) {
    if (!url || typeof url !== 'string') {
      return false;
    }
    try {
      const hostname = new URL(url).hostname.toLowerCase();
      return hostname === 'googleapis.com' || hostname.endsWith('.googleapis.com');
    } catch {
      return false;
    }
  }

  _getPreferredCloudCodeProfile() {
    return config.cloudCodeTransport === 'go' ? 'cloudcode-go' : 'cloudcode';
  }

  _getRoute(url) {
    const isCloudCodeRequest = isCloudCodeUrl(url);
    const isGoogleApiRequest = this._isGoogleApiUrl(url);

    if (isCloudCodeRequest && config.cloudCodeTransport === 'go' && this._goCloudCodeRequester) {
      return { isCloudCodeRequest, isGoogleApiRequest, requester: this._goCloudCodeRequester, profile: 'cloudcode-go', kind: 'go' };
    }

    if (!isCloudCodeRequest && isGoogleApiRequest && config.cloudCodeTransport === 'go' && this._goCloudCodeRequester) {
      return { isCloudCodeRequest, isGoogleApiRequest, requester: this._goCloudCodeRequester, profile: 'google-go', kind: 'go' };
    }

    if (isCloudCodeRequest && this._cloudCodeTlsRequester) {
      return { isCloudCodeRequest, isGoogleApiRequest, requester: this._cloudCodeTlsRequester, profile: 'cloudcode', kind: 'tls' };
    }

    if (this._tlsRequester) {
      return { isCloudCodeRequest, isGoogleApiRequest, requester: this._tlsRequester, profile: 'general', kind: 'tls' };
    }

    return { isCloudCodeRequest, isGoogleApiRequest, requester: null, profile: 'axios', kind: 'axios' };
  }

  _getHostForLog(url) {
    try {
      return new URL(url).host;
    } catch {
      return 'invalid-url';
    }
  }

  _logRouteSelection(url, profile, isStream) {
    const host = this._getHostForLog(url);
    const mode = isStream ? 'stream' : 'request';
    const transport = profile === 'axios' ? 'axios' : (profile === 'cloudcode-go' || profile === 'google-go') ? 'go-http2' : 'tls';
    logger.info(`[RequesterManager] ${mode} route=${profile} transport=${transport} host=${host}`);
  }

  /**
   * 热重载：重置请求器，下次请求时按最新 config 重新初始化
   */
  reload() {
    if (this._tlsRequester) {
      try { this._tlsRequester.close(); } catch { /* ignore */ }
    }
    if (this._cloudCodeTlsRequester) {
      try { this._cloudCodeTlsRequester.close(); } catch { /* ignore */ }
    }
    if (this._goCloudCodeRequester) {
      try { this._goCloudCodeRequester.close(); } catch { /* ignore */ }
    }
    this._tlsRequester = null;
    this._cloudCodeTlsRequester = null;
    this._goCloudCodeRequester = null;
    this._generalTlsInitFailed = false;
    this._cloudCodeTlsInitFailed = false;
    this._goCloudCodeInitFailed = false;
    this._initPromise = null;
    logger.info('[RequesterManager] 请求器已重置，将在下次请求时按新配置重新初始化');
  }

  /**
   * 关闭所有活跃进程（进程退出时调用）
   */
  close() {
    if (this._tlsRequester) {
      try { this._tlsRequester.close(); } catch { /* ignore */ }
    }
    if (this._cloudCodeTlsRequester) {
      try { this._cloudCodeTlsRequester.close(); } catch { /* ignore */ }
    }
    if (this._goCloudCodeRequester) {
      try { this._goCloudCodeRequester.close(); } catch { /* ignore */ }
    }
  }

  // ==================== 核心请求方法 ====================

  /**
   * 发送普通 JSON 请求（非流式）
   *
   * @param {string} url
   * @param {object} options
   * @param {string}  [options.method='POST']
   * @param {object}  [options.headers={}]
   * @param {*}       [options.body=null]  - JSON 对象、字符串或二进制 body
   * @param {number[]} [options.okStatus]  - 认为成功的状态码列表，默认 [200]
   * @returns {Promise<{ status: number, data: any }>}
   *   data 为解析后的 JSON 对象（axios 路径）或原始文本（解析失败时）
   */
  async fetch(url, { method = 'POST', headers = {}, body = null, okStatus = [200] } = {}) {
    await this._ensureInit();

    const route = this._getRoute(url);
    const { isCloudCodeRequest, isGoogleApiRequest, requester, profile, kind } = route;
    const preferredProfile = this._getPreferredCloudCodeProfile();
    const isBinaryBody = this._isBinaryBody(body);

    if (isCloudCodeRequest && kind === 'axios' && config.allowUnfingerprintedCloudCodeFallback !== true) {
      throw new Error('Cloud Code TLS 指纹传输不可用：TLS 指纹请求器不可用，已阻止降级到无指纹 axios');
    }

    if (isCloudCodeRequest && preferredProfile === 'cloudcode-go' && profile === 'cloudcode') {
      logger.warn('[RequesterManager] Go Cloud Code HTTP/2 不可用，已回退到 Cloud Code TLS 指纹');
    }

    if (isCloudCodeRequest && preferredProfile === 'cloudcode-go' && profile === 'general') {
      logger.warn('[RequesterManager] Go Cloud Code HTTP/2 与 Cloud Code TLS 指纹均不可用，已回退到通用 TLS 指纹');
    }

    if (isCloudCodeRequest && preferredProfile === 'cloudcode' && profile === 'general') {
      logger.warn('[RequesterManager] Cloud Code 专用 TLS 指纹不可用，已回退到通用 TLS 指纹');
    }

    if (isCloudCodeRequest && profile === 'axios') {
      logger.warn('[RequesterManager] Cloud Code TLS 指纹请求器不可用，已回退到 axios 无指纹路径');
    }

    if (!isCloudCodeRequest && isGoogleApiRequest && config.cloudCodeTransport === 'go' && profile === 'general') {
      logger.warn('[RequesterManager] Go Google HTTP/2 不可用，已回退到通用 TLS 指纹');
    }

    this._logRouteSelection(url, kind === 'tls' && isBinaryBody ? 'axios' : profile, false);

    if (kind === 'tls' && isBinaryBody) {
      logger.warn('[RequesterManager] TLS 指纹请求器不支持二进制 body，已回退到 axios');
      return this._axiosFetch(url, { method, headers, body, okStatus });
    }

    if (kind === 'axios') {
      return this._axiosFetch(url, { method, headers, body, okStatus });
    }
    if (kind === 'go') {
      return this._goFetch(requester, url, { method, headers, body, okStatus });
    }
    return this._tlsFetch(requester, url, { method, headers, body, okStatus });
  }

  /**
   * 发送流式 SSE 请求
   *
   * @param {string} url
   * @param {object} options
   * @param {string}  [options.method='POST']
   * @param {object}  [options.headers={}]
   * @param {*}       [options.body=null]
   * @returns {Promise<StreamResponse | AxiosStreamResponse>}
   *   两者均实现 onStart/onData/onEnd/onError 链式调用接口
   */
  async fetchStream(url, { method = 'POST', headers = {}, body = null } = {}) {
    await this._ensureInit();

    const route = this._getRoute(url);
    const { isCloudCodeRequest, isGoogleApiRequest, requester, profile, kind } = route;
    const preferredProfile = this._getPreferredCloudCodeProfile();

    if (isCloudCodeRequest && kind === 'axios' && config.allowUnfingerprintedCloudCodeFallback !== true) {
      throw new Error('Cloud Code TLS 指纹传输不可用：TLS 指纹请求器不可用，已阻止降级到无指纹 axios');
    }

    if (isCloudCodeRequest && preferredProfile === 'cloudcode-go' && profile === 'cloudcode') {
      logger.warn('[RequesterManager] Go Cloud Code HTTP/2 不可用，流请求已回退到 Cloud Code TLS 指纹');
    }

    if (isCloudCodeRequest && preferredProfile === 'cloudcode-go' && profile === 'general') {
      logger.warn('[RequesterManager] Go Cloud Code HTTP/2 与 Cloud Code TLS 指纹均不可用，流请求已回退到通用 TLS 指纹');
    }

    if (isCloudCodeRequest && preferredProfile === 'cloudcode' && profile === 'general') {
      logger.warn('[RequesterManager] Cloud Code 专用 TLS 指纹不可用，流请求已回退到通用 TLS 指纹');
    }

    if (isCloudCodeRequest && profile === 'axios') {
      logger.warn('[RequesterManager] Cloud Code TLS 指纹请求器不可用，流请求已回退到 axios 无指纹路径');
    }

    if (!isCloudCodeRequest && isGoogleApiRequest && config.cloudCodeTransport === 'go' && profile === 'general') {
      logger.warn('[RequesterManager] Go Google HTTP/2 不可用，流请求已回退到通用 TLS 指纹');
    }

    this._logRouteSelection(url, profile, true);

    if (kind === 'axios') {
      return this._axiosFetchStream(url, { method, headers, body });
    }
    if (kind === 'go') {
      return this._goFetchStream(requester, url, { method, headers, body });
    }
    return this._tlsFetchStream(requester, url, { method, headers, body });
  }

  // ==================== TLS 路径 ====================

  async _tlsFetch(requester, url, { method, headers, body, okStatus }) {
    const reqConfig = this._buildTlsConfig(method, headers, body);
    const response = await requester.antigravity_fetch(url, reqConfig);

    if (!okStatus.includes(response.status)) {
      const errorBody = await response.text();
      throw { status: response.status, message: errorBody };
    }

    const text = await response.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    return { status: response.status, data };
  }

  async _goFetch(requester, url, { method, headers, body, okStatus }) {
    const reqConfig = this._buildTlsConfig(method, headers, body);
    const response = await requester.antigravity_fetch(url, reqConfig);

    if (!okStatus.includes(response.status)) {
      const errorBody = await response.text();
      throw { status: response.status, message: errorBody };
    }

    const text = await response.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    return { status: response.status, data };
  }

  _tlsFetchStream(requester, url, { method, headers, body }) {
    const reqConfig = this._buildTlsConfig(method, headers, body);
    return requester.antigravity_fetchStream(url, reqConfig);
  }

  _goFetchStream(requester, url, { method, headers, body }) {
    const reqConfig = this._buildTlsConfig(method, headers, body);
    return requester.antigravity_fetchStream(url, reqConfig);
  }

  _buildTlsConfig(method, headers, body) {
    const reqConfig = {
      method,
      headers,
      timeout_ms: config.timeout,
      proxy: config.proxy || null,
    };
    if (body !== null) {
      // Go worker 支持二进制 body；TLS 指纹路径会在 fetch() 中先回退到 axios
      if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
        reqConfig.body = body;
      } else {
        reqConfig.body = typeof body === 'string' ? body : JSON.stringify(body);
      }
    }
    return reqConfig;
  }

  _isBinaryBody(body) {
    return Buffer.isBuffer(body) || body instanceof Uint8Array;
  }

  // ==================== axios 路径 ====================

  async _axiosFetch(url, { method, headers, body, okStatus }) {
    const axiosConfig = buildAxiosRequestConfig({
      method,
      url,
      headers,
      data: body,
      timeout: config.timeout,
    });

    // 对于非 2xx 状态码，axios 默认会抛错；这里统一处理
    axiosConfig.validateStatus = (status) => true;

    const response = await axios(axiosConfig);

    if (!okStatus.includes(response.status)) {
      const errorBody = typeof response.data === 'string'
        ? response.data
        : JSON.stringify(response.data);
      throw { status: response.status, message: errorBody };
    }

    return { status: response.status, data: response.data };
  }

  /**
   * axios 流式 SSE 路径
   * 返回一个实现了 onStart/onData/onEnd/onError 接口的对象，与 TLS StreamResponse 兼容
   */
  _axiosFetchStream(url, { method, headers, body }) {
    const streamResponse = new AxiosStreamResponse();

    const axiosConfig = buildAxiosRequestConfig({
      method,
      url,
      headers,
      data: body,
      timeout: config.timeout,
    });
    axiosConfig.responseType = 'stream';

    axios(axiosConfig)
      .then((response) => {
        const status = response.status;
        streamResponse._status = status;
        if (streamResponse._onStart) {
          streamResponse._onStart({ status, headers: response.headers });
        }

        response.data.on('data', (chunk) => {
          const text = chunk.toString('utf8');
          if (streamResponse._onData) {
            streamResponse._onData(text);
          }
        });

        response.data.on('end', () => {
          if (streamResponse._onEnd) {
            streamResponse._onEnd();
          }
        });

        response.data.on('error', (err) => {
          if (streamResponse._onError) {
            streamResponse._onError(err);
          }
        });
      })
      .catch((err) => {
        if (streamResponse._onError) {
          streamResponse._onError(err);
        }
      });

    return streamResponse;
  }
}

// ==================== AxiosStreamResponse ====================

/**
 * axios 流式响应包装，接口与 src/requester.js 中的 StreamResponse 保持一致
 */
class AxiosStreamResponse {
  constructor() {
    this._status = null;
    this._onStart = null;
    this._onData = null;
    this._onEnd = null;
    this._onError = null;
  }

  get status() { return this._status; }

  onStart(callback) { this._onStart = callback; return this; }
  onData(callback)  { this._onData  = callback; return this; }
  onEnd(callback)   { this._onEnd   = callback; return this; }
  onError(callback) { this._onError = callback; return this; }
}

// ==================== 单例导出 ====================

export default new RequesterManager();

export function getTlsConfigFilenameForUrl(url) {
  return isCloudCodeUrl(url) ? 'cloudcode_tls_config.json' : 'tls_config.json';
}

export function getConfiguredCloudCodeRouteProfile(url, cloudCodeTransport = 'fingerprint') {
  if (!isCloudCodeUrl(url)) {
    return 'general';
  }
  return cloudCodeTransport === 'go' ? 'cloudcode-go' : 'cloudcode';
}

export function getConfiguredRouteProfile(url, cloudCodeTransport = 'fingerprint') {
  if (isCloudCodeUrl(url)) {
    return cloudCodeTransport === 'go' ? 'cloudcode-go' : 'cloudcode';
  }

  try {
    const hostname = new URL(url).hostname.toLowerCase();
    if (hostname === 'googleapis.com' || hostname.endsWith('.googleapis.com')) {
      return cloudCodeTransport === 'go' ? 'google-go' : 'general';
    }
  } catch {
    return 'general';
  }

  return 'general';
}
