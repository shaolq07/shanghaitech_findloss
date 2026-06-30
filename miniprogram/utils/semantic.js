const TAG_GROUPS = [
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

const IGNORED_TAGS = {
  '图片识别': true,
  '图片自动识别': true,
  '图片待识别': true,
  '手动校正': true,
  '待确认': true
};

function normalizeText(value = '') {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[，。！？、；：,.!?;:()[\]{}"'“”‘’/\\|-]/g, ' ')
    .replace(/\s+/g, ' ');
}

function unique(values) {
  const seen = {};
  return values
    .map((value) => String(value || '').trim())
    .filter((value) => {
      if (!value || seen[value]) return false;
      seen[value] = true;
      return true;
    });
}

function tokenizeText(value = '') {
  const normalized = normalizeText(value);
  const tokens = normalized.match(/[a-z0-9]+|[\u4e00-\u9fa5]{1,8}/g) || [];
  return tokens.filter((token) => token.length > 1 || /[\u4e00-\u9fa5]/.test(token));
}

function expandSemanticTerms(values = []) {
  const source = normalizeText(values.join(' '));
  const terms = [];

  values.forEach((value) => {
    if (!IGNORED_TAGS[value]) terms.push(value);
    terms.push.apply(terms, tokenizeText(value));
  });

  TAG_GROUPS.forEach((group) => {
    if (group.some((term) => source.includes(normalizeText(term)))) {
      terms.push.apply(terms, group);
    }
  });

  return unique(terms);
}

function getMatchedGroups(value = '') {
  const source = normalizeText(value);
  return TAG_GROUPS.filter((group) => group.some((term) => source.includes(normalizeText(term))));
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

  return expandSemanticTerms(baseValues).slice(0, 60);
}

function semanticMatchItem(item = {}, keyword = '') {
  const query = normalizeText(keyword);
  if (!query) return { matched: true, score: 0 };

  const queryTerms = expandSemanticTerms([keyword]);
  const queryGroups = getMatchedGroups(keyword);
  const itemTags = item.searchTags && item.searchTags.length ? item.searchTags : buildItemSearchTags(item);
  const itemText = normalizeText([
    item.title,
    item.description,
    item.category,
    item.locationName,
    item.locationDetail
  ].concat(item.aiTags || [], itemTags || []).join(' '));

  if (queryGroups.length > 1) {
    const hasAllGroups = queryGroups.every((group) => group.some((term) => itemText.includes(normalizeText(term))));
    if (!hasAllGroups) return { matched: false, score: 0 };
  }

  let score = itemText.includes(query) ? 10 : 0;
  queryTerms.forEach((term) => {
    const normalized = normalizeText(term);
    if (!normalized) return;
    if (itemText.includes(normalized)) score += 2;
    if ((itemTags || []).some((tag) => normalizeText(tag) === normalized)) score += 3;
  });

  return { matched: score > 0, score };
}

module.exports = {
  buildItemSearchTags,
  expandSemanticTerms,
  semanticMatchItem
};
