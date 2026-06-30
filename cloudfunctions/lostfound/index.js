const cloud = require('wx-server-sdk');
const https = require('https');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const COLLECTIONS = {
  users: 'users',
  items: 'items',
  comments: 'comments',
  thanks: 'thanks',
  notifications: 'notifications',
  reports: 'reports',
  locations: 'campus_locations'
};

const CATEGORY_KEYWORDS = {
  '证件': ['证件', '身份证', '学生证', '卡片', '护照'],
  '电子产品': ['手机', '电脑', '耳机', '充电器', '平板', '电子'],
  '书本资料': ['书', '教材', '笔记', '资料', '文件', '纸'],
  '衣物': ['衣服', '外套', '帽子', '围巾', '手套'],
  '钥匙': ['钥匙', '门禁'],
  '校园卡': ['校园卡', '一卡通', '饭卡'],
  '雨伞': ['伞', '雨伞'],
  '水杯': ['杯', '水杯', '保温杯']
};

const BAD_WORDS = ['辱骂', '广告', '诈骗', '加群'];

const IMAGE_PROVIDER = process.env.IMAGE_RECOGNITION_PROVIDER || 'tencent-hunyuan';
const HUNYUAN_API_KEY = process.env.TENCENTCLOUD_API_KEY || process.env.HUNYUAN_API_KEY;
const HUNYUAN_API_URL = process.env.HUNYUAN_API_URL || 'https://api.hunyuan.cloud.tencent.com/v1/chat/completions';
const DEFAULT_HUNYUAN_VISION_MODEL = 'hunyuan-vision';
const HUNYUAN_VISION_MODEL = process.env.HUNYUAN_VISION_MODEL === 'hunyuan-vision-1.5-instruct'
  ? DEFAULT_HUNYUAN_VISION_MODEL
  : (process.env.HUNYUAN_VISION_MODEL || DEFAULT_HUNYUAN_VISION_MODEL);

const CATEGORY_ALIASES = {
  '证件': ['证件', '身份证', '学生证', '护照', '驾驶证', '银行卡', '卡片'],
  '电子产品': ['手机', '电脑', '笔记本电脑', '平板', '耳机', '充电器', '数据线', '相机', '鼠标', '键盘', 'u盘', '硬盘', '电子'],
  '书本资料': ['书', '教材', '笔记本', '笔记', '资料', '文件', '试卷', '纸张', '书包'],
  '衣物': ['衣服', '外套', '上衣', '裤子', '帽子', '围巾', '手套', '鞋', '包'],
  '钥匙': ['钥匙', '钥匙串', '门禁'],
  '校园卡': ['校园卡', '一卡通', '饭卡', '学生卡'],
  '雨伞': ['伞', '雨伞', '折叠伞'],
  '水杯': ['杯', '水杯', '保温杯', '杯子', '瓶子', '水瓶']
};

const SEARCH_TAG_GROUPS = [
  ['水杯', '杯子', '保温杯', '水壶', '水瓶', '瓶子', '杯', 'bottle', 'cup'],
  ['雨伞', '伞', '折叠伞', '遮阳伞', 'umbrella'],
  ['校园卡', '一卡通', '饭卡', '学生卡', '校卡', '卡片', 'card'],
  ['证件', '身份证', '学生证', '护照', '驾驶证', '银行卡', '校园卡', '一卡通', '学生卡', '卡片'],
  ['手机', '电话', 'iphone', '安卓', '电子产品'],
  ['电脑', '笔记本电脑', '笔记本', '平板', 'ipad', '电子产品'],
  ['耳机', '蓝牙耳机', 'airpods', '耳塞', '电子产品'],
  ['充电器', '充电线', '数据线', '充电宝', '移动电源', '电子产品'],
  ['书', '书本', '教材', '资料', '文件', '试卷', '纸张', '笔记', '笔记本', '书本资料'],
  ['衣服', '衣物', '外套', '上衣', '裤子', '帽子', '围巾', '手套', '鞋', '包'],
  ['钥匙', '钥匙串', '门禁'],
  ['黑色', '黑', 'black'],
  ['白色', '白', 'white'],
  ['蓝色', '蓝', 'blue'],
  ['红色', '红', 'red'],
  ['绿色', '绿', 'green'],
  ['黄色', '黄', 'yellow'],
  ['灰色', '灰', 'gray', 'grey'],
  ['粉色', '粉', 'pink'],
  ['紫色', '紫', 'purple'],
  ['透明', 'clear'],
  ['图书馆', '图书', 'lib', 'library'],
  ['食堂', '餐厅', '饭堂', 'dining'],
  ['体育馆', '体育场', 'gym'],
  ['宿舍', '宿舍楼', '学生宿舍'],
  ['教学楼', '教室', '课堂'],
  ['实验室', 'lab'],
  ['行政中心', '行政楼']
];

const IGNORED_SEARCH_TAGS = {
  '图片识别': true,
  '图片自动识别': true,
  '图片待识别': true,
  '手动校正': true,
  '待确认': true
};

function ok(data = {}) {
  return { ok: true, data };
}

function fail(message, code = 'BAD_REQUEST') {
  return { ok: false, code, message };
}

function httpResponse(payload, statusCode = 200) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'POST, OPTIONS'
    },
    body: JSON.stringify(payload)
  };
}

function getHeader(headers = {}, name) {
  const target = name.toLowerCase();
  const keys = Object.keys(headers || {});
  for (let i = 0; i < keys.length; i += 1) {
    if (keys[i].toLowerCase() === target) return headers[keys[i]];
  }
  return '';
}

function splitBuffer(buffer, separator) {
  const chunks = [];
  let start = 0;
  let index = buffer.indexOf(separator, start);
  while (index !== -1) {
    chunks.push(buffer.slice(start, index));
    start = index + separator.length;
    index = buffer.indexOf(separator, start);
  }
  chunks.push(buffer.slice(start));
  return chunks;
}

function trimPartContent(buffer) {
  let end = buffer.length;
  if (end >= 2 && buffer[end - 2] === 13 && buffer[end - 1] === 10) end -= 2;
  return buffer.slice(0, end);
}

function parseMultipartBody(event = {}) {
  const contentType = getHeader(event.headers, 'content-type');
  const matched = String(contentType).match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!matched) return null;

  const boundary = matched[1] || matched[2];
  const bodyBuffer = event.isBase64Encoded
    ? Buffer.from(event.body || '', 'base64')
    : Buffer.from(event.body || '', 'binary');
  const result = {};

  splitBuffer(bodyBuffer, Buffer.from(`--${boundary}`)).forEach((part) => {
    let current = part;
    if (current.length >= 2 && current[0] === 13 && current[1] === 10) {
      current = current.slice(2);
    }
    if (!current.length || current.slice(0, 2).toString() === '--') return;

    const headerEnd = current.indexOf(Buffer.from('\r\n\r\n'));
    if (headerEnd === -1) return;
    const headerText = current.slice(0, headerEnd).toString('utf8');
    const content = trimPartContent(current.slice(headerEnd + 4));
    const nameMatch = headerText.match(/name="([^"]+)"/i);
    if (!nameMatch) return;

    const name = nameMatch[1];
    const hasFilename = /filename="/i.test(headerText);
    if (hasFilename || name === 'file' || name === 'image') {
      result.imageBase64 = content.toString('base64');
      return;
    }
    result[name] = content.toString('utf8').trim();
  });

  return result;
}

function parseHttpEvent(event = {}) {
  if (!event.httpMethod && typeof event.body === 'undefined') return null;
  if (event.httpMethod === 'OPTIONS') return { action: '__options' };

  const multipartBody = parseMultipartBody(event);
  if (multipartBody) return multipartBody;

  let body = event.body || {};
  if (event.isBase64Encoded && typeof body === 'string') {
    body = Buffer.from(body, 'base64').toString('utf8');
  }
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body || '{}');
    } catch (error) {
      return { action: '__bad_request', message: 'HTTP 请求体不是合法 JSON' };
    }
  }
  return body || {};
}

function now() {
  return db.serverDate();
}

function classifyByText(text = '') {
  const source = text.toLowerCase();
  const categories = Object.keys(CATEGORY_KEYWORDS);
  for (let i = 0; i < categories.length; i += 1) {
    const category = categories[i];
    if (CATEGORY_KEYWORDS[category].some((word) => source.includes(word.toLowerCase()))) {
      return { category, aiTags: [category], confidence: 0.62 };
    }
  }
  return { category: '其他', aiTags: ['待确认'], confidence: 0 };
}

function hasHunyuanCredentials() {
  return Boolean(HUNYUAN_API_KEY);
}

async function getImageBase64(fileId) {
  if (!fileId) throw new Error('缺少图片 fileId');
  const result = await cloud.downloadFile({ fileID: fileId });
  return Buffer.from(result.fileContent).toString('base64');
}

function normalizeImageBase64(imageBase64 = '') {
  return String(imageBase64).replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '').trim();
}

function normalizeText(text = '') {
  return String(text).trim().toLowerCase();
}

function normalizeSearchText(value = '') {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[，。！？、；：,.!?;:()[\]{}"'“”‘’/\\|-]/g, ' ')
    .replace(/\s+/g, ' ');
}

function tokenizeSearchText(value = '') {
  const normalized = normalizeSearchText(value);
  const tokens = normalized.match(/[a-z0-9]+|[\u4e00-\u9fa5]{1,8}/g) || [];
  return tokens.filter((token) => token.length > 1 || /[\u4e00-\u9fa5]/.test(token));
}

function expandSearchTerms(values = []) {
  const source = normalizeSearchText(values.join(' '));
  const terms = [];

  values.forEach((value) => {
    if (!IGNORED_SEARCH_TAGS[value]) terms.push(value);
    terms.push.apply(terms, tokenizeSearchText(value));
  });

  SEARCH_TAG_GROUPS.forEach((group) => {
    if (group.some((term) => source.includes(normalizeSearchText(term)))) {
      terms.push.apply(terms, group);
    }
  });

  return unique(terms);
}

function getMatchedSearchGroups(value = '') {
  const source = normalizeSearchText(value);
  return SEARCH_TAG_GROUPS.filter((group) => group.some((term) => source.includes(normalizeSearchText(term))));
}

function buildItemSearchTags(item = {}) {
  const baseValues = [
    item.title,
    item.description,
    item.category,
    item.locationName,
    item.locationDetail,
    item.type === 'lost' ? '寻物 丢失 遗失' : '招领 捡到 拾取'
  ].concat(item.aiTags || []);

  return expandSearchTerms(baseValues).slice(0, 60);
}

function semanticMatchItem(item = {}, keyword = '') {
  const query = normalizeSearchText(keyword);
  if (!query) return { matched: true, score: 0 };

  const queryTerms = expandSearchTerms([keyword]);
  const queryGroups = getMatchedSearchGroups(keyword);
  const itemTags = item.searchTags && item.searchTags.length ? item.searchTags : buildItemSearchTags(item);
  const itemText = normalizeSearchText([
    item.title,
    item.description,
    item.category,
    item.locationName,
    item.locationDetail
  ].concat(item.aiTags || [], itemTags || []).join(' '));

  if (queryGroups.length > 1) {
    const hasAllGroups = queryGroups.every((group) => group.some((term) => itemText.includes(normalizeSearchText(term))));
    if (!hasAllGroups) return { matched: false, score: 0 };
  }

  let score = itemText.includes(query) ? 10 : 0;
  queryTerms.forEach((term) => {
    const normalized = normalizeSearchText(term);
    if (!normalized) return;
    if (itemText.includes(normalized)) score += 2;
    if ((itemTags || []).some((tag) => normalizeSearchText(tag) === normalized)) score += 3;
  });

  return { matched: score > 0, score };
}

function mapCategoryFromLabels(labels = []) {
  const source = labels
    .map((label) => [label.name, label.firstCategory, label.secondCategory, label.parents].filter(Boolean).join(' '))
    .join(' ')
    .toLowerCase();

  const categories = Object.keys(CATEGORY_ALIASES);
  for (let i = 0; i < categories.length; i += 1) {
    const category = categories[i];
    if (CATEGORY_ALIASES[category].some((word) => source.includes(normalizeText(word)))) {
      return category;
    }
  }
  return '其他';
}

function unique(values) {
  const seen = {};
  return values.filter((value) => {
    const normalized = String(value || '').trim();
    if (!normalized || seen[normalized]) return false;
    seen[normalized] = true;
    return true;
  });
}

function sanitizeErrorText(text = '') {
  return String(text).replace(/sk-[A-Za-z0-9_*.-]{8,}/g, '[redacted-api-key]');
}

function postJson(urlString, payload, headers = {}) {
  const url = new URL(urlString);
  const body = JSON.stringify(payload);

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: url.hostname,
      path: `${url.pathname}${url.search}`,
      port: url.port || 443,
      method: 'POST',
      headers: Object.assign({
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }, headers),
      timeout: 25000
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode}: ${sanitizeErrorText(text).slice(0, 200)}`));
          return;
        }
        try {
          resolve(JSON.parse(text));
        } catch (error) {
          reject(new Error(`响应不是 JSON: ${text.slice(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error('图像识别请求超时'));
    });
    req.write(body);
    req.end();
  });
}

function isHunyuanConfigError(error) {
  const message = String(error && (error.message || error) || '');
  return /HTTP 401|HTTP 403|Incorrect API key|invalid api key|unauthorized|forbidden/i.test(message);
}

function extractJsonObject(content = '') {
  const text = String(content).trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
  try {
    return JSON.parse(text);
  } catch (error) {
    const matched = text.match(/\{[\s\S]*\}/);
    if (!matched) throw error;
    return JSON.parse(matched[0]);
  }
}

function normalizeVisionResult(result = {}) {
  const rawTags = Array.isArray(result.aiTags) ? result.aiTags : (Array.isArray(result.labels) ? result.labels : []);
  const labels = rawTags
    .map((tag) => (typeof tag === 'string' ? { name: tag } : { name: tag.name || tag.label || '', confidence: tag.confidence || tag.score || 0 }))
    .filter((label) => label.name);
  const itemName = String(result.itemName || result.title || (labels[0] && labels[0].name) || '').trim();
  const categories = Object.keys(CATEGORY_ALIASES);
  const category = categories.includes(result.category)
    ? result.category
    : mapCategoryFromLabels([{ name: itemName }].concat(labels));
  const confidenceValue = Number(result.confidence || (labels[0] && labels[0].confidence) || 0);
  const confidence = confidenceValue > 1 ? Math.round(confidenceValue) / 100 : confidenceValue;
  const tagNames = unique(labels.map((label) => label.name)).slice(0, 4);

  return {
    itemName,
    title: itemName,
    category,
    aiTags: unique(['图片识别'].concat(tagNames, category === '其他' ? [] : [category])),
    confidence,
    description: cleanVisionDescription(result.description || ''),
    provider: 'tencent-hunyuan'
  };
}

function cleanVisionDescription(description = '') {
  return String(description)
    .replace(/请失主[^。！？]*[。！？]?/g, '')
    .replace(/请在评论[^。！？]*[。！？]?/g, '')
    .replace(/在评论中[^。！？]*[。！？]?/g, '')
    .replace(/确认无误后[^。！？]*[。！？]?/g, '')
    .replace(/再约时间地点领取[。！？]?/g, '')
    .replace(/联系[^。！？]*领取[。！？]?/g, '')
    .trim();
}

async function callHunyuanVision(imageBase64, hint = '') {
  const categories = Object.keys(CATEGORY_ALIASES).join('、');
  const prompt = [
    '请识别图片中的主要失物或拾物，只返回 JSON，不要输出 Markdown。',
    `category 必须从以下枚举中选择：${categories}、其他。`,
    'JSON 格式：{"itemName":"简短中文物品名","category":"分类","aiTags":["标签1","标签2"],"confidence":0.0,"description":"一句客观物品信息描述"}。',
    'description 只描述物品本身的可见信息，例如颜色、品牌、形状、材质、数量；不要写评论、联系、确认、领取、约时间地点等流程性内容。',
    '如果图片中有多个物体，选择最像用户要发布的那个；不要猜测姓名、学号、手机号等隐私。',
    hint ? `用户已有提示：${hint}` : ''
  ].filter(Boolean).join('\n');

  const response = await postJson(HUNYUAN_API_URL, {
    model: HUNYUAN_VISION_MODEL,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}` } }
        ]
      }
    ],
    temperature: 0.1,
    max_tokens: 300
  }, {
    Authorization: `Bearer ${HUNYUAN_API_KEY}`
  });

  const content = response.choices
    && response.choices[0]
    && response.choices[0].message
    && response.choices[0].message.content;
  return normalizeVisionResult(extractJsonObject(content || ''));
}

function buildImageClassificationResult(classification, hint = '') {
  const trimmedHint = (hint || '').trim();
  const itemName = classification.category === '其他' ? '' : classification.category;
  const title = itemName || (trimmedHint.length <= 18 ? trimmedHint : '');
  return {
    itemName: title,
    title,
    category: classification.category,
    aiTags: ['图片识别'].concat(classification.aiTags || []),
    confidence: classification.confidence,
    description: '',
    provider: 'text-fallback'
  };
}

async function ensureUser(openid, profile = {}) {
  const userResult = await db.collection(COLLECTIONS.users).where({ _openid: openid }).limit(1).get();
  if (userResult.data.length) {
    return userResult.data[0];
  }
  const user = {
    nickName: profile.nickName || '微信用户',
    avatarUrl: profile.avatarUrl || '',
    createdAt: now(),
    updatedAt: now()
  };
  const created = await db.collection(COLLECTIONS.users).add({ data: user });
  return { _id: created._id, _openid: openid, ...user };
}

async function createNotification(userOpenid, type, content, itemId, actorOpenid) {
  return db.collection(COLLECTIONS.notifications).add({
    data: {
      userOpenid,
      type,
      itemId,
      actorOpenid,
      content,
      read: false,
      createdAt: now()
    }
  });
}

async function login(event, context) {
  const user = await ensureUser(context.OPENID, event.profile || {});
  return ok(user);
}

async function listLocations(event) {
  const keyword = (event.keyword || '').trim();
  const query = { enabled: true };
  if (keyword) {
    query.name = db.RegExp({ regexp: keyword, options: 'i' });
  }
  const result = await db.collection(COLLECTIONS.locations).where(query).orderBy('sortOrder', 'asc').get();
  return ok(result.data);
}

async function classifyImage(event) {
  if (IMAGE_PROVIDER !== 'tencent-hunyuan' || !hasHunyuanCredentials() || (!event.fileId && !event.imageBase64)) {
    const classification = classifyByText(event.hint || '');
    return ok(buildImageClassificationResult(classification, event.hint || ''));
  }

  try {
    const imageBase64 = event.imageBase64
      ? normalizeImageBase64(event.imageBase64)
      : await getImageBase64(event.fileId);
    return ok(await callHunyuanVision(imageBase64, event.hint || ''));
  } catch (error) {
    console.warn('Image classification failed:', error.message || error);
    if (isHunyuanConfigError(error)) {
      return fail('腾讯混元 API Key 无效或未授权，请重新配置 HUNYUAN_API_KEY', 'HUNYUAN_AUTH_ERROR');
    }
    const classification = classifyByText(event.hint || '');
    return ok(buildImageClassificationResult(classification, event.hint || ''));
  }
}

async function handleAction(event, context) {
  switch (event.action) {
    case 'login':
      return login(event, context);
    case 'createItem':
      return createItem(event, context);
    case 'classifyImage':
      return classifyImage(event);
    case 'listItems':
      return listItems(event);
    case 'getItemDetail':
      return getItemDetail(event);
    case 'listLocations':
      return listLocations(event);
    case 'createComment':
      return createComment(event, context);
    case 'sendThanks':
      return sendThanks(event, context);
    case 'markReturned':
      return updateReturnStatus(event, context, true);
    case 'undoReturned':
      return updateReturnStatus(event, context, false);
    case 'reportContent':
      return reportContent(event, context);
    default:
      return fail(`未知 action: ${event.action}`);
  }
}

async function createItem(event, context) {
  const payload = event.payload || {};
  if (!(payload.imageUrls || []).length && !payload.category) return fail('请上传图片或选择分类');
  let location = null;
  if (payload.locationId) {
    const locationResult = await db.collection(COLLECTIONS.locations).doc(payload.locationId).get();
    location = locationResult.data;
  }
  const classification = payload.category
    ? { category: payload.category, aiTags: payload.aiTags || [] }
    : classifyByText(`${payload.title} ${payload.description || ''}`);
  const title = (payload.title || '').trim() || classification.category || '未命名物品';
  const data = {
    type: payload.type || 'found',
    title,
    description: payload.description || '',
    category: classification.category,
    aiTags: classification.aiTags,
    imageUrls: payload.imageUrls || [],
    thumbUrl: (payload.imageUrls || [])[0] || '',
    locationId: location ? location._id : '',
    locationName: location ? location.name : '',
    locationDetail: '',
    mapX: location ? location.mapX : null,
    mapY: location ? location.mapY : null,
    status: 'active',
    ownerOpenid: context.OPENID,
    ownerName: payload.ownerName || '微信用户',
    createdAt: now(),
    updatedAt: now()
  };
  data.searchTags = buildItemSearchTags(data);
  const created = await db.collection(COLLECTIONS.items).add({ data });
  return ok({ _id: created._id, ...data });
}

async function listItems(event) {
  const filters = event.filters || {};
  const query = { status: filters.status || 'active' };
  const keyword = (filters.keyword || '').trim();
  if (filters.category && filters.category !== '全部') query.category = filters.category;
  if (filters.locationId) query.locationId = filters.locationId;
  const result = await db.collection(COLLECTIONS.items)
    .where(query)
    .orderBy('createdAt', 'desc')
    .skip(filters.cursor || 0)
    .limit(keyword ? 100 : (filters.limit || 20))
    .get();
  let items = result.data.map((item) => {
    const match = semanticMatchItem(item, keyword);
    return Object.assign({}, item, {
      semanticScore: match.score,
      searchTags: item.searchTags || buildItemSearchTags(item)
    });
  });
  if (keyword) {
    items = items
      .filter((item) => semanticMatchItem(item, keyword).matched)
      .sort((a, b) => (b.semanticScore - a.semanticScore) || (new Date(b.createdAt) - new Date(a.createdAt)))
      .slice(0, filters.limit || 20);
  }
  return ok({ items, nextCursor: (filters.cursor || 0) + items.length });
}

async function getItemDetail(event) {
  const item = await db.collection(COLLECTIONS.items).doc(event.itemId).get();
  const comments = await db.collection(COLLECTIONS.comments)
    .where({ itemId: event.itemId, status: 'active' })
    .orderBy('createdAt', 'asc')
    .get();
  return ok({ item: item.data, comments: comments.data });
}

async function createComment(event, context) {
  const content = (event.content || '').trim();
  if (!content) return fail('评论不能为空');
  if (BAD_WORDS.some((word) => content.includes(word))) return fail('评论包含敏感词');
  const itemResult = await db.collection(COLLECTIONS.items).doc(event.itemId).get();
  const item = itemResult.data;
  const data = {
    itemId: event.itemId,
    authorOpenid: context.OPENID,
    authorName: event.authorName || '微信用户',
    content,
    status: 'active',
    createdAt: now()
  };
  const created = await db.collection(COLLECTIONS.comments).add({ data });
  if (item.ownerOpenid !== context.OPENID) {
    await createNotification(item.ownerOpenid, 'comment', `${data.authorName} 评论了你的帖子：${item.title}`, event.itemId, context.OPENID);
  }
  return ok({ _id: created._id, ...data });
}

async function sendThanks(event, context) {
  const itemResult = await db.collection(COLLECTIONS.items).doc(event.itemId).get();
  const item = itemResult.data;
  if (item.ownerOpenid === context.OPENID) return fail('不能感谢自己发布的帖子');
  const existed = await db.collection(COLLECTIONS.thanks)
    .where({ itemId: event.itemId, fromOpenid: context.OPENID })
    .limit(1)
    .get();
  if (existed.data.length) return ok(existed.data[0]);
  const data = {
    itemId: event.itemId,
    fromOpenid: context.OPENID,
    toOpenid: item.ownerOpenid,
    createdAt: now()
  };
  const created = await db.collection(COLLECTIONS.thanks).add({ data });
  await createNotification(item.ownerOpenid, 'thanks', '有同学感谢了你发布的失物招领线索', event.itemId, context.OPENID);
  return ok({ _id: created._id, ...data });
}

async function updateReturnStatus(event, context, returned) {
  const itemResult = await db.collection(COLLECTIONS.items).doc(event.itemId).get();
  const item = itemResult.data;
  if (item.ownerOpenid !== context.OPENID) return fail('只能操作自己的帖子', 'FORBIDDEN');
  await db.collection(COLLECTIONS.items).doc(event.itemId).update({
    data: {
      status: returned ? 'returned' : 'active',
      returnedAt: returned ? now() : null,
      updatedAt: now()
    }
  });
  return ok({ itemId: event.itemId, status: returned ? 'returned' : 'active' });
}

async function reportContent(event, context) {
  const data = {
    targetType: event.targetType,
    targetId: event.targetId,
    reason: event.reason || '用户举报',
    reporterOpenid: context.OPENID,
    status: 'open',
    createdAt: now()
  };
  const created = await db.collection(COLLECTIONS.reports).add({ data });
  return ok({ _id: created._id, ...data });
}

exports.main = async (event) => {
  const context = cloud.getWXContext();
  try {
    const httpEvent = parseHttpEvent(event);
    if (httpEvent) {
      if (httpEvent.action === '__options') return httpResponse(ok({}));
      if (httpEvent.action === '__bad_request') return httpResponse(fail(httpEvent.message), 400);
      const result = await handleAction(httpEvent, context);
      return httpResponse(result, result.ok ? 200 : 400);
    }
    return handleAction(event, context);
  } catch (error) {
    if (event && (event.httpMethod || typeof event.body !== 'undefined')) {
      return httpResponse(fail(error.message || '服务异常', 'INTERNAL_ERROR'), 500);
    }
    return fail(error.message || '服务异常', 'INTERNAL_ERROR');
  }
};
