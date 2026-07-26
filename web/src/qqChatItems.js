import bookImage from './assets/items/qq/book-tc304.png';
import campusCardImage from './assets/items/qq/campus-card-redacted.png';
import earbudsImage from './assets/items/qq/earbuds-concert.jpg';
import labReportImage from './assets/items/qq/lab-report-redacted.png';
import phoneBackImage from './assets/items/qq/phone-back.jpg';
import phoneFrontOffImage from './assets/items/qq/phone-front-off.jpg';
import phoneFrontOnImage from './assets/items/qq/phone-front-on.jpg';
import takeawayImage from './assets/items/qq/takeaway-locker.png';

const qqSource = (authorAlias, sentAt, message) => ({
  channel: 'QQ群',
  groupId: '731332881',
  authorAlias,
  sentAt,
  message,
  analysisStatus: 'pending'
});

export const qqChatItems = [
  {
    id: 'qq_731332881_20260717_earbuds',
    type: 'found',
    title: '音乐会现场发现的浅色无线耳机',
    description: '群友在当晚音乐会现场发现一副浅色真无线耳机和充电盒，原消息为“今晚音乐会谁拉这了”。',
    category: '电子产品',
    tags: ['无线耳机', '充电盒', '音乐会'],
    image: earbudsImage,
    images: [earbudsImage],
    locationId: 'music-venue',
    exactLocation: '当晚音乐会现场',
    ownerName: '寻樱',
    status: 'active',
    createdAt: '2026-07-17T20:40:50+08:00',
    source: qqSource('寻樱', '2026-07-17T20:40:50+08:00', '今晚音乐会谁拉这了')
  },
  {
    id: 'qq_731332881_20260709_book',
    type: 'found',
    title: 'TC304 最后一排的《研究是一门艺术》',
    description: '群友在 TC304 最后一排发现一本《研究是一门艺术》第 4 版。',
    category: '书本资料',
    tags: ['书本', '研究是一门艺术', 'TC304'],
    image: bookImage,
    images: [bookImage],
    locationId: 'teaching',
    exactLocation: '教学中心 TC304 最后一排',
    ownerName: '风残云涌',
    status: 'active',
    createdAt: '2026-07-09T10:22:53+08:00',
    source: qqSource('风残云涌', '2026-07-09T10:22:53+08:00', 'tc304最后一排')
  },
  {
    id: 'qq_731332881_20260708_phone',
    type: 'found',
    title: '菜鸟驿站拆包区的白色手机',
    description: '群友在菜鸟驿站拆快递的地方发现一部无人认领的白色手机，手机留在原处未移动。',
    category: '电子产品',
    tags: ['白色手机', '手机壳', '菜鸟驿站'],
    image: phoneBackImage,
    images: [phoneBackImage, phoneFrontOffImage, phoneFrontOnImage],
    locationId: 'cainiao',
    exactLocation: '菜鸟驿站拆快递处，物品仍在原处',
    ownerName: '元橅道人',
    status: 'active',
    createdAt: '2026-07-08T22:38:34+08:00',
    source: qqSource(
      '元橅道人',
      '2026-07-08T22:38:34+08:00',
      '菜鸟驿站拆快递的地方，有一部无人认领的手机；放在原处没有动'
    )
  },
  {
    id: 'qq_731332881_20260707_lab_report',
    type: 'found',
    title: '散落在路上的实验报告',
    description: '群友发现多张实验报告散落在路上，担心被风吹散，已经交至大道书院宿管处。',
    category: '书本资料',
    tags: ['实验报告', '资料', '大道书院'],
    image: labReportImage,
    images: [labReportImage],
    locationId: 'dao-college',
    exactLocation: '已交至大道书院宿管处',
    ownerName: '斗转星移',
    status: 'active',
    createdAt: '2026-07-07T12:38:08+08:00',
    privacyRedacted: true,
    source: qqSource(
      '斗转星移',
      '2026-07-07T12:38:08+08:00',
      '路上见到了好几张王同学的实验报告，我怕被风再吹散了，现已交至大道书院宿管处'
    )
  },
  {
    id: 'qq_731332881_20260706_campus_card',
    type: 'found',
    title: '教学中心 304 的校园卡',
    description: '群友在教学中心 304 讲台发现一张上海科技大学联名校园卡。',
    category: '校园卡',
    tags: ['校园卡', '教学中心', '304'],
    image: campusCardImage,
    images: [campusCardImage],
    locationId: 'teaching',
    exactLocation: '教学中心 304 讲台',
    ownerName: '芥芥芥芥',
    status: 'active',
    createdAt: '2026-07-06T14:48:42+08:00',
    privacyRedacted: true,
    source: qqSource('芥芥芥芥', '2026-07-06T14:48:42+08:00', '教学中心304讲台')
  },
  {
    id: 'qq_731332881_20260626_takeaway',
    type: 'found',
    title: '快递柜旁疑似被拿错的外卖',
    description: '群友发图询问“谁拿错外卖了”，并请拿错的同学尽快联系。',
    category: '其他',
    tags: ['外卖', '拿错', '快递柜'],
    image: takeawayImage,
    images: [takeawayImage],
    locationId: 'pickup-lockers',
    exactLocation: '群聊图片中的取件柜旁',
    ownerName: '去追一只鹿',
    status: 'active',
    createdAt: '2026-06-26T17:43:04+08:00',
    source: qqSource('去追一只鹿', '2026-06-26T17:43:04+08:00', '谁拿错外卖了；拿错的同学马上联系我')
  }
];
