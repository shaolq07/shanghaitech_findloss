# Indoor Positioning Setup

The publish page supports a progressive campus location flow:

1. GPS selects nearby ShanghaiTech campus POIs.
2. Optional Wi-Fi/BLE collection adds indoor signal hints.
3. If `TENCENT_MAP_KEY` is configured, `tools/model-proxy` calls Tencent Location Service network positioning at `/ws/location/v1/network`.
4. The UI shows automatic match, accuracy, confidence, and asks the user to confirm before publishing.

## Local Proxy

Mini program config:

```js
const INDOOR_API_URL = 'http://127.0.0.1:8787/indoor-location';
```

Local env:

```env
TENCENT_MAP_KEY=your-tencent-location-service-key
TENCENT_MAP_NETWORK_URL=https://apis.map.qq.com/ws/location/v1/network
```

Start the proxy:

```powershell
cd C:\Users\zhy06\Desktop\上科大ai\shanghaitech_findloss-slqs-branch\tools\model-proxy
npm start
```

## Production

Deploy `tools/model-proxy` to an HTTPS domain, change `INDOOR_API_URL` in `miniprogram/app.js`, and add the domain to the WeChat Mini Program request allowlist.

Do not put Tencent Location Service keys in the mini program frontend.
