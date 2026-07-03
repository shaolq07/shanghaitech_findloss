const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

loadEnv(path.join(__dirname, '.env'));

const PORT = Number(process.env.PORT || 8787);
const API_KEY = process.env.MODEL_API_KEY
  || process.env.HUNYUAN_API_KEY
  || process.env.OPENAI_API_KEY
  || '';
const TENCENT_SECRET_ID = process.env.TENCENTCLOUD_SECRET_ID
  || process.env.TENCENT_SECRET_ID
  || '';
const TENCENT_SECRET_KEY = process.env.TENCENTCLOUD_SECRET_KEY
  || process.env.TENCENT_SECRET_KEY
  || '';
const PROVIDER = process.env.MODEL_PROVIDER
  || (TENCENT_SECRET_ID && TENCENT_SECRET_KEY ? 'tencentcloud' : 'openai-compatible');
const BASE_URL = trimTrailingSlash(
  process.env.MODEL_API_BASE_URL
    || process.env.HUNYUAN_BASE_URL
    || 'https://api.hunyuan.cloud.tencent.com/v1'
);
const TENCENT_ENDPOINT = trimTrailingSlash(
  process.env.TENCENT_HUNYUAN_ENDPOINT || 'https://hunyuan.tencentcloudapi.com'
);
const TENCENT_MAP_KEY = process.env.TENCENT_MAP_KEY || '';
const TENCENT_MAP_SK = process.env.TENCENT_MAP_SK
  || process.env.TENCENT_MAP_SECRET_KEY
  || '';
const TENCENT_MAP_NETWORK_URL = process.env.TENCENT_MAP_NETWORK_URL
  || 'https://apis.map.qq.com/ws/location/v1/network';
const TENCENT_HOST = new URL(TENCENT_ENDPOINT).host;
const TENCENT_SERVICE = 'hunyuan';
const TENCENT_ACTION = 'ChatCompletions';
const TENCENT_VERSION = '2023-09-01';
const TENCENT_REGION = process.env.TENCENTCLOUD_REGION || process.env.TENCENT_REGION || '';
const MODEL_NAME = process.env.MODEL_NAME
  || process.env.HUNYUAN_MODEL
  || 'hunyuan-vision';
const JSON_MODE = /^true$/i.test(process.env.MODEL_JSON_MODE || '');
const MAX_BODY_BYTES = 12 * 1024 * 1024;

const CATEGORIES = [
  '\u8bc1\u4ef6',
  '\u7535\u5b50\u4ea7\u54c1',
  '\u4e66\u672c\u8d44\u6599',
  '\u8863\u7269',
  '\u94a5\u5319',
  '\u6821\u56ed\u5361',
  '\u96e8\u4f1e',
  '\u6c34\u676f',
  '\u5176\u4ed6'
];

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const index = trimmed.indexOf('=');
    if (index < 0) return;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  });
}

function trimTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type,authorization',
    'content-length': Buffer.byteLength(body)
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body is too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(new Error('Request body must be JSON'));
      }
    });
    req.on('error', reject);
  });
}

function cleanBase64(value) {
  return String(value || '').trim().replace(/^data:[^,]+,/, '');
}

function unique(values) {
  const seen = new Set();
  return (values || [])
    .map((value) => String(value || '').trim())
    .filter((value) => {
      if (!value || seen.has(value)) return false;
      seen.add(value);
      return true;
    });
}

function extractJsonObject(text) {
  const cleaned = String(text || '')
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error('Model response did not contain JSON');
  }
  return JSON.parse(match[0]);
}

function normalizeModelResult(raw) {
  const payload = raw && raw.data && !raw.category ? raw.data : raw;
  const tags = unique([
    ...(payload.aiTags || []),
    ...(payload.tags || []),
    ...(payload.colors || []),
    ...(payload.accessories || []),
    ...(payload.objects || [])
  ]).slice(0, 16);
  const semanticTags = unique([
    ...(payload.semanticTags || []),
    ...(payload.tags || []),
    ...(payload.objects || [])
  ]).slice(0, 12);

  const title = String(payload.title || payload.name || '').trim();
  const description = String(
    payload.visualDescription
      || payload.description
      || payload.caption
      || tags.join(' ')
  ).trim();

  return {
    title,
    description,
    category: CATEGORIES.includes(payload.category) ? payload.category : (payload.category || '\u5176\u4ed6'),
    aiTags: tags,
    semanticTags,
    visualDescription: description,
    yoloObjects: payload.yoloObjects || payload.objects || [],
    imageEmbedding: payload.imageEmbedding || payload.image_embedding || [],
    semanticEmbedding: payload.semanticEmbedding || payload.semantic_embedding || payload.embedding || [],
    modelSources: {
      provider: PROVIDER,
      baseUrl: PROVIDER === 'tencentcloud' ? TENCENT_ENDPOINT : BASE_URL,
      model: MODEL_NAME
    }
  };
}

function buildPrompt(hint) {
  return [
    'You are an image recognition assistant for a campus lost-and-found mini program.',
    'Inspect the uploaded image and extract only object information.',
    'Do not mention comments, contacting the owner, pickup instructions, or any workflow text.',
    'Return a single JSON object only. No Markdown.',
    'All visible user-facing values must be Simplified Chinese.',
    'JSON schema:',
    '{',
    '  "title": "short item title, for example: black thermos cup",',
    '  "description": "concise visual description of object features only",',
    `  "category": "one of: ${CATEGORIES.join(', ')}",`,
    '  "tags": ["object type", "color", "shape", "material", "brand if visible"],',
    '  "colors": ["main visible colors"],',
    '  "accessories": ["attachments or special marks"],',
    '  "objects": ["detected object names"]',
    '}',
    `User hint: ${hint || 'none'}`
  ].join('\n');
}

async function callVisionModel(payload) {
  if (!payload.imageBase64) {
    throw new Error('Missing imageBase64');
  }

  if (PROVIDER === 'tencentcloud') {
    return callTencentCloudVision(payload);
  }
  return callOpenAICompatibleVision(payload);
}

function sha256(value, encoding = 'hex') {
  return crypto.createHash('sha256').update(value, 'utf8').digest(encoding);
}

function hmac(key, value, encoding) {
  return crypto.createHmac('sha256', key).update(value, 'utf8').digest(encoding);
}

function formatUtcDate(timestamp) {
  return new Date(timestamp * 1000).toISOString().slice(0, 10);
}

function signTencentCloudRequest(payloadText, timestamp) {
  const date = formatUtcDate(timestamp);
  const canonicalHeaders = [
    'content-type:application/json; charset=utf-8',
    `host:${TENCENT_HOST}`,
    `x-tc-action:${TENCENT_ACTION.toLowerCase()}`
  ].join('\n') + '\n';
  const signedHeaders = 'content-type;host;x-tc-action';
  const canonicalRequest = [
    'POST',
    '/',
    '',
    canonicalHeaders,
    signedHeaders,
    sha256(payloadText)
  ].join('\n');
  const credentialScope = `${date}/${TENCENT_SERVICE}/tc3_request`;
  const stringToSign = [
    'TC3-HMAC-SHA256',
    timestamp,
    credentialScope,
    sha256(canonicalRequest)
  ].join('\n');
  const secretDate = hmac(`TC3${TENCENT_SECRET_KEY}`, date);
  const secretService = hmac(secretDate, TENCENT_SERVICE);
  const secretSigning = hmac(secretService, 'tc3_request');
  const signature = hmac(secretSigning, stringToSign, 'hex');
  return [
    `TC3-HMAC-SHA256 Credential=${TENCENT_SECRET_ID}/${credentialScope}`,
    `SignedHeaders=${signedHeaders}`,
    `Signature=${signature}`
  ].join(', ');
}

function parseTencentCloudContent(data) {
  const response = data.Response || data.response || {};
  if (response.Error) {
    const code = response.Error.Code || 'TencentCloudError';
    const message = response.Error.Message || 'Tencent Cloud API failed';
    throw new Error(`${code}: ${message}`);
  }
  const choices = response.Choices || data.Choices || [];
  return choices
    && choices[0]
    && choices[0].Message
    && choices[0].Message.Content;
}

async function callTencentCloudVision(payload) {
  if (!TENCENT_SECRET_ID || !TENCENT_SECRET_KEY) {
    throw new Error('TENCENTCLOUD_SECRET_ID and TENCENTCLOUD_SECRET_KEY are not configured');
  }

  const mimeType = payload.mimeType || 'image/jpeg';
  const imageUrl = `data:${mimeType};base64,${cleanBase64(payload.imageBase64)}`;
  const requestBody = {
    Model: MODEL_NAME,
    Stream: false,
    Temperature: 0.2,
    Messages: [
      {
        Role: 'user',
        Contents: [
          { Type: 'text', Text: buildPrompt(payload.hint || '') },
          { Type: 'image_url', ImageUrl: { Url: imageUrl } }
        ]
      }
    ]
  };
  const payloadText = JSON.stringify(requestBody);
  const timestamp = Math.floor(Date.now() / 1000);
  const headers = {
    authorization: signTencentCloudRequest(payloadText, timestamp),
    'content-type': 'application/json; charset=utf-8',
    host: TENCENT_HOST,
    'x-tc-action': TENCENT_ACTION,
    'x-tc-timestamp': String(timestamp),
    'x-tc-version': TENCENT_VERSION
  };
  if (TENCENT_REGION) headers['x-tc-region'] = TENCENT_REGION;

  const response = await fetch(TENCENT_ENDPOINT, {
    method: 'POST',
    headers,
    body: payloadText
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = data.Response && data.Response.Error;
    const message = error && (error.Message || error.Code);
    throw new Error(`Tencent Cloud API failed: HTTP ${response.status}${message ? ` ${message}` : ''}`);
  }
  return normalizeModelResult(extractJsonObject(parseTencentCloudContent(data) || ''));
}

async function callOpenAICompatibleVision(payload) {
  if (!API_KEY) {
    throw new Error('MODEL_API_KEY is not configured in tools/model-proxy/.env');
  }

  const mimeType = payload.mimeType || 'image/jpeg';
  const imageUrl = `data:${mimeType};base64,${cleanBase64(payload.imageBase64)}`;
  const body = {
    model: MODEL_NAME,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: buildPrompt(payload.hint || '') },
          { type: 'image_url', image_url: { url: imageUrl } }
        ]
      }
    ],
    temperature: 0.2
  };
  if (JSON_MODE) {
    body.response_format = { type: 'json_object' };
  }

  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${API_KEY}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data.error && (data.error.message || data.error.code);
    throw new Error(`Model API failed: HTTP ${response.status}${message ? ` ${message}` : ''}`);
  }

  const content = data.choices
    && data.choices[0]
    && data.choices[0].message
    && data.choices[0].message.content;
  if (!content && data.category) return normalizeModelResult(data);
  return normalizeModelResult(extractJsonObject(content || ''));
}

function transformLat(x, y) {
  let ret = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3;
  ret += (20 * Math.sin(y * Math.PI) + 40 * Math.sin(y / 3 * Math.PI)) * 2 / 3;
  ret += (160 * Math.sin(y / 12 * Math.PI) + 320 * Math.sin(y * Math.PI / 30)) * 2 / 3;
  return ret;
}

function transformLng(x, y) {
  let ret = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3;
  ret += (20 * Math.sin(x * Math.PI) + 40 * Math.sin(x / 3 * Math.PI)) * 2 / 3;
  ret += (150 * Math.sin(x / 12 * Math.PI) + 300 * Math.sin(x / 30 * Math.PI)) * 2 / 3;
  return ret;
}

function outOfChina(latitude, longitude) {
  return longitude < 72.004 || longitude > 137.8347 || latitude < 0.8293 || latitude > 55.8271;
}

function wgs84ToGcj02(latitude, longitude) {
  const lat = Number(latitude);
  const lng = Number(longitude);
  if (!lat || !lng || outOfChina(lat, lng)) return { latitude: lat, longitude: lng };
  const a = 6378245;
  const ee = 0.00669342162296594323;
  let dLat = transformLat(lng - 105, lat - 35);
  let dLng = transformLng(lng - 105, lat - 35);
  const radLat = lat / 180 * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - ee * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180) / ((a * (1 - ee)) / (magic * sqrtMagic) * Math.PI);
  dLng = (dLng * 180) / (a / sqrtMagic * Math.cos(radLat) * Math.PI);
  return { latitude: lat + dLat, longitude: lng + dLng };
}

function gcj02ToWgs84(latitude, longitude) {
  const lat = Number(latitude);
  const lng = Number(longitude);
  if (!lat || !lng || outOfChina(lat, lng)) return { latitude: lat, longitude: lng };
  const gcj = wgs84ToGcj02(lat, lng);
  return {
    latitude: lat * 2 - gcj.latitude,
    longitude: lng * 2 - gcj.longitude
  };
}

function normalizeSignalRssi(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number === 0) return -85;
  if (number < 0) return Math.round(number);
  return Math.round(-100 + Math.min(100, number) * 0.5);
}

function normalizeMac(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-fA-F0-9]/g, '')
    .toLowerCase();
}

function buildTencentMapPayload(body = {}) {
  const gps = body.gps || {};
  const coord = body.coordType === 'wgs84'
    ? { latitude: gps.latitude, longitude: gps.longitude }
    : gcj02ToWgs84(gps.latitude, gps.longitude);
  const wifiEntries = []
    .concat(body.wifi && body.wifi.connected ? [body.wifi.connected] : [])
    .concat((body.wifi && body.wifi.list) || []);
  const wifiinfo = wifiEntries
    .map((entry) => ({
      mac: normalizeMac(entry.BSSID || entry.bssid || entry.mac),
      rssi: normalizeSignalRssi(entry.signalStrength || entry.RSSI || entry.rssi)
    }))
    .filter((entry) => entry.mac)
    .slice(0, 30);
  const beaconinfo = ((body.ble && body.ble.devices) || [])
    .map((device) => ({
      mac: normalizeMac(device.deviceId || device.mac),
      rssi: normalizeSignalRssi(device.RSSI || device.rssi),
      time: Date.now()
    }))
    .filter((entry) => entry.mac)
    .slice(0, 30);

  const payload = {
    key: TENCENT_MAP_KEY,
    device_id: body.deviceId || 'shanghaitech-findloss-dev'
  };
  if (coord.latitude && coord.longitude) {
    payload.gpsinfo = {
      latitude: Number(coord.latitude),
      longitude: Number(coord.longitude),
      accuracy: Number(gps.accuracy) || 0,
      speed: Number(gps.speed) || 0
    };
  }
  if (wifiinfo.length) payload.wifiinfo = wifiinfo;
  if (beaconinfo.length) payload.beaconinfo = beaconinfo;
  return payload;
}

function tencentMapSignatureValue(value) {
  if (value && typeof value === 'object') {
    return JSON.stringify(value);
  }
  return String(value);
}

function buildTencentMapSig(pathname, payload) {
  const query = Object.keys(payload)
    .sort()
    .map((key) => `${key}=${tencentMapSignatureValue(payload[key])}`)
    .join('&');
  return crypto
    .createHash('md5')
    .update(`${pathname}?${query}${TENCENT_MAP_SK}`, 'utf8')
    .digest('hex')
    .toLowerCase();
}

async function resolveTencentMapIndoor(body = {}) {
  if (!TENCENT_MAP_KEY) {
    throw new Error('TENCENT_MAP_KEY is not configured in tools/model-proxy/.env');
  }
  const payload = buildTencentMapPayload(body);
  if (!payload.gpsinfo && !payload.wifiinfo && !payload.beaconinfo) {
    throw new Error('Missing GPS, Wi-Fi or BLE signal data');
  }
  const endpoint = new URL(TENCENT_MAP_NETWORK_URL);
  if (TENCENT_MAP_SK) {
    endpoint.searchParams.set('sig', buildTencentMapSig(endpoint.pathname, payload));
  }
  const response = await fetch(endpoint.toString(), {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.status !== 0) {
    throw new Error(data.message || `Tencent Map API failed: HTTP ${response.status}`);
  }
  const result = data.result || {};
  const location = result.location || {};
  const gcj = wgs84ToGcj02(location.latitude, location.longitude);
  return {
    provider: 'tencent-map-network',
    latitude: Number(gcj.latitude) || null,
    longitude: Number(gcj.longitude) || null,
    wgs84Latitude: Number(location.latitude) || null,
    wgs84Longitude: Number(location.longitude) || null,
    accuracy: Number(location.accuracy) || 0,
    confidence: location.accuracy ? Math.max(0, Math.min(1, 1 - Number(location.accuracy) / 300)) : 0,
    address: result.address || '',
    adInfo: result.ad_info || {},
    requestId: data.request_id || ''
  };
}

async function handleRequest(req, res) {
  if (req.method === 'OPTIONS') {
    sendJson(res, 204, {});
    return;
  }
  if (req.method === 'GET' && req.url === '/health') {
    sendJson(res, 200, {
      ok: true,
      model: MODEL_NAME,
      provider: PROVIDER,
      baseUrl: PROVIDER === 'tencentcloud' ? TENCENT_ENDPOINT : BASE_URL,
      hasApiKey: Boolean(API_KEY),
      hasTencentCredentials: Boolean(TENCENT_SECRET_ID && TENCENT_SECRET_KEY),
      hasTencentMapKey: Boolean(TENCENT_MAP_KEY),
      hasTencentMapSk: Boolean(TENCENT_MAP_SK)
    });
    return;
  }
  if (req.method === 'POST' && req.url === '/indoor-location') {
    try {
      const body = await readJsonBody(req);
      const result = await resolveTencentMapIndoor(body);
      sendJson(res, 200, { ok: true, data: result });
    } catch (error) {
      sendJson(res, 200, {
        ok: false,
        message: error.message || 'Tencent Map indoor positioning failed'
      });
    }
    return;
  }
  if (req.method !== 'POST' || req.url !== '/lostfound-vision') {
    sendJson(res, 404, { ok: false, message: 'Not found' });
    return;
  }

  try {
    const body = await readJsonBody(req);
    const result = await callVisionModel(body);
    sendJson(res, 200, { ok: true, data: result });
  } catch (error) {
    sendJson(res, 500, {
      ok: false,
      message: error.message || 'Model proxy failed'
    });
  }
}

http.createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    sendJson(res, 500, {
      ok: false,
      message: error.message || 'Model proxy failed'
    });
  });
}).listen(PORT, '127.0.0.1', () => {
  console.log(`lostfound model proxy listening on http://127.0.0.1:${PORT}`);
});
