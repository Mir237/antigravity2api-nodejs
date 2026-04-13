import config from '../config/config.js';

export function getQuotaProjectId(token) {
  return token?.quotaProjectId ||
    token?.quota_project_id ||
    token?.quotaProject ||
    token?.projectId ||
    token?.quota_project ||
    null;
}

export function appendQuotaProjectHeader(headers, token) {
  void token;
  return headers;
}

export function buildAuthorizedHeaders(token, options = {}) {
  const {
    host = config.api.host,
    userAgent = config.api.userAgent,
    contentType = 'application/json',
    acceptEncoding = 'gzip',
    transferEncoding = null
  } = options;

  const headers = {
    'Host': host,
    'User-Agent': userAgent,
    'Authorization': `Bearer ${token.access_token}`,
    'Content-Type': contentType,
    'Accept-Encoding': acceptEncoding
  };

  if (transferEncoding) {
    headers['Transfer-Encoding'] = transferEncoding;
  }

  return appendQuotaProjectHeader(headers, token);
}
