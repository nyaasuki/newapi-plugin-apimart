---
changelogVersion: 1
plugin: 'apimart'
version: '1.0.0'
locale: 'zh-CN'
---

# Changelog

## [1.0.0]

### Added

- 支持使用 APIMart 的 `gpt-image-2.5-flare` 和 `gpt-image-2.5-sunburst` 模型生成和编辑图片。
- 可通过 OpenAI 图片接口 `/v1/images/generations` 和 `/v1/images/edits` 调用；网关会等待 APIMart 任务完成并直接返回图片。
- 可通过 `/v1/tasks/apimart` 异步提交和查询任务，并以任务产物的形式下载结果图片。
- 支持透传 APIMart 参数，包括比例或精确像素尺寸、分辨率档位、最高到 `max` 的质量档位、生成数量、透明背景、最多 16 张参考图链接以及局部重绘蒙版。
- 按输入和输出 token 计费：提交时按 APIMart 输出 token 参考表预扣，完成后按 APIMart 返回的实际用量结算。按次计费时以请求的图片数量作为倍率。
