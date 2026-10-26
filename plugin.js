// APIMart GPT-Image-2.5 task plugin for New API.
//
// Upstream docs: https://docs.apimart.ai/cn/api-reference/images/gpt-image-2.5/generation.md
//
// APIMart answers POST /v1/images/generations with an asynchronous task id
// ({code: 200, data: [{status, task_id}]}); results come from
// GET /v1/tasks/{task_id} under data.result.images[].url[]. This plugin maps
// that onto the New API task contract:
//
//   * OpenAI Images protocol (POST /v1/images/generations and /v1/images/edits
//     on your New API instance): the host polls inside the request and returns
//     a standard {created, data: [{url}]} response, adding b64_json on request.
//   * Generic task API (POST /v1/tasks/apimart, GET /v1/tasks/{id},
//     GET /v1/tasks/{id}/artifacts): asynchronous submit and poll.
//
// Billing reports token usage (input_tokens / output_tokens). Submission
// reserves an estimate from APIMart's published output-token table;
// completion settles on the usage APIMart returns.

const MODELS = ["gpt-image-2.5-flare", "gpt-image-2.5-sunburst"];

const QUALITIES = ["low", "medium", "high", "xhigh", "max"];
// Older OpenAI clients still send DALL-E quality names.
const QUALITY_ALIASES = { standard: "medium", hd: "high" };
const RESOLUTIONS = ["1k", "2k", "4k"];
const OUTPUT_FORMATS = ["png", "jpeg", "webp"];
const BACKGROUNDS = ["transparent", "opaque", "auto"];
const MODERATIONS = ["auto", "low"];
const MAX_REFERENCE_IMAGES = 16;
const MAX_MASK_BYTES = 4 * 1024 * 1024;

// Per-image output tokens from APIMart's reference table:
// [ratio, resolution, width, height, [low, medium, high, xhigh, max]].
const OUTPUT_TOKEN_TABLE = [
  ["1:1", "1k", 1024, 1024, [196, 439, 1756, 3122, 7024]],
  ["3:2", "1k", 1536, 1024, [158, 343, 1372, 2459, 5488]],
  ["2:3", "1k", 1024, 1536, [158, 343, 1372, 2459, 5488]],
  ["4:3", "1k", 1024, 768, [134, 301, 1204, 2140, 4815]],
  ["3:4", "1k", 768, 1024, [134, 301, 1204, 2140, 4815]],
  ["5:4", "1k", 1280, 1024, [173, 378, 1510, 2702, 6119]],
  ["4:5", "1k", 1024, 1280, [173, 378, 1510, 2702, 6119]],
  ["16:9", "1k", 1536, 864, [120, 280, 1078, 1917, 4312]],
  ["9:16", "1k", 864, 1536, [120, 280, 1078, 1917, 4312]],
  ["2:1", "1k", 2048, 1024, [132, 295, 1180, 2098, 4720]],
  ["1:2", "1k", 1024, 2048, [132, 295, 1180, 2098, 4720]],
  ["21:9", "1k", 2016, 864, [105, 225, 943, 1617, 3682]],
  ["9:21", "1k", 864, 2016, [105, 225, 943, 1617, 3682]],
  ["3:1", "1k", 1536, 512, [56, 134, 535, 937, 2140]],
  ["1:3", "1k", 512, 1536, [56, 134, 535, 937, 2140]],
  ["1:1", "2k", 2048, 2048, [397, 892, 3568, 6343, 14272]],
  ["3:2", "2k", 2048, 1360, [211, 460, 1838, 3216, 7351]],
  ["2:3", "2k", 1360, 2048, [211, 460, 1838, 3216, 7351]],
  ["4:3", "2k", 2048, 1536, [247, 556, 2223, 3952, 8892]],
  ["3:4", "2k", 1536, 2048, [247, 556, 2223, 3952, 8892]],
  ["5:4", "2k", 2560, 2048, [377, 826, 3303, 5911, 13385]],
  ["4:5", "2k", 2048, 2560, [377, 826, 3303, 5911, 13385]],
  ["16:9", "2k", 2048, 1152, [157, 367, 1413, 2511, 5650]],
  ["9:16", "2k", 1152, 2048, [157, 367, 1413, 2511, 5650]],
  ["2:1", "2k", 2688, 1344, [180, 405, 1617, 2874, 6466]],
  ["1:2", "2k", 1344, 2688, [180, 405, 1617, 2874, 6466]],
  ["21:9", "2k", 2688, 1152, [143, 306, 1285, 2202, 5016]],
  ["9:21", "2k", 1152, 2688, [143, 306, 1285, 2202, 5016]],
  ["3:1", "2k", 3072, 1024, [103, 247, 988, 1729, 3952]],
  ["1:3", "2k", 1024, 3072, [103, 247, 988, 1729, 3952]],
  ["1:1", "4k", 2880, 2880, [659, 1483, 5930, 10542, 23719]],
  ["3:2", "4k", 3520, 2336, [450, 982, 3926, 6870, 15703]],
  ["2:3", "4k", 2336, 3520, [450, 982, 3926, 6870, 15703]],
  ["4:3", "4k", 3312, 2480, [491, 1104, 4413, 7845, 17650]],
  ["3:4", "4k", 2480, 3312, [491, 1104, 4413, 7845, 17650]],
  ["5:4", "4k", 3216, 2576, [535, 1173, 4690, 8393, 19006]],
  ["4:5", "4k", 2576, 3216, [535, 1173, 4690, 8393, 19006]],
  ["16:9", "4k", 3840, 2160, [371, 865, 3336, 5930, 13342]],
  ["9:16", "4k", 2160, 3840, [371, 865, 3336, 5930, 13342]],
  ["2:1", "4k", 3840, 1920, [300, 675, 2700, 4799, 10798]],
  ["1:2", "4k", 1920, 3840, [300, 675, 2700, 4799, 10798]],
  ["21:9", "4k", 3840, 1648, [234, 500, 2099, 3598, 8196]],
  ["9:21", "4k", 1648, 3840, [234, 500, 2099, 3598, 8196]],
  ["3:1", "4k", 3840, 1280, [139, 332, 1328, 2324, 5311]],
  ["1:3", "4k", 1280, 3840, [139, 332, 1328, 2324, 5311]],
];
const RATIOS = OUTPUT_TOKEN_TABLE.filter((row) => row[1] === "1k").map((row) => row[0]);

// Reservation allowances for input tokens; completion replaces them with
// the usage APIMart reports.
const INPUT_TOKENS_PER_REFERENCE_IMAGE = 3000;
const INPUT_TOKENS_PROMPT_OVERHEAD = 64;

export const meta = {
  apiVersion: 1,
  key: "apimart",
  name: "APIMart",
  icon: "text:AM",
  version: "1.0.0",
  author: { name: "newapi-plugin-apimart contributors" },
  website: "https://apimart.ai",
  description: {
    en: "APIMart GPT-Image-2.5 image generation and editing, billed by tokens",
    zh: "APIMart GPT-Image-2.5 图片生成与编辑，按 token 计费",
  },
  baseUrl: "https://api.apimart.ai",
  // Result images are served from APIMart's upload host; artifact downloads
  // need it in addition to the channel Base URL host.
  allowedHosts: ["upload.apimart.ai"],
  auth: "api_key",
  models: MODELS,
  fetchMode: "per_task",
  protocols: ["openai_image"],
  usageSchema: {
    input_tokens: {
      type: "number",
      unit: "token",
      description: { en: "Input token unit price", zh: "输入 token 单价" },
    },
    output_tokens: {
      type: "number",
      unit: "token",
      description: { en: "Output image token unit price", zh: "输出图片 token 单价" },
    },
  },
  usageExamples: [
    { label: "1:1 · 1K · low", facts: { input_tokens: 16, output_tokens: 196 } },
    { label: "1:1 · 1K · medium", facts: { input_tokens: 16, output_tokens: 439 } },
    { label: "1:1 · 1K · high", facts: { input_tokens: 16, output_tokens: 1756 } },
    { label: "16:9 · 2K · high", facts: { input_tokens: 16, output_tokens: 1413 } },
    { label: "1:1 · 4K · max", facts: { input_tokens: 16, output_tokens: 23719 } },
  ],
};

// ---------------------------------------------------------------------------
// Helpers

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function trimmed(value) {
  return typeof value === "string" ? value.trim() : "";
}

function has(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key) && object[key] !== undefined && object[key] !== null;
}

function isFilePlaceholder(value) {
  return isObject(value) && typeof value.__fileRef === "string";
}

function isHttpUrl(value) {
  return /^https?:\/\/\S+$/i.test(value);
}

// Accept a channel Base URL with or without a trailing /v1.
function apiRoot(ctx) {
  let root = String(ctx.baseUrl || "").replace(/\/+$/, "");
  if (root.endsWith("/v1")) root = root.slice(0, -3);
  return root;
}

function authHeader(ctx) {
  return ctx.authHeader || "Bearer " + (ctx.apiKey || "");
}

// Collect reference image URLs from APIMart's image_urls and the OpenAI-style
// image / images fields. Entries may be strings, {image_url}, {url}, or
// {image_url: {url}}.
function referenceUrls(value, field) {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.map(function (item) {
    let url = item;
    if (isObject(item)) {
      url = item.image_url !== undefined ? item.image_url : item.url;
      if (isObject(url)) url = url.url;
    }
    url = trimmed(url);
    if (!url) throw new Error(field + " entries must be image URLs");
    if (!isHttpUrl(url)) {
      throw new Error(
        "APIMart only accepts reference images as public http(s) URLs; upload the image first and pass its URL in image_urls",
      );
    }
    return url;
  });
}

function maskValue(value) {
  if (value === undefined || value === null) return undefined;
  if (isFilePlaceholder(value)) return value;
  let url = value;
  if (isObject(value)) {
    url = value.image_url !== undefined ? value.image_url : value.url;
    if (isObject(url)) url = url.url;
  }
  url = trimmed(url);
  if (!url) throw new Error("mask must be an image URL or a PNG data URL");
  if (!isHttpUrl(url) && !/^data:image\/png;base64,/i.test(url)) {
    throw new Error("mask must be a public http(s) URL or a data:image/png;base64 data URL");
  }
  return url;
}

function enumValue(value, allowed, field) {
  const text = trimmed(String(value)).toLowerCase();
  if (!allowed.includes(text)) throw new Error(field + " must be one of " + allowed.join(", "));
  return text;
}

function integerValue(value, min, max, field) {
  const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(field + " must be an integer between " + min + " and " + max);
  }
  return number;
}

// Returns {size, pixels}; pixels is null for auto and ratio sizes.
function sizeValue(value) {
  const text = trimmed(String(value)).toLowerCase();
  if (text === "auto") return { size: "auto", pixels: null };
  if (RATIOS.includes(text)) return { size: text, pixels: null };
  const match = /^(\d+)x(\d+)$/.exec(text);
  if (!match) throw new Error("size must be auto, an aspect ratio such as 16:9, or pixels such as 1600x1200");
  const width = Number(match[1]);
  const height = Number(match[2]);
  const pixels = width * height;
  if (width % 16 !== 0 || height % 16 !== 0) throw new Error("size width and height must be multiples of 16");
  if (width > 3840 || height > 3840) throw new Error("size width and height must not exceed 3840");
  if (Math.max(width, height) > 3 * Math.min(width, height)) throw new Error("size aspect ratio must not exceed 3:1");
  if (pixels < 655360 || pixels > 8294400) throw new Error("size must have between 655,360 and 8,294,400 pixels");
  return { size: width + "x" + height, pixels: pixels };
}

// ---------------------------------------------------------------------------
// Request normalization
//
// normalizeRequest turns a client body (OpenAI Images or APIMart shape) into
// the APIMart request body. It is idempotent: the host runs decoders more than
// once and driver hooks receive the decoded body again.

function assertModel(model) {
  if (!model) throw new Error("model is required");
  if (!MODELS.includes(model)) {
    throw new Error("Unsupported model " + model + "; use " + MODELS.join(" or ") + ", or map an alias to one of them");
  }
  return model;
}

function normalizeRequest(raw, model) {
  if (!isObject(raw)) throw new Error("request body must be a JSON object");
  if (!model) throw new Error("model is required");
  const prompt = trimmed(raw.prompt);
  if (!prompt) throw new Error("prompt is required");
  if (has(raw, "stream") && raw.stream !== false && raw.stream !== "false") {
    throw new Error("stream is not supported; the complete image response is returned once generation finishes");
  }

  const body = { model: model, prompt: prompt };

  if (has(raw, "size")) body.size = sizeValue(raw.size).size;
  if (has(raw, "resolution")) body.resolution = enumValue(raw.resolution, RESOLUTIONS, "resolution");
  if (has(raw, "quality")) {
    const quality = trimmed(String(raw.quality)).toLowerCase();
    body.quality = QUALITY_ALIASES[quality] || enumValue(quality, QUALITIES.concat(["auto"]), "quality");
  }
  if (has(raw, "n")) body.n = integerValue(raw.n, 1, 4, "n");
  if (has(raw, "output_format")) body.output_format = enumValue(raw.output_format, OUTPUT_FORMATS, "output_format");
  if (has(raw, "output_compression")) {
    body.output_compression = integerValue(raw.output_compression, 0, 100, "output_compression");
  }
  if (has(raw, "background")) body.background = enumValue(raw.background, BACKGROUNDS, "background");
  if (has(raw, "moderation")) body.moderation = enumValue(raw.moderation, MODERATIONS, "moderation");

  if (body.background === "transparent" && body.output_format === "jpeg") {
    throw new Error("background transparent requires output_format png or webp");
  }

  const urls = referenceUrls(raw.image_urls, "image_urls")
    .concat(referenceUrls(raw.image, "image"))
    .concat(referenceUrls(raw.images, "images"));
  if (urls.length > MAX_REFERENCE_IMAGES) throw new Error("at most " + MAX_REFERENCE_IMAGES + " reference images are supported");
  if (urls.length) body.image_urls = urls;

  const mask = has(raw, "mask_url") ? maskValue(raw.mask_url) : maskValue(raw.mask);
  if (mask !== undefined) {
    if (!urls.length) throw new Error("mask requires at least one reference image in image_urls");
    body.mask_url = mask;
  }
  return body;
}

// Multipart fields arrive as string arrays. JSON-valued fields (image_urls as
// a JSON array) are parsed; repeated image_urls fields are collected.
function multipartToRaw(body) {
  const fields = body.fields || {};
  const raw = {};
  for (const name of Object.keys(fields)) {
    const values = fields[name] || [];
    const key = name.replace(/\[\d*\]$/, "");
    if (key === "image_urls" || key === "image" || key === "images") {
      let list = [];
      for (const value of values) {
        const text = trimmed(value);
        if (text.startsWith("[")) {
          try {
            list = list.concat(JSON.parse(text));
          } catch (error) {
            throw new Error(key + " must be a URL or a JSON array of URLs");
          }
        } else if (text) list.push(text);
      }
      raw[key] = (raw[key] || []).concat(list);
      continue;
    }
    if (values.length > 1) throw new Error(name + " must be provided once");
    raw[key] = values[0];
  }
  for (const file of body.files || []) {
    const field = file.field.replace(/\[\d*\]$/, "");
    if (field === "mask") {
      raw.mask = { __fileRef: file.ref, encoding: "dataUrl", mimeType: "image/png", maxBytes: MAX_MASK_BYTES };
      continue;
    }
    if (field === "image") {
      throw new Error(
        "APIMart only accepts reference images as public http(s) URLs; send them in image_urls instead of uploading files",
      );
    }
    throw new Error(file.field + " file uploads are not supported");
  }
  return raw;
}

function requestAction(body) {
  return body.image_urls && body.image_urls.length ? "image_edit" : "text_to_image";
}

// The model the vendor sees, after channel model mapping.
function upstreamModel(ctx) {
  return ctx.upstreamModel || ctx.model || (isObject(ctx.requestBody) ? trimmed(ctx.requestBody.model) : "");
}

// ---------------------------------------------------------------------------
// Usage estimation

function estimateOutputTokensPerImage(body) {
  const quality = body.quality && body.quality !== "auto" ? body.quality : "max"; // auto reserves the top tier
  const qualityIndex = QUALITIES.indexOf(quality);
  const resolution = body.resolution || "1k";
  const size = body.size ? sizeValue(body.size) : { size: "auto", pixels: null };

  if (size.pixels !== null) {
    // Exact pixels: the smallest table size that covers them, else the
    // largest entry scaled by pixel count.
    const pixelsOf = (row) => row[2] * row[3];
    let best = null;
    let largest = OUTPUT_TOKEN_TABLE[0];
    for (const row of OUTPUT_TOKEN_TABLE) {
      if (pixelsOf(row) > pixelsOf(largest)) largest = row;
      if (pixelsOf(row) < size.pixels) continue;
      // Smallest covering size; among equal sizes, the higher token count.
      if (!best || pixelsOf(row) < pixelsOf(best) || (pixelsOf(row) === pixelsOf(best) && row[4][qualityIndex] > best[4][qualityIndex])) {
        best = row;
      }
    }
    if (best) return best[4][qualityIndex];
    return Math.ceil((largest[4][qualityIndex] * size.pixels) / (largest[2] * largest[3]));
  }

  const rows = OUTPUT_TOKEN_TABLE.filter(function (row) {
    return row[1] === resolution && (size.size === "auto" || row[0] === size.size);
  });
  return rows.reduce(function (max, row) {
    return Math.max(max, row[4][qualityIndex]);
  }, 0);
}

function estimateUsage(body) {
  const n = body.n || 1;
  const references = (body.image_urls ? body.image_urls.length : 0) + (body.mask_url ? 1 : 0);
  return {
    input_tokens: INPUT_TOKENS_PROMPT_OVERHEAD + body.prompt.length + references * INPUT_TOKENS_PER_REFERENCE_IMAGE,
    output_tokens: estimateOutputTokensPerImage(body) * n,
  };
}

// ---------------------------------------------------------------------------
// Upstream response helpers

// The task snapshot is the APIMart query response {code, data: {...}}; tolerate
// a bare task object as well.
function taskObject(body) {
  if (isObject(body) && isObject(body.data)) return body.data;
  return isObject(body) ? body : {};
}

function imageUrls(body) {
  const task = taskObject(body);
  const result = isObject(task.result) ? task.result : {};
  const images = Array.isArray(result.images) ? result.images : [];
  const urls = [];
  for (const image of images) {
    const value = isObject(image) ? image.url : image;
    const list = Array.isArray(value) ? value : [value];
    for (const url of list) {
      const text = trimmed(url);
      if (text) urls.push(text);
    }
  }
  return urls;
}

function failureReason(body) {
  const task = taskObject(body);
  const error = isObject(task.error) ? task.error : isObject(body) && isObject(body.error) ? body.error : null;
  if (error && trimmed(error.message)) return trimmed(error.message);
  if (trimmed(task.fail_reason)) return trimmed(task.fail_reason);
  if (trimmed(task.message)) return trimmed(task.message);
  return "APIMart reported the task as failed";
}

function mimeTypeFromUrl(url) {
  const path = url.split(/[?#]/)[0].toLowerCase();
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
  if (path.endsWith(".webp")) return "image/webp";
  return undefined;
}

const STATUS_MAP = {
  submitted: "SUBMITTED",
  pending: "QUEUED",
  queued: "QUEUED",
  processing: "IN_PROGRESS",
  running: "IN_PROGRESS",
  in_progress: "IN_PROGRESS",
  completed: "SUCCESS",
  succeeded: "SUCCESS",
  success: "SUCCESS",
  failed: "FAILURE",
  failure: "FAILURE",
  cancelled: "FAILURE",
  canceled: "FAILURE",
  expired: "FAILURE",
};

// ---------------------------------------------------------------------------
// Driver hooks

export function buildSubmitRequest(ctx) {
  const body = normalizeRequest(ctx.requestBody, assertModel(upstreamModel(ctx)));
  return {
    url: apiRoot(ctx) + "/v1/images/generations",
    method: "POST",
    headers: {
      Authorization: authHeader(ctx),
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body,
  };
}

export function parseSubmitResponse(ctx, response) {
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error("APIMart returned HTTP " + response.statusCode);
  }
  const body = response.body;
  if (!isObject(body)) throw new Error("APIMart returned an unreadable submission response");
  if (body.code !== undefined && Number(body.code) !== 200) {
    const message = isObject(body.error) ? trimmed(body.error.message) : trimmed(body.message);
    throw new Error("APIMart rejected the task" + (message ? ": " + message : ""));
  }
  const entry = Array.isArray(body.data) ? body.data[0] : body.data;
  const taskId = isObject(entry) ? trimmed(entry.task_id || entry.id) : "";
  if (!taskId) throw new Error("APIMart response has no task_id");
  return { taskId: taskId, taskData: body };
}

export function buildQueryRequest(ctx) {
  return {
    url: apiRoot(ctx) + "/v1/tasks/" + encodeURIComponent(ctx.taskId),
    method: "GET",
    headers: { Authorization: authHeader(ctx), Accept: "application/json" },
  };
}

export function parseTaskResult(ctx, body, response) {
  if (response && response.status >= 300) {
    return { status: "UNKNOWN", reason: "APIMart task query returned HTTP " + response.status };
  }
  const task = taskObject(body);
  const raw = trimmed(String(task.status || "")).toLowerCase();
  const status = Object.prototype.hasOwnProperty.call(STATUS_MAP, raw) ? STATUS_MAP[raw] : "UNKNOWN";
  if (status === "UNKNOWN") return { status: "UNKNOWN", reason: "unrecognized APIMart task status: " + raw };

  const progressNumber = Number(task.progress);
  const progress = Number.isFinite(progressNumber) ? Math.max(0, Math.min(100, Math.round(progressNumber))) + "%" : undefined;

  if (status === "FAILURE") return { status: "FAILURE", progress: "100%", reason: failureReason(body) };
  if (status === "SUCCESS") {
    const urls = imageUrls(body);
    if (!urls.length) return { status: "FAILURE", progress: "100%", reason: "APIMart completed the task without returning images" };
    const result = { status: "SUCCESS", progress: "100%", url: urls[0] };
    const usage = isObject(task.usage) ? task.usage : {};
    if (Number.isFinite(Number(usage.output_tokens))) result.completionTokens = Number(usage.output_tokens);
    if (Number.isFinite(Number(usage.total_tokens))) result.totalTokens = Number(usage.total_tokens);
    return result;
  }
  const result = { status: status };
  if (progress) result.progress = progress;
  return result;
}

// Reservation at submission. Legacy per-call pricing asks only for ratios:
// the price is multiplied by the requested image count.
export function extractUsage(ctx) {
  const body = normalizeRequest(ctx.requestBody, upstreamModel(ctx));
  if (ctx.usagePurpose === "billing_ratios") return { image_count: body.n || 1 };
  return estimateUsage(body);
}

// Settlement on completion from the usage APIMart reports. Throwing keeps the
// reservation and makes the host log the missing usage instead of billing zero.
export function extractUsageOnComplete(task, result, data) {
  const usage = taskObject(data).usage;
  if (!isObject(usage)) throw new Error("APIMart task result has no usage");
  const input = Number(usage.input_tokens);
  const output = Number(usage.output_tokens);
  if (!Number.isInteger(input) || input < 0 || !Number.isInteger(output) || output < 0) {
    throw new Error("APIMart task usage is missing input_tokens or output_tokens");
  }
  return { input_tokens: input, output_tokens: output };
}

export function listArtifacts(task) {
  if (task.status !== "SUCCESS") return [];
  return imageUrls(task.data).map(function (url, index) {
    const artifact = { key: "image-" + (index + 1), type: "image" };
    const mimeType = mimeTypeFromUrl(url);
    if (mimeType) artifact.mimeType = mimeType;
    return artifact;
  });
}

export function buildContentRequest(ctx) {
  const match = /^image-(\d+)$/.exec(String(ctx.artifactKey || ""));
  const urls = imageUrls(ctx.data);
  const url = match ? urls[Number(match[1]) - 1] : undefined;
  if (!url) throw new Error("artifact_not_found");
  return { url: url, method: ctx.clientRequest.method, credentialless: true };
}

// ---------------------------------------------------------------------------
// OpenAI Images protocol

export const protocols = {
  openai_image: {
    decodeRequest: function (ctx) {
      const model = trimmed(ctx.model);
      let raw;
      if (ctx.body && ctx.body.kind === "json") raw = ctx.body.value;
      else if (ctx.body && ctx.body.kind === "multipart") raw = multipartToRaw(ctx.body);
      else throw new Error("JSON or multipart body required");
      if (!isObject(raw)) throw new Error("request body must be a JSON object");
      if (has(raw, "response_format") && raw.response_format !== "url" && raw.response_format !== "b64_json") {
        throw new Error("response_format must be url or b64_json");
      }
      // Decoding runs before channel selection, so a channel model mapping may
      // not be resolved yet; buildSubmitRequest checks the vendor model.
      const body = normalizeRequest(raw, model);
      const action = requestAction(body);
      if (ctx.operation === "edit" && action !== "image_edit") {
        throw new Error("image editing requires at least one reference image URL in image_urls");
      }
      return { kind: "submit", model: model, action: action, requestBody: body };
    },
    render: function (ctx, task) {
      const result = {
        data: imageUrls(task.data).map(function (url) {
          return { url: url };
        }),
      };
      if (task.created_at) result.created = task.created_at;
      return result;
    },
  },
};
