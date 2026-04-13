const CLOUDCODE_HOST_PATTERN = /(^|\.)(cloudcode-pa|daily-cloudcode-pa)(\.sandbox)?\.googleapis\.com$/i;

export function isCloudCodeHost(hostname) {
  if (!hostname || typeof hostname !== 'string') return false;
  return CLOUDCODE_HOST_PATTERN.test(hostname.trim());
}

export function isCloudCodeUrl(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    return isCloudCodeHost(new URL(url).hostname);
  } catch {
    return false;
  }
}
