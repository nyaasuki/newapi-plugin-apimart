# newapi-plugin-apimart

A [New API](https://github.com/QuantumNous/new-api) task plugin that connects APIMart's **GPT-Image-2.5** image models (`gpt-image-2.5-flare`, `gpt-image-2.5-sunburst`) to your own New API instance.

把 APIMart 的 GPT-Image-2.5 图像接口接入你自己的 New API 站点的任务插件。APIMart 的接口是异步的（先返回 `task_id`，再轮询 `/v1/tasks/{id}`），本插件让 New API 在请求内部完成轮询，客户端直接用标准 OpenAI 图片接口即可拿到图片。

> ⚠️ New API 的任务插件系统（v1.0.0-rc.27 起）目前仍是实验性功能，官方不建议用于生产环境。请先在测试实例上验证。

## 功能

- **OpenAI 兼容图片接口**：`POST /v1/images/generations`、`POST /v1/images/edits`，同步返回 `{created, data: [{url}]}`，支持 `response_format: "b64_json"`（由 New API 下载图片后补上 Base64）。
- **通用异步任务接口**：`POST /v1/tasks/apimart` 提交，`GET /v1/tasks/{id}` 查询，`GET /v1/tasks/{id}/artifacts` 获取图片。
- **透传 APIMart 参数**：`size`（比例 / 精确像素 / `auto`）、`resolution`（1k/2k/4k）、`quality`（low ~ max）、`n`（1~4）、`output_format`、`output_compression`、`background`、`moderation`、`image_urls`（最多 16 张）、`mask_url`。
- **兼容常见 OpenAI 写法**：`quality: "standard"/"hd"` 映射为 `medium`/`high`；`image`、`images: [{image_url}]` 视为参考图。
- **按 token 计费**：提交时按 APIMart 官方输出 token 参考表预扣，完成后按 APIMart 返回的真实 `usage` 结算，失败自动退款。
- 提交前本地校验参数（尺寸规则、透明背景格式、参考图数量等），错误不会产生上游费用。

## 安装

1. 用 Root 账号登录 New API，打开「任务插件」（`/task-plugins`），打开顶部总开关。
2. 选择「导入」，填入插件地址：

   ```
   https://raw.githubusercontent.com/<OWNER>/<REPO>/main/plugin.js
   ```

   也可以下载 `plugin.js` 后上传本地文件或粘贴源码。安装前请自行检查源码。
3. 启用插件。

## 配置渠道

1. 新建渠道，类型选 **任务插件**，绑定插件 `apimart`。
2. Base URL 留空即使用默认 `https://api.apimart.ai`（带不带 `/v1` 都可以）。
3. 密钥填你的 APIMart API Key。
4. 模型填 `gpt-image-2.5-flare`、`gpt-image-2.5-sunburst`。想对外用别的名字，可以用渠道的模型重定向，例如 `{"gpt-image-2.5": "gpt-image-2.5-flare"}`。

## 设置价格

插件上报两个 token 用量字段：

| 字段 | 含义 | APIMart 官方单价（每百万 token） |
|---|---|---|
| `input_tokens` | 输入 token（文本 + 参考图） | 文本 $5，图片 $8 |
| `output_tokens` | 输出图片 token | $30 |

APIMart 返回的 `input_tokens` 不区分文本和图片，所以输入单价建议：只做文生图填 **$5/M**；有图生图需求填 **$8/M**（偏保守）。再按你自己的倍率加价。

在「模型价格」里找到这两个模型，用任务用量价格编辑器分别填输入、输出单价（编辑器中 token 单价按每百万显示）。保存前对照插件提供的用量示例（如 `1:1 · 1K · medium` 输出 439 token）核对一次费用。

也可以不按 token，改用**按次计费**：插件在按次模式下按请求张数 `n` 作为倍率。

> 预扣说明：`quality` 不传或为 `auto` 时，按该尺寸最高档 `max` 预扣，完成后按实际用量退差额。余额紧张的用户建议显式指定 `quality`。

## 调用示例

文生图（OpenAI 格式，同步返回）：

```bash
curl https://your-newapi.example/v1/images/generations \
  -H "Authorization: Bearer $NEW_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-image-2.5-flare",
    "prompt": "雨天窗边温暖舒适的阅读角，暖色台灯，电影感光影",
    "size": "16:9",
    "resolution": "2k",
    "quality": "high"
  }'
```

图生图 / 局部重绘：

```bash
curl https://your-newapi.example/v1/images/edits \
  -H "Authorization: Bearer $NEW_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-image-2.5-sunburst",
    "prompt": "仅将透明蒙版覆盖的区域替换为金色丝带",
    "image_urls": ["https://example.com/product.png"],
    "mask_url": "https://example.com/product-mask.png",
    "quality": "xhigh"
  }'
```

异步方式：

```bash
curl https://your-newapi.example/v1/tasks/apimart \
  -H "Authorization: Bearer $NEW_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model": "gpt-image-2.5-flare", "prompt": "极简风格的产品发布会主视觉", "size": "1600x1200"}'

curl https://your-newapi.example/v1/tasks/<task_id> -H "Authorization: Bearer $NEW_API_KEY"
curl https://your-newapi.example/v1/tasks/<task_id>/artifacts -H "Authorization: Bearer $NEW_API_KEY"
```

## 限制与注意事项

- **参考图必须是公网 URL。** APIMart 的 `image_urls` 只接受可直接下载的 http(s) 地址，所以 `/v1/images/edits` 用 multipart 上传本地图片文件会被拒绝，请改为在 `image_urls` 中传链接。蒙版例外：可以传 URL、`data:image/png;base64,...`，或在 multipart 中上传 `mask` 文件（≤4MB，需带 Alpha 通道的 PNG，尺寸与第一张参考图一致）。
- **等待时间。** OpenAI 图片接口会在请求内等待结果，超过 `TASK_PLUGIN_PROTOCOL_TIMEOUT_SECONDS`（默认 600 秒）返回 504，但任务仍会在后台完成并结算。高分辨率加 `max` 档可能较慢，客户端和反向代理的超时也要调大。
- **图片链接是临时的。** 返回的 URL 来自 APIMart，有过期时间，请及时下载；需要长期保存可让客户端使用 `response_format: "b64_json"`。
- **产物下载**依赖 `upload.apimart.ai`（已在插件的 `allowedHosts` 中声明）。如果 APIMart 改用其他图片域名，`/v1/tasks/{id}/artifacts/.../content` 会失败，需要更新插件。
- 不支持流式（`stream: true`）。

## 开发与测试

```bash
node test/run.mjs      # 各钩子的本地测试
node test/golden.mjs   # 用本地脚本回放 golden.json

# 在装有 New API 可执行文件的机器上，用官方 CLI 校验：
new-api plugin lint plugin.js
new-api plugin test plugin.js --fixture golden.json
```

## License

MIT
