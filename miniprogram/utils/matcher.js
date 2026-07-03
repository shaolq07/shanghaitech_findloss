const { classifyByText } = require('./classifier');

const COLOR_WORDS = [
  '黑色', '白色', '红色', '蓝色', '绿色', '黄色', '灰色', '银色', '金色',
  '粉色', '紫色', '棕色', '橙色', '透明', '深蓝', '浅蓝', '米色'
];

const ACCESSORY_WORDS = [
  '钥匙扣', '挂件', '贴纸', '姓名', '学号', 'logo', '标志', '吊牌', '卡套',
  '保护壳', '伞柄', '拉链', '挂绳', '徽章', '刻字', '划痕'
];

const SHAPE_WORDS = ['折叠', '长柄', '圆形', '方形', '透明', '双肩', '手提', '帆布', '皮质'];

function uniq(list) {
  return Array.from(new Set(list.filter(Boolean)));
}

function includesAny(text, words) {
  return words.filter((word) => text.includes(word.toLowerCase()));
}

function tokenize(text = '') {
  return uniq(
    text
      .toLowerCase()
      .replace(/[^\w\u4e00-\u9fa5]+/g, ' ')
      .split(/\s+/)
      .filter((word) => word.length >= 2)
  );
}

function extractItemFeatures(payload = {}) {
  const source = [
    payload.title,
    payload.description,
    payload.category,
    ...(payload.aiTags || []),
    payload.locationName
  ].join(' ').toLowerCase();
  const classification = payload.category
    ? { category: payload.category, aiTags: payload.aiTags || [] }
    : classifyByText(`${payload.title || ''} ${payload.description || ''}`);
  const colors = includesAny(source, COLOR_WORDS);
  const accessories = includesAny(source, ACCESSORY_WORDS);
  const shapes = includesAny(source, SHAPE_WORDS);
  const tokens = tokenize(source);
  const signature = uniq([
    classification.category,
    ...classification.aiTags,
    ...colors,
    ...accessories,
    ...shapes,
    ...tokens
  ]);

  return {
    category: classification.category,
    aiTags: classification.aiTags,
    colors,
    accessories,
    shapes,
    tokens,
    signature,
    imageFingerprint: (payload.imageUrls || []).join('|')
  };
}

function sharedCount(a = [], b = []) {
  const target = new Set(b);
  return a.filter((entry) => target.has(entry)).length;
}

function sharedValues(a = [], b = []) {
  const target = new Set(b);
  return a.filter((entry) => target.has(entry));
}

function getFeatureText(payload = {}) {
  return [
    payload.title,
    payload.description,
    payload.category,
    payload.locationName,
    ...(payload.aiTags || []),
    ...(payload.semanticTags || [])
  ].join(' ').toLowerCase();
}

function compactLocationName(name = '') {
  const text = String(name);
  if (!text) return '';
  if (/餐厅|食堂|dining/i.test(text)) return '餐厅附近';
  if (/图书馆|library/i.test(text)) return '图书馆附近';
  if (/宿舍|公寓/i.test(text)) return '宿舍附近';
  if (/体育|运动/i.test(text)) return '体育馆附近';
  if (/学院|教学楼|中心|研究所|校门/i.test(text)) return `${text.replace(/（.*?）/g, '')}附近`;
  return `${text}附近`;
}

function formatTimeGap(leftTime, rightTime) {
  const left = new Date(leftTime).getTime();
  const right = new Date(rightTime).getTime();
  if (!left || !right) return '';
  const diff = Math.abs(left - right);
  const hour = 60 * 60 * 1000;
  const day = 24 * hour;
  if (diff <= 2 * hour) return '发布时间接近';
  if (diff <= day) return '发布时间接近';
  if (diff <= 7 * day) return '发布时间接近';
  return '';
}

function buildHumanReasons(query = {}, candidate = {}, queryFeatures = {}, candidateFeatures = {}) {
  const reasons = [];
  const queryText = getFeatureText(query);
  const candidateText = getFeatureText(candidate);
  const colors = sharedValues(queryFeatures.colors, candidateFeatures.colors);
  const accessories = sharedValues(queryFeatures.accessories, candidateFeatures.accessories);
  const shapes = sharedValues(queryFeatures.shapes, candidateFeatures.shapes);

  if (queryFeatures.category && queryFeatures.category === candidateFeatures.category) {
    const color = colors[0] || '';
    reasons.push(`同为${color}${queryFeatures.category}`);
  }

  const accessoryReason = accessories.find((accessory) => {
    return colors.some((color) => queryText.includes(`${color}${accessory}`) && candidateText.includes(`${color}${accessory}`));
  });
  if (accessoryReason) {
    const color = colors.find((entry) => queryText.includes(`${entry}${accessoryReason}`) && candidateText.includes(`${entry}${accessoryReason}`));
    reasons.push(`${color}${accessoryReason}`);
  } else if (accessories.length) {
    reasons.push(accessories.slice(0, 2).join('、'));
  }

  if (query.locationId && candidate.locationId && query.locationId === candidate.locationId) {
    reasons.push(compactLocationName(candidate.locationName || query.locationName));
  } else if (query.locationName && candidate.locationName) {
    const queryLocation = compactLocationName(query.locationName);
    const candidateLocation = compactLocationName(candidate.locationName);
    if (queryLocation && queryLocation === candidateLocation) reasons.push(candidateLocation);
  }

  const timeReason = formatTimeGap(query.createdAt, candidate.createdAt);
  if (timeReason) reasons.push(timeReason);

  if (shapes.length && reasons.length < 4) {
    reasons.push(`${shapes.slice(0, 2).join('、')}外观相似`);
  }

  if (!reasons.length) {
    const sharedTags = sharedValues(queryFeatures.signature, candidateFeatures.signature)
      .filter((tag) => tag !== queryFeatures.category)
      .slice(0, 2);
    if (sharedTags.length) reasons.push(`标签相似：${sharedTags.join('、')}`);
  }

  return uniq(reasons).slice(0, 4);
}

function scoreFeatureMatch(query = {}, candidate = {}) {
  const queryFeatures = query.matchFeatures || extractItemFeatures(query);
  const candidateFeatures = candidate.matchFeatures || extractItemFeatures(candidate);
  let score = 0;

  if (queryFeatures.category && queryFeatures.category === candidateFeatures.category) {
    score += 28;
  }

  const colorHits = sharedCount(queryFeatures.colors, candidateFeatures.colors);
  if (colorHits) {
    score += Math.min(colorHits * 14, 22);
  }

  const accessoryHits = sharedCount(queryFeatures.accessories, candidateFeatures.accessories);
  if (accessoryHits) {
    score += Math.min(accessoryHits * 22, 28);
  }

  const shapeHits = sharedCount(queryFeatures.shapes, candidateFeatures.shapes);
  if (shapeHits) {
    score += Math.min(shapeHits * 10, 16);
  }

  const semanticHits = sharedCount(queryFeatures.signature, candidateFeatures.signature);
  if (semanticHits) score += Math.min(semanticHits * 4, 18);

  if (query.locationId && candidate.locationId && query.locationId === candidate.locationId) {
    score += 10;
  }

  if (queryFeatures.imageFingerprint && candidateFeatures.imageFingerprint) {
    score += 8;
  }

  return {
    similarity: Math.min(score, 99),
    reasons: buildHumanReasons(query, candidate, queryFeatures, candidateFeatures),
    queryFeatures,
    candidateFeatures
  };
}

module.exports = {
  extractItemFeatures,
  scoreFeatureMatch,
  tokenize
};
