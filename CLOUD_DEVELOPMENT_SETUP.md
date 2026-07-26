# WeChat CloudBase Setup

Mini program cloud environment:

```text
cloud1-d9gnyuxf5b44b6b92
```

The mini program now calls `cloudfunctions/lostfound` for image recognition when this value in `miniprogram/app.js` is empty:

```js
const MODEL_API_URL = '';
```

## Cloud Function Environment Variables

Configure these variables in the WeChat DevTools CloudBase console for `cloudfunctions/lostfound`.

```env
TENCENT_SECRET_ID=your-secret-id
TENCENT_SECRET_KEY=your-secret-key
HUNYUAN_MODEL=hunyuan-vision
TENCENT_HUNYUAN_ENDPOINT=https://hunyuan.tencentcloudapi.com
QQ_REVIEW_GROUP_IDS=731332881
QQ_INGEST_TOKEN=generate-a-long-random-secret
QQ_REVIEW_ADMIN_TOKEN=generate-a-different-long-random-secret
```

Optional OpenAI-compatible Hunyuan mode:

```env
HUNYUAN_API_KEY=your-sk-api-key
HUNYUAN_BASE_URL=https://api.hunyuan.cloud.tencent.com/v1
HUNYUAN_MODEL=hunyuan-vision
```

If both Tencent Cloud `SecretId/SecretKey` and `HUNYUAN_API_KEY` exist, the cloud function prefers Tencent Cloud signed API calls.

## Deploy

1. Open the project in WeChat DevTools.
2. Make sure CloudBase environment is `cloud1-d9gnyuxf5b44b6b92`.
3. Right-click `cloudfunctions/lostfound`.
4. Choose `Upload and deploy: cloud install dependencies`.
5. Recompile the mini program and test image recognition.

## QQ review queue

Create a private collection named `qq_review_queue`. It must not allow direct client reads or writes; all access goes through the `lostfound` cloud function.

After deploying the event function, create an HTTP access-service route that points `/qq-ingest` to `lostfound`:

```powershell
tcb service create -p qq-ingest -f lostfound -e cloud1-d9gnyuxf5b44b6b92
```

The local QQ archive process posts only production group `731332881` to this route. Set its `QQ_CLOUD_INGEST_URL` and `QQ_CLOUD_INGEST_TOKEN` process variables as documented in `qq-archive/README.md`.

The moderation page is:

```text
https://lockmyitem.asia/review
```

Enter `QQ_REVIEW_ADMIN_TOKEN` there. The token is kept in browser `sessionStorage`, so closing the tab session clears it. Queue records stay `pending` until an administrator approves or rejects them. Approval creates a public item with cloud-storage image file IDs; rejection never creates a public item.

## Timeout

Image recognition calls can take more than the CloudBase default 3 seconds. The project includes:

```text
cloudfunctions/lostfound/config.json
```

with:

```json
{
  "timeout": 30,
  "memorySize": 512
}
```

If the CloudBase console still reports `FUNCTIONS_TIME_LIMIT_EXCEEDED`, open `lostfound` in the CloudBase console and set the function timeout to 30 seconds manually, then deploy again.

## Test classifyImage

Use a direct image URL that can be downloaded by Tencent Cloud. Do not use search result pages such as Bing Image detail URLs. Some school website assets may return `403 Forbidden` to cloud-side requests and will be rejected by Hunyuan as invalid images.

Cloud function test event:

```json
{
  "action": "classifyImage",
  "imageUrl": "https://raw.githubusercontent.com/shaolq07/shanghaitech_findloss/main/web/src/assets/items/umbrella.jpg",
  "hint": "雨伞，校园失物招领图片识别测试"
}
```

Expected result:

```json
{
  "ok": true,
  "data": {
    "category": "雨伞",
    "aiTags": [],
    "visualDescription": "",
    "yoloObjects": [],
    "semanticTags": [],
    "modelSources": {}
  }
}
```

Do not commit real API keys. Keep them only in CloudBase environment variables.
