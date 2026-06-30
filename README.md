# shanghaitech失物招领

这是一个从零搭建的微信小程序云开发 MVP，面向校园失物招领互助场景。项目默认带本地 mock 数据，可以不配置云环境先在微信开发者工具里预览核心流程。

## 功能

- 微信一键登录的轻注册体验。
- 发布失物/拾物线索，支持图片、地点、详情描述和分类。
- 标题/描述本地模拟 AI 分类，云函数支持腾讯云混元视觉模型自动提取物品。
- 查找页按分类浏览，地图页在小程序内展示上科大地点 pin 点，不跳转外部网页。
- 详情页支持评论、感谢、举报、标记“已回家”和撤回。
- 已找到分区、消息中心、我的发布。

## 如何打开

1. 打开微信开发者工具。
2. 导入本目录：`outputs/shanghaitech-lost-found-miniprogram`。
3. AppID 可先选择测试号，或替换 `project.config.json` 里的 `appid`。
4. 如果暂不启用云开发，直接编译即可使用本地 mock 数据。
5. 若启用云开发，把 `miniprogram/app.js` 中的 `replace-with-your-cloud-env-id` 改成你的云环境 ID。

## 云开发部署

1. 在云开发控制台创建集合：
   - `users`
   - `items`
   - `comments`
   - `thanks`
   - `notifications`
   - `reports`
   - `campus_locations`
2. 将 `database.seed.json` 中的 `campus_locations` 导入到同名集合。
3. 上传并部署云函数 `cloudfunctions/lostfound`，安装依赖。
4. 云函数统一使用 `action` 字段分发：
   - `login`
   - `createItem`
   - `classifyImage`
   - `listItems`
   - `getItemDetail`
   - `listLocations`
   - `createComment`
   - `sendThanks`
   - `markReturned`
   - `undoReturned`
   - `reportContent`

## 配置云端图像识别

云函数 `classifyImage` 已接入腾讯云混元 OpenAI 兼容视觉接口：

- 将图片以 base64 形式发送给视觉模型。
- 要求模型返回结构化 JSON：物品名、分类、标签、置信度和招领描述。
- 分类固定为：证件、电子产品、书本资料、衣物、钥匙、校园卡、雨伞、水杯、其他。
- 未配置 API Key 或识别失败时自动回退到文字兜底分类，前端仍允许用户手动修改。

配置步骤：

1. 在腾讯云控制台开通混元模型服务，并创建 API Key。
2. 在微信云开发控制台给 `lostfound` 云函数配置环境变量：
   - `IMAGE_RECOGNITION_PROVIDER=tencent-hunyuan`
   - `HUNYUAN_API_KEY=你的 sk-... API Key`
   - `HUNYUAN_API_URL=https://api.hunyuan.cloud.tencent.com/v1/chat/completions`
   - `HUNYUAN_VISION_MODEL=hunyuan-vision`
3. 在 `cloudfunctions/lostfound` 目录执行 `npm install`，或在微信开发者工具中勾选“上传并部署：云端安装依赖”。
4. 重新上传并部署 `lostfound` 云函数。

注意：不要把 API Key 写进前端或提交到仓库，只放在云函数环境变量里。

## 重要说明

- 地图 tab 使用小程序原生地图展示校内地点和线索数量，不再依赖外部 `web-view` 域名。
- 第一版通知采用站内消息；真实微信订阅消息可在 `sendThanks` 和 `createComment` 后追加发送逻辑。
- 页面默认走本地 `utils/store.js`，这样无云环境也能演示；正式版可将 store 方法逐步替换为 `wx.cloud.callFunction({ name: 'lostfound', data: { action, ... } })`。
