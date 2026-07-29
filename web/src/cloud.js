const TCB_ENV_ID = import.meta.env.VITE_CLOUDBASE_ENV_ID || import.meta.env.VITE_TCB_ENV_ID || 'cloud1-d9gnyuxf5b44b6b92';
const TCB_ACCESS_KEY = import.meta.env.VITE_CLOUDBASE_ACCESS_KEY || import.meta.env.VITE_TCB_ACCESS_KEY || '';
const TCB_REGION = import.meta.env.VITE_CLOUDBASE_REGION || import.meta.env.VITE_TCB_REGION || 'ap-shanghai';
const TCB_FUNCTION_NAME = import.meta.env.VITE_CLOUDBASE_FUNCTION_NAME || import.meta.env.VITE_TCB_FUNCTION_NAME || 'lostfound';

let cloudbaseAppPromise = null;

export function isCloudConfigured() {
  return Boolean(TCB_ENV_ID) && import.meta.env.VITE_DISABLE_TCB !== 'true';
}

export function isCloudSyncEnabled() {
  return isCloudConfigured() && import.meta.env.VITE_DISABLE_CLOUD_SYNC !== 'true';
}

export function getCloudFunctionName() {
  return TCB_FUNCTION_NAME;
}

function parseMaybeJson(value) {
  if (!value || typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function unwrapCloudFunctionResponse(response) {
  const queue = [response?.result, response?.data, response];
  const seen = new Set();

  while (queue.length) {
    const parsed = parseMaybeJson(queue.shift());
    if (!parsed || typeof parsed !== 'object' || seen.has(parsed)) continue;
    seen.add(parsed);
    if ('ok' in parsed || 'code' in parsed) return parsed;
    queue.push(parsed.result, parsed.data, parsed.body);
  }

  return {};
}

export function readableCloudError(error, fallback = '调用失败') {
  const parts = [
    error?.message,
    error?.msg,
    error?.errMsg,
    error?.code,
    error?.errCode,
    error?.error?.message,
    error?.error?.code
  ].filter(Boolean);
  if (parts.length) return parts.join(' ');
  try {
    const json = JSON.stringify(error);
    if (json && json !== '{}') return json;
  } catch {
    // Ignore serialization failures.
  }
  const text = String(error || '');
  return text && text !== '[object Object]' ? text : fallback;
}

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = window.setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => window.clearTimeout(timer));
}

async function ensureCloudbaseAuth(app) {
  const auth = typeof app.auth === 'function' ? app.auth({ persistence: 'local' }) : app.auth;
  if (!auth) return;

  const state = await (auth.hasLoginState?.() || auth.getLoginState?.()).catch(() => null);
  if (state) return;

  if (typeof auth.signInAnonymously === 'function') {
    await auth.signInAnonymously();
    return;
  }

  const provider = typeof auth.anonymousAuthProvider === 'function'
    ? auth.anonymousAuthProvider()
    : auth.anonymousAuthProvider;
  if (provider?.signIn) {
    await provider.signIn();
  }
}

export async function getCloudbaseApp() {
  if (!isCloudConfigured()) {
    throw new Error('未配置 CloudBase 环境');
  }

  if (!cloudbaseAppPromise) {
    cloudbaseAppPromise = Promise.resolve().then(async () => {
      const { default: cloudbase } = await import('@cloudbase/js-sdk');
      const config = {
        env: TCB_ENV_ID,
        region: TCB_REGION
      };
      if (TCB_ACCESS_KEY) config.accessKey = TCB_ACCESS_KEY;
      const app = cloudbase.init(config);
      await ensureCloudbaseAuth(app);
      return app;
    }).catch((error) => {
      cloudbaseAppPromise = null;
      throw error;
    });
  }

  return cloudbaseAppPromise;
}

export async function callLostfound(action, data = {}, timeoutMs = 30000) {
  const app = await getCloudbaseApp();
  const response = await withTimeout(
    app.callFunction({
      name: TCB_FUNCTION_NAME,
      parse: true,
      data: {
        action,
        ...data
      }
    }),
    timeoutMs,
    `云函数 ${action} 调用超时`
  );

  const body = unwrapCloudFunctionResponse(response);
  if (!body.ok) {
    const error = new Error(body.message || body.error || `云函数 ${action} 返回失败`);
    error.code = body.code || 'CLOUD_ERROR';
    throw error;
  }
  return body.data;
}

export async function uploadDataUrl(imageDataUrl, folder = 'lostfound-web') {
  if (!imageDataUrl || typeof imageDataUrl !== 'string') return '';
  if (/^https:\/\//i.test(imageDataUrl) || /^cloud:\/\//i.test(imageDataUrl)) {
    return imageDataUrl;
  }
  if (!imageDataUrl.startsWith('data:')) return '';

  const app = await getCloudbaseApp();
  const blob = await (await fetch(imageDataUrl)).blob();
  const extension = (blob.type || 'image/jpeg').split('/')[1] || 'jpg';
  const cloudPath = `${folder}/${Date.now()}_${Math.random().toString(16).slice(2, 8)}.${extension}`;
  const result = await withTimeout(
    app.uploadFile({
      cloudPath,
      filePath: blob
    }),
    45000,
    '图片上传超时'
  );
  return result?.fileID || result?.fileId || '';
}

export async function resolveCloudFileUrls(fileIds = []) {
  const uniqueIds = Array.from(new Set(fileIds.filter(Boolean)));
  if (!uniqueIds.length) return {};
  const app = await getCloudbaseApp();
  const result = await withTimeout(
    app.getTempFileURL({ fileList: uniqueIds }),
    20000,
    '获取云端图片超时'
  );
  return Object.fromEntries(
    (result?.fileList || []).map((entry) => [
      entry.fileID || entry.fileId,
      entry.tempFileURL || entry.download_url || ''
    ])
  );
}
