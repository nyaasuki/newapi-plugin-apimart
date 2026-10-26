---
changelogVersion: 1
plugin: 'apimart'
version: '1.1.0'
locale: 'zh-CN'
---

# Changelog

## [1.1.0]

### Added

- 通过同样的 OpenAI 图片接口和任务接口，支持 APIMart 的其他图像模型：GPT-Image 1/1.5/2（含 `gpt-image-2-official` 和 `gpt-image-2.5-ext`）、Nano Banana 2.1/2/Pro/Lite 和 Nano Banana、Imagen 4.0、Seedream 4.0/4.5/5.0 Lite/5.0 Pro/5.0 Flash、FLUX Kontext、FLUX 2、FLUX 3 Image 和 Klein、Hy-Image 3.5 Preview、MAI-Image 2.6、Qwen Image 2.0/3.0、Z-Image-Turbo、万相 2.7 Image，以及 Grok Imagine 1.5/Image/Image 2.0/2.0 Ext。`nano-banana-pro` 这类 APIMart 别名也可以直接作为模型名使用。
- 提交前按各模型的规则校验参数，只转发该模型支持的字段。这也包括各模型特有的参数，例如 Seedream 组图和图层拆分、FLUX 安全等级、万相色板、Gemini 联网搜索。
- 只支持比例的模型也能接受 `1024x1024` 这类 OpenAI 像素尺寸：插件会换成最接近的支持比例，并选择能覆盖该像素数的分辨率档位。
- 支持 data URL 参考图的模型，也接受 data URL 和上传文件形式的参考图。
- 除 `gpt-image-2-official` 外，新增模型都按张计费。计费字段包含分辨率档位；对价格有影响时，还包含参考图数量、质量、尺寸、版本或智能改写。提交时按请求张数预扣，完成后按实际交付张数结算。
- `gpt-image-2-official` 与 GPT-Image-2.5 一样按输入和输出 token 计费。

### Migration

- 在渠道上启用新增模型前，先为它设置价格：按张计费的模型需要设置每张（`image_count`）的单价，也可以按该模型列出的其他计费字段区分价格。
- 只能安装在支持按模型区分计费配置（`usageProfiles`）的 New API 版本上，旧版本会拒绝加载本插件。
