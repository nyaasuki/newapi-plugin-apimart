# newapi-plugin-apimart

A [New API](https://github.com/QuantumNous/new-api) task plugin that connects APIMart's image models (GPT-Image, Nano Banana, Imagen, Seedream, FLUX, Qwen, Wan, Grok Imagine and more) to your own New API instance.

把 APIMart 图像系列模型接入你自己的 New API 站点的任务插件。APIMart 的图片接口是异步的：提交后先返回 `task_id`，再轮询 `/v1/tasks/{id}` 取结果。本插件让 New API 在请求内部完成轮询，客户端用标准 OpenAI 图片接口就能直接拿到图片。

> ⚠️ New API 的任务插件系统（v1.0.0-rc.27 起引入）仍是实验性功能，官方不建议直接用于生产环境，请先在测试实例上验证。1.1.0 用到了按模型区分计费配置（`usageProfiles`），需要支持该功能的 New API 版本。

## 功能

- **OpenAI 兼容图片接口**：`POST /v1/images/generations`、`POST /v1/images/edits`，同步返回 `{created, data: [{url}]}`；传 `response_format: "b64_json"` 时，由 New API 下载图片后补上 Base64。
- **通用异步任务接口**：`POST /v1/tasks/apimart` 提交，`GET /v1/tasks/{id}` 查询，`GET /v1/tasks/{id}/artifacts` 获取图片。
- **按模型校验参数**：每个模型有自己的比例、分辨率档位、张数、参考图数量等规则，提交前在本地校验，不合法的请求不会产生上游费用。只转发该模型支持的字段，`user`、`style` 这类客户端附带的字段会被静默丢弃。
- **兼容 OpenAI 写法**：
  - 只支持比例的模型收到 `1024x1024` 这类像素尺寸时，会换成最接近的支持比例，并选择能覆盖该像素数的分辨率档位。
  - `quality: "standard"/"hd"` 映射为 `medium`/`high`。
  - `image`、`images: [{image_url}]` 视为参考图。
  - 用 `aspect_ratio` 字段的模型（FLUX 3、Grok Imagine）也接受 `size`。
- **计费**：GPT-Image-2.5 和 `gpt-image-2-official` 按 token 计费，其他模型按张计费。提交时预扣，完成后按实际结果结算，任务失败自动退款。

## 支持的模型

| 系列 | 模型名 | 说明 |
|---|---|---|
| GPT-Image-2.5 | `gpt-image-2.5-flare`、`gpt-image-2.5-sunburst` | 按 token。比例 / 精确像素 / auto，`resolution` 1k/2k/4k，`quality` low~max，n 1~4，参考图 ≤16（仅 URL），支持蒙版 |
| GPT-Image-2.5 Ext | `gpt-image-2.5-ext` | `version`: flare/sunburst，`resolution` 1K/2K/4K，n 1~4，参考图 ≤16 |
| GPT-Image-2 | `gpt-image-2`、`gpt-image-2-ext` | 比例 / 像素 / auto，`resolution` 1k/2k/4k，参考图 ≤15 |
| GPT-Image-2 官方 | `gpt-image-2-official` | 按 token。`quality` auto/low/medium/high，n 1~4，参考图 ≤16（仅 URL），支持蒙版 |
| GPT-Image 1/1.5 | `gpt-image-1-official`、`gpt-image-1.5-official` | 尺寸只有 1:1/3:2/2:3，`quality`，透明背景，n 1~4，参考图 ≤15（仅 URL），支持蒙版 |
| Nano banana 2.1 | `gemini-nano-banana-2.1`（官方版，n 1~4）、`gemini-nano-banana-2.1-ext` | 14 种比例，1K/2K/4K |
| Nano banana2 | `gemini-3.1-flash-image-preview`（`nano-banana-2-ext`）、`gemini-3.1-flash-image-preview-official`（`nano-banana-2`） | 14 种比例，0.5K~4K，`google_search`，参考图 ≤14 |
| Nano banana Lite | `gemini-3.1-flash-lite-image`（`nano-banana-2-lite`）、`-ext`（`nano-banana-2-lite-ext`） | 仅 1K，n 1~4 |
| Nano banana Pro | `gemini-3-pro-image-preview`（`nano-banana-pro-ext`）、`-official`（`nano-banana-pro`） | 1K/2K/4K，参考图 ≤14 |
| Nano banana | `gemini-2.5-flash-image-preview`（`nano-banana-ext`）、`-official`（`nano-banana`） | 仅 1K |
| Imagen 4.0 | `imagen-4.0-apimart` | 仅文生图，5 种比例 |
| Seedream | `seedream-4.0`、`seedream-4.5`、`seedream-5-0-lite` | 组图（n 最多 15），1K~4K（各版本档位不同） |
| Seedream 5.0 | `seedream-5-0-pro`、`seedream-5-0-flash` | 单张，1K/1.5K/2K 或精确像素，透明背景，图层拆分（`layer_decomposition`） |
| FLUX Kontext | `flux-kontext-pro`、`flux-kontext-max` | 约 1MP 固定输出，参考图 ≤4 |
| FLUX 2 | `flux-2-flex`、`flux-2-pro`、`flux-2-max` | `resolution` 1MP~4MP 或精确像素，参考图 ≤8 |
| FLUX 3 | `flux-3-image`、`flux-3-image-klein` | `aspect_ratio`，`resolution` 768sq~4k，参考图 ≤10 |
| Hy-Image | `hy-image-v3.5-preview` | 1K/2K/4K 或精确像素，参考图 ≤5（仅 URL） |
| MAI-Image | `mai-image-2.6`、`mai-image-2.6-flash` | 1K/2K 或精确像素，参考图 ≤5 |
| Qwen Image | `qwen-image-2.0`、`-pro`、`qwen-image-3.0`、`-pro` | 1K/2K，n 1~6 |
| Z-Image | `z-image-turbo` | 1K/2K，仅文生图，`prompt_extend` |
| 万相 2.7 | `wan2.7-image-pro`、`wan2.7-image` | 1K/2K/4K，n 1~4（组图 1~12），参考图 ≤9 |
| Grok Imagine | `grok-imagine-1.5-apimart`（`grok-imagine-1.5-ext`）、`grok-imagine-image`、`grok-imagine-image-quality`、`grok-imagine-image-2.0`、`grok-imagine-2.0-ext` | 1.5 和 2.0-ext 用 `size`，其余用 `aspect_ratio` + `resolution` 1k/2k；2.0-ext 仅文生图，n 最多 12 |

括号里是 APIMart 的别名，插件同样支持。各模型特有的参数（例如 Seedream 的 `watermark`、`sequential_image_generation`，FLUX 的 `seed`、`safety_tolerance`，万相的 `color_palette`、`bbox_list`）按 APIMart 文档原样传入即可。完整参数见 [APIMart 文档](https://docs.apimart.ai/cn/api-reference/texts/models/list)。

暂不支持：Midjourney（接口和操作流程不同，计划在后续版本单独接入）、Grok 图层/选区编辑。

## 安装

用 Root 账号登录 New API，打开「任务插件」（`/task-plugins`），打开顶部总开关。然后任选一种方式：

**方式一：添加为市场源（推荐，之后可在市场里看到新版本）**

在「市场源」里点「添加源」，源名称随意，索引 URL 填：

```
https://raw.githubusercontent.com/nyaasuki/newapi-plugin-apimart/main/index.json
```

保存后在插件市场找到 APIMart 安装。市场安装会校验 `index.json` 中的 sha256。

**方式二：直接导入单个插件**

选择导入，填插件地址：

```
https://raw.githubusercontent.com/nyaasuki/newapi-plugin-apimart/main/plugins/tasks/apimart/1.1.0/plugin.js
```

也可以下载 `plugin.js` 后上传本地文件或粘贴源码。

无论哪种方式，安装前请自行检查源码，然后启用插件。

## 配置渠道

1. 新建渠道，类型选 **任务插件**，绑定插件 `apimart`。
2. Base URL 留空即使用默认 `https://api.apimart.ai`（带不带 `/v1` 都可以）。
3. 密钥填你的 APIMart API Key。
4. 模型填你要开放的模型名（见上表）。想对外用别的名字，可以用渠道的模型重定向，例如 `{"gpt-image-2.5": "gpt-image-2.5-flare"}`。

## 设置价格

每个模型都要在「模型价格」里单独设置价格。插件会为每个模型提供对应的计费字段和用量示例，价格编辑器只显示该模型用到的字段。

**按 token 计费**（`gpt-image-2.5-flare`、`gpt-image-2.5-sunburst`、`gpt-image-2-official`）：

| 字段 | 含义 | APIMart 官方单价（GPT-Image-2.5，每百万 token） |
|---|---|---|
| `input_tokens` | 输入 token（文本 + 参考图） | 文本 $5，图片 $8 |
| `output_tokens` | 输出图片 token | $30 |

APIMart 返回的 `input_tokens` 不区分文本和图片，所以输入单价建议这样设：只做文生图填 **$5/M**；有图生图需求填 **$8/M**（偏保守）。在此基础上按你自己的倍率加价。编辑器中 token 单价按每百万显示。

> 预扣说明：GPT-Image-2.5 的 `quality` 不传或为 `auto` 时，按该尺寸最高档 `max` 预扣，完成后退还差额。余额紧张的用户建议显式指定 `quality`。

**按张计费**（其他所有模型）：

| 字段 | 含义 | 出现在哪些模型 |
|---|---|---|
| `image_count` | 生成张数，所有按张计费的模型都有 | 全部 |
| `resolution` | 分辨率档位，如 `1k`、`2k`、`4k`、`1mp`、`768sq` | 有多个档位的模型 |
| `reference_images` | 参考图张数 | Seedream 5.0 Pro/Flash（第 2 张起加价）、Grok Imagine Image 系列（每张参考图加价） |
| `quality` | 质量档位 | GPT-Image 1/1.5、Grok Imagine Image 2.0 |
| `size` | 尺寸 | GPT-Image 1/1.5 |
| `version` | flare / sunburst | GPT-Image-2.5 Ext |
| `prompt_extend` | 是否开启智能改写（会加价） | Z-Image-Turbo |

提交时按请求张数预扣（Seedream 组图按 `max_images`，图层拆分按 17 张），完成后按实际返回的张数结算。APIMart 的单价以其[价格页](https://apimart.ai/pricing)为准。万相 2.7 的官方价格与分辨率无关，所以只有 `image_count` 一个字段。Nano banana 2.1 官方版、Nano banana Lite 和 MAI-Image 在 APIMart 那边按 token 计费，但它们的任务结果是否返回 token 用量还没有确认，所以插件先按张计费，单价请按常用档位估算。

也可以不用这些字段，改用**按次计费**：插件在按次模式下以请求张数作为倍率。

## 调用示例

文生图（OpenAI 格式，同步返回）：

```bash
curl https://your-newapi.example/v1/images/generations \
  -H "Authorization: Bearer $NEW_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "nano-banana-pro",
    "prompt": "雨天窗边温暖舒适的阅读角，暖色台灯，电影感光影",
    "size": "16:9",
    "resolution": "2K"
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

模型特有参数直接写在请求体里：

```bash
curl https://your-newapi.example/v1/images/generations \
  -H "Authorization: Bearer $NEW_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "seedream-4.5",
    "prompt": "同一角色的四张不同场景插画",
    "image_urls": ["https://example.com/character.png"],
    "n": 4,
    "resolution": "2K",
    "watermark": false
  }'
```

异步方式：

```bash
curl https://your-newapi.example/v1/tasks/apimart \
  -H "Authorization: Bearer $NEW_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model": "flux-2-pro", "prompt": "极简风格的产品发布会主视觉", "size": "1920x1080"}'

curl https://your-newapi.example/v1/tasks/<task_id> -H "Authorization: Bearer $NEW_API_KEY"
curl https://your-newapi.example/v1/tasks/<task_id>/artifacts -H "Authorization: Bearer $NEW_API_KEY"
```

## 限制与注意事项

- **参考图格式取决于模型。** GPT-Image-2.5、`gpt-image-2-official`、GPT-Image 1/1.5、Hy-Image、Qwen Image 2.0 和 Grok 系列只接受公网 http(s) URL。对这些模型，`/v1/images/edits` 用 multipart 上传图片文件会被拒绝，请改为在 `image_urls` 中传链接。其他支持参考图的模型可以接受 `data:image/...;base64,...` 或 multipart 上传的文件，插件会把文件内联为 data URL。
- **蒙版**只有 GPT-Image 系列支持。可以传 URL、`data:image/png;base64,...`，或在 multipart 中上传 `mask` 文件（≤4MB，需带 Alpha 通道的 PNG，尺寸与第一张参考图一致）。
- **等待时间。** OpenAI 图片接口会在请求内等待结果，超过 `TASK_PLUGIN_PROTOCOL_TIMEOUT_SECONDS`（默认 600 秒）返回 504，但任务仍会在后台完成并结算。Seedream 5.0 Pro 和 4K 档位可能需要几分钟，客户端和反向代理的超时也要相应调大。
- **图片链接是临时的。** 返回的 URL 来自 APIMart，一般 24~72 小时后过期，请及时下载。需要长期保存时，可以让客户端使用 `response_format: "b64_json"`。
- **产物下载**依赖 `upload.apimart.ai`（已在插件的 `allowedHosts` 中声明）。如果某些模型的图片放在其他域名，`/v1/tasks/{id}/artifacts/.../content` 会失败，但 OpenAI 接口返回的 URL 不受影响。
- 不支持流式（`stream: true`）。

## 开发与测试

```bash
node test/run.mjs                   # 各钩子的本地测试（针对最新版本）
node test/golden.mjs                # 用本地脚本回放 golden.json
node tools/build-index.mjs          # 修改插件后重新生成 index.json（含 sha256）
node tools/build-index.mjs --check  # 检查 index.json 是否最新

# 在装有 New API 可执行文件的机器上，用官方 CLI 校验：
new-api plugin lint plugins/tasks/apimart/1.1.0/plugin.js
new-api plugin test plugins/tasks/apimart/1.1.0/plugin.js --fixture golden.json
```

已发布的版本目录不要再修改，否则 `index.json` 里的 sha256 会对不上。改动请新建版本目录（如 `plugins/tasks/apimart/1.1.1/`），同步修改 `meta.version`，附上 `CHANGELOG.md`，再重新生成索引。

## License

MIT
