---
changelogVersion: 1
plugin: 'apimart'
version: '1.1.0'
locale: 'en'
translations:
  zh-CN: CHANGELOG.zh-CN.md
---

# Changelog

## [1.1.0]

### Added

- Support APIMart's other image models through the same OpenAI Images endpoints and task API: GPT-Image 1/1.5/2 (including `gpt-image-2-official` and `gpt-image-2.5-ext`), Nano Banana 2.1/2/Pro/Lite and Nano Banana, Imagen 4.0, Seedream 4.0/4.5/5.0 Lite/5.0 Pro/5.0 Flash, FLUX Kontext, FLUX 2, FLUX 3 Image and Klein, Hy-Image 3.5 Preview, MAI-Image 2.6, Qwen Image 2.0/3.0, Z-Image-Turbo, Wan 2.7 Image and Grok Imagine 1.5/Image/Image 2.0/2.0 Ext. APIMart's alias names such as `nano-banana-pro` work as model names too.
- Validate each model's own options before submitting, and forward only the fields that model accepts, including model-specific options such as Seedream group generation and layer decomposition, FLUX safety tolerance, Wan color palettes and Gemini search grounding.
- Accept OpenAI pixel sizes such as `1024x1024` on models that only take aspect ratios: the closest supported ratio is used, with a resolution tier that covers the requested pixels.
- Accept reference images as data URLs or uploaded files on models that support them.
- Bill every newly added model except `gpt-image-2-official` per image. The billing fields include the resolution tier, and also the reference image count, quality, size, version or prompt rewriting where those change the price. Submission reserves the requested image count and completion settles on the number of images delivered.
- Bill `gpt-image-2-official` by input and output tokens, like GPT-Image-2.5.

### Migration

- Before enabling a newly added model on a channel, set its price: per-image models need a price per `image_count`, optionally varied by the other billing fields listed for that model.
- Install this version only on a New API build that supports per-model usage profiles (`usageProfiles`); older builds reject the plugin.
