---
changelogVersion: 1
plugin: 'apimart'
version: '1.0.0'
locale: 'en'
translations:
  zh-CN: CHANGELOG.zh-CN.md
---

# Changelog

## [1.0.0]

### Added

- Generate and edit images with APIMart's `gpt-image-2.5-flare` and `gpt-image-2.5-sunburst` models.
- Call the models through the OpenAI Images endpoints `/v1/images/generations` and `/v1/images/edits`; the gateway waits for the APIMart task and returns the finished images.
- Submit and query tasks asynchronously through `/v1/tasks/apimart`, and download result images as task artifacts.
- Pass APIMart options such as aspect ratio or exact pixel size, resolution tier, quality tier up to `max`, image count, transparent backgrounds, up to 16 reference image URLs and inpainting masks.
- Bill by input and output tokens: submission reserves an estimate from APIMart's output token table and completion settles on the usage APIMart reports. Per-call pricing multiplies the price by the requested image count.
