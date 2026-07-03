# 腾讯云混元图像识别接入说明

当前小程序支持两种图像识别链路：

1. **普通 HTTPS 模型接口优先**：在 `miniprogram/app.js` 填写 `MODEL_API_URL` 后，小程序会把图片压缩为 base64，直接 `wx.request` 到该接口，不再依赖微信云开发。
2. **微信云函数兜底**：未配置 `MODEL_API_URL` 时，才走 `cloudfunctions/lostfound` 调用腾讯云混元。

不建议把 OpenAI、Gemini、通义、混元等模型 API Key 直接写进小程序前端；请放在你的 HTTPS 模型接口服务端。

## 非微信云开发 HTTP 接口

在 `miniprogram/app.js` 配置：

```js
const MODEL_API_URL = 'https://your-domain.example.com/lostfound-vision';
```

小程序会向该 URL 发送：

```json
{
  "imageBase64": "图片 base64，不带 data:image 前缀",
  "mimeType": "image/jpeg",
  "hint": "用户填写的标题、描述、分类和已有标签"
}
```

接口返回以下任一格式都可以：

```json
{
  "ok": true,
  "data": {
    "category": "雨伞",
    "aiTags": ["雨伞", "黑色", "折叠", "红色钥匙扣"],
    "semanticTags": ["雨伞", "折叠", "红色钥匙扣"],
    "visualDescription": "黑色折叠雨伞，伞柄处有红色钥匙扣。",
    "yoloObjects": []
  }
}
```

也可以直接返回 `data` 里的对象。小程序会自动兼容 `description/tags/colors/accessories/objects` 等常见字段。

## 云函数环境变量

在微信云开发控制台给 `cloudfunctions/lostfound` 配置：

```text
HUNYUAN_API_KEY=腾讯云混元 API Key
# 如果旧环境已配置 TENCENTCLOUD_API_KEY，也会自动兼容读取
HUNYUAN_MODEL=hunyuan-vision
HUNYUAN_BASE_URL=https://api.hunyuan.cloud.tencent.com/v1
```

说明：

- `HUNYUAN_API_KEY`：从腾讯云混元控制台/API Key 管理页面获取。
- `TENCENTCLOUD_API_KEY`：兼容旧配置；如果已配置该变量，可不重复配置。
- `HUNYUAN_MODEL`：默认使用视觉多模态模型，可按腾讯云控制台可用模型调整。
- `HUNYUAN_BASE_URL`：默认是腾讯云混元 OpenAI 兼容接口，一般不用改。
- `MODEL_API_KEY`：仅作为旧配置兼容备用，不建议新配置继续使用。
- 不再需要 `YOLO_API_URL`、`SEMANTIC_API_URL`、`YOLO_MODEL` 或自建 `model-service`。

## 调用链路

1. 小程序上传图片到微信云存储。
2. 云函数通过 `cloud.getTempFileURL` 获取图片临时 HTTPS 链接；如果云存储上传失败，前端会压缩图片并以 `imageBase64` 方式直传云函数兜底识别。
3. 云函数调用混元 `/chat/completions`，传入 `image_url` 和用户填写的标题/描述作为 hint。
4. 混元返回 JSON：类别、标签、颜色、配件、自然语言描述。
5. 云函数把结果写回发布表单字段，用于后续相似物品匹配。

## 混元返回 JSON 约定

云函数会要求模型只返回 JSON：

```json
{
  "description": "黑色折叠雨伞，伞柄处有红色钥匙扣。",
  "category": "雨伞",
  "tags": ["雨伞", "黑色", "折叠", "红色钥匙扣"],
  "colors": ["黑色", "红色"],
  "accessories": ["钥匙扣"]
}
```

## 云函数最终返回

`classifyImage` 会返回：

```json
{
  "ok": true,
  "data": {
    "category": "雨伞",
    "aiTags": ["雨伞", "黑色", "折叠", "红色钥匙扣"],
    "yoloObjects": [],
    "semanticTags": ["雨伞", "折叠", "红色钥匙扣"],
    "visualDescription": "黑色折叠雨伞，伞柄处有红色钥匙扣。",
    "imageEmbedding": [],
    "semanticEmbedding": [],
    "modelSources": {
      "provider": "tencent-hunyuan",
      "baseUrl": "https://api.hunyuan.cloud.tencent.com/v1",
      "model": "hunyuan-vision"
    }
  }
}
```

前端会把这些字段写入发布表单，并用于后续相似物品检索。`yoloObjects` 仍保留为空数组，是为了兼容之前已经写好的前端字段。
