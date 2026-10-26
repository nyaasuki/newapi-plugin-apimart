// APIMart image task plugin for New API.
//
// Upstream docs: https://docs.apimart.ai/cn/api-reference/images/gpt-image-2.5/generation.md
// (and the sibling pages under /api-reference/images/ for every model in SPECS).
//
// APIMart answers POST /v1/images/generations with an asynchronous task id
// ({code: 200, data: [{status, task_id}]} or, for newer models,
// {code: 202, data: {id, ...}}); results come from GET /v1/tasks/{task_id}
// under data.result.images[].url[]. This plugin maps that onto the New API
// task contract:
//
//   * OpenAI Images protocol (POST /v1/images/generations and /v1/images/edits
//     on your New API instance): the host polls inside the request and returns
//     a standard {created, data: [{url}]} response, adding b64_json on request.
//   * Generic task API (POST /v1/tasks/apimart, GET /v1/tasks/{id},
//     GET /v1/tasks/{id}/artifacts): asynchronous submit and poll.
//
// Every model has a spec in SPECS describing the parameters APIMart accepts
// for it. Requests are rebuilt from a whitelist, so fields a model does not
// take are dropped instead of forwarded.
//
// Billing: GPT-Image-2.5 and gpt-image-2-official report token usage
// (input_tokens / output_tokens); submission reserves an estimate from
// APIMart's published output-token table and completion settles on the usage
// APIMart returns. Every other model is billed per image (image_count, plus
// the facts its price depends on, such as the resolution tier); submission
// reserves the requested count and completion settles on the delivered count.

// ---------------------------------------------------------------------------
// Shared tables

const GPT_QUALITIES = ["low", "medium", "high", "xhigh", "max"];
// Older OpenAI clients still send DALL-E quality names.
const QUALITY_ALIASES = { standard: "medium", hd: "high" };
const MAX_MASK_BYTES = 4 * 1024 * 1024;
const MB = 1024 * 1024;

// Per-image output tokens from APIMart's GPT-Image-2.5 reference table:
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

// Reservation allowances for input tokens; completion replaces them with
// the usage APIMart reports.
const INPUT_TOKENS_PER_REFERENCE_IMAGE = 3000;
const INPUT_TOKENS_PROMPT_OVERHEAD = 64;

// Aspect ratio sets as each model's docs list them.
const RATIOS_GPT = ["1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5", "16:9", "9:16", "2:1", "1:2", "3:1", "1:3", "21:9", "9:21"];
const RATIOS_10 = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];
const RATIOS_GEMINI_WIDE = RATIOS_10.concat(["1:4", "4:1", "1:8", "8:1"]);
const RATIOS_7 = ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3"];
const RATIOS_SEEDREAM = ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3", "2:1", "1:2", "21:9"];
const RATIOS_FLUX = ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3", "21:9", "9:21"];
const RATIOS_FLUX_3 = ["21:9", "2:1", "16:9", "3:2", "7:5", "4:3", "5:4", "1:1", "4:5", "3:4", "5:7", "2:3", "9:16", "1:2", "9:21"];
const RATIOS_GROK = ["1:1", "3:4", "4:3", "9:16", "16:9", "2:3", "3:2", "9:19.5", "19.5:9", "9:20", "20:9", "1:2", "2:1"];

// Nominal pixel counts of resolution tier names. A tier covers pixel counts up
// to the geometric mean of its own and the next tier's nominal count.
const TIER_AREAS = {
  "768sq": 768 * 768,
  "0.5k": 512 * 512,
  "1k": 1024 * 1024,
  "1.5k": 1536 * 1536,
  "2k": 2048 * 2048,
  "3k": 3072 * 3072,
  "4k": 4096 * 4096,
  "1mp": 1048576,
  "2mp": 2097152,
  "3mp": 3145728,
  "4mp": 4194304,
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

function isImageDataUrl(value) {
  return /^data:image\/[a-z0-9.+-]+;base64,/i.test(value);
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

function numberValue(value, min, max, field) {
  const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isFinite(number) || number < min || number > max) {
    throw new Error(field + " must be a number between " + min + " and " + max);
  }
  return number;
}

function booleanValue(value, field) {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw new Error(field + " must be true or false");
}

// Ratios compare by text, so "16x9", "16:9" and "16.0:9" all become "16:9".
function ratioText(a, b) {
  return String(Number(a)) + ":" + String(Number(b));
}

function ratioValue(ratio) {
  const parts = ratio.split(":");
  return Number(parts[0]) / Number(parts[1]);
}

// ---------------------------------------------------------------------------
// Parameter validators for spec.extras. Each returns the value to send, or
// undefined to leave the field out.

const bool = (value, field) => booleanValue(value, field);

function oneOf(values, aliases) {
  return function (value, field) {
    const text = trimmed(String(value)).toLowerCase();
    if (aliases && Object.prototype.hasOwnProperty.call(aliases, text)) return aliases[text];
    const match = values.find((item) => item.toLowerCase() === text);
    if (match === undefined) throw new Error(field + " must be one of " + values.join(", "));
    return match;
  };
}

function int(min, max) {
  return (value, field) => integerValue(value, min, max, field);
}

function num(min, max) {
  return (value, field) => numberValue(value, min, max, field);
}

function text(maxLength) {
  return function (value, field) {
    const result = trimmed(value);
    if (!result) throw new Error(field + " must be a non-empty string");
    if (maxLength && result.length > maxLength) throw new Error(field + " must be at most " + maxLength + " characters");
    return result;
  };
}

// Structured values (objects, arrays) pass through; multipart sends them as
// JSON text.
function json(value, field) {
  if (typeof value === "string") {
    const source = value.trim();
    if (source.startsWith("{") || source.startsWith("[")) {
      try {
        return JSON.parse(source);
      } catch (error) {
        throw new Error(field + " must be valid JSON");
      }
    }
    return source;
  }
  return value;
}

// OpenAI quality names; "auto" omits the field when the model has no auto tier.
function quality(values) {
  return function (value, field) {
    const name = trimmed(String(value)).toLowerCase();
    const mapped = QUALITY_ALIASES[name] || name;
    if (mapped === "auto" && !values.includes("auto")) return undefined;
    if (!values.includes(mapped)) throw new Error(field + " must be one of " + values.join(", "));
    return mapped;
  };
}

// ---------------------------------------------------------------------------
// Model specs
//
//   sizeKey      upstream field for the aspect ratio ("size" or "aspect_ratio")
//   ratios       accepted ratios, or a predicate for open ranges
//   auto         whether "auto" is a valid size
//   pixels       validator for exact WxH sizes; models without one get the
//                nearest supported ratio instead
//   pixelSizes   literal pixel sizes the model accepts as-is
//   tiers        resolution tier values exactly as APIMart spells them
//   tierAliases  extra client spellings, lowercased, mapped to a tier
//   tierLimits   upper pixel counts per tier when they differ from TIER_AREAS
//   defaultTier  the tier APIMart uses when resolution is omitted
//   maxN         largest n
//   refs         reference images {max, data (data URLs allowed), maxBytes}
//   mask         whether mask_url is supported
//   extras       other passthrough fields and their validators
//   billing      "tokens", or the facts beside image_count that price an image
//   check        cross-field rules
//   reserve      images to reserve when it differs from n
//   promptOptional  requests that may omit the prompt
//   versionHeader   send the response-version and idempotency headers

function tierList(values, limits) {
  return values.map(function (value, index) {
    if (limits) return [value, limits[index]];
    const area = TIER_AREAS[value.toLowerCase()];
    const next = values[index + 1];
    return [value, next ? Math.sqrt(area * TIER_AREAS[next.toLowerCase()]) : Infinity];
  });
}

function model(spec) {
  const result = Object.assign(
    { sizeKey: "size", ratios: [], auto: false, pixels: null, tiers: null, maxN: 1, refs: null, mask: false, extras: {}, billing: [] },
    spec,
  );
  if (result.tiers) result.tiers = tierList(result.tiers, result.tierLimits);
  // Per-image prices follow the resolution tier unless the spec says otherwise.
  if (!spec.billing && result.tiers && result.tiers.length > 1) result.billing = ["resolution"];
  return result;
}

function pixelRange(rules) {
  return function (width, height) {
    if (rules.minSide && (width < rules.minSide || height < rules.minSide)) throw new Error("size width and height must be at least " + rules.minSide);
    if (rules.maxSide && (width > rules.maxSide || height > rules.maxSide)) throw new Error("size width and height must not exceed " + rules.maxSide);
    if (rules.minArea && width * height < rules.minArea) throw new Error("size must have at least " + rules.minArea + " pixels");
    if (rules.maxArea && width * height > rules.maxArea) throw new Error("size must have at most " + rules.maxArea + " pixels");
    if (rules.maxRatio && Math.max(width, height) > rules.maxRatio * Math.min(width, height)) {
      throw new Error("size aspect ratio must not exceed " + rules.maxRatio + ":1");
    }
  };
}

function gpt25Pixels(width, height) {
  const pixels = width * height;
  if (width % 16 !== 0 || height % 16 !== 0) throw new Error("size width and height must be multiples of 16");
  if (width > 3840 || height > 3840) throw new Error("size width and height must not exceed 3840");
  if (Math.max(width, height) > 3 * Math.min(width, height)) throw new Error("size aspect ratio must not exceed 3:1");
  if (pixels < 655360 || pixels > 8294400) throw new Error("size must have between 655,360 and 8,294,400 pixels");
}

function anyPixels() {}

function noTransparentJpeg(body) {
  if (body.background === "transparent" && body.output_format === "jpeg") {
    throw new Error("background transparent requires output_format png or webp");
  }
}

// Seedream 4.x and 5.0 Lite: references plus outputs are capped at 15.
function seedreamGroupCheck(requireReferences) {
  return function (body, info) {
    if (info.refs + info.reserve > 15) throw new Error("reference images plus generated images must not exceed 15");
    if (body.size === "auto" && !info.refs) throw new Error("size auto requires at least one reference image");
    if (requireReferences && info.reserve > 1 && !info.refs) {
      throw new Error("generating several images requires at least one reference image in image_urls");
    }
  };
}

function seedreamGroupReserve(body) {
  const options = isObject(body.sequential_image_generation_options) ? body.sequential_image_generation_options : {};
  const max = Number(options.max_images);
  const n = body.n || 1;
  if (body.sequential_image_generation === "auto" && Number.isInteger(max) && max > n) return max;
  return n;
}

function seedreamProCheck(body, info) {
  if (body.background === "transparent") {
    if (info.refs !== 1) throw new Error("background transparent requires exactly one reference image with an alpha channel");
    if (body.output_format !== "png") throw new Error("background transparent requires output_format png");
  }
  if (body.layer_decomposition === true) {
    if (info.refs !== 1) throw new Error("layer_decomposition requires exactly one reference image");
    if (body.size && body.size !== "auto") throw new Error("layer_decomposition accepts only a resolution tier or size auto");
  }
}

function geminiSearchCheck(body) {
  if (body.google_image_search === true && body.google_search !== true) {
    throw new Error("google_image_search requires google_search true");
  }
}

const NSFW = { nsfw_check: bool };

const GPT_25 = model({
  billing: "tokens",
  ratios: RATIOS_GPT,
  auto: true,
  pixels: gpt25Pixels,
  tiers: ["1k", "2k", "4k"],
  maxN: 4,
  refs: { max: 16, data: false },
  mask: true,
  extras: {
    quality: quality(GPT_QUALITIES.concat(["auto"])),
    output_format: oneOf(["png", "jpeg", "webp"]),
    output_compression: int(0, 100),
    background: oneOf(["transparent", "opaque", "auto"]),
    moderation: oneOf(["auto", "low"]),
  },
  check: noTransparentJpeg,
  // auto or omitted quality reserves the top tier.
  tokenColumn: { low: 0, medium: 1, high: 2, xhigh: 3, max: 4, auto: 4 },
});

const GPT_2_OFFICIAL = model({
  billing: "tokens",
  ratios: RATIOS_GPT,
  auto: true,
  pixels: anyPixels,
  tiers: ["1k", "2k", "4k"],
  maxN: 4,
  refs: { max: 16, data: false },
  mask: true,
  extras: Object.assign(
    {
      quality: quality(["auto", "low", "medium", "high"]),
      output_format: oneOf(["png", "jpeg", "webp"]),
      output_compression: int(0, 100),
      moderation: oneOf(["auto", "low"]),
    },
    NSFW,
  ),
  // gpt-image-2 medium and high spend about four times the GPT-Image-2.5
  // tokens of the same name, which are the 2.5 table's high and max columns.
  tokenColumn: { low: 0, medium: 2, high: 4, auto: 2 },
});

const GPT_1 = model({
  ratios: ["1:1", "3:2", "2:3"],
  maxN: 4,
  refs: { max: 15, data: false },
  mask: true,
  qualities: ["auto", "low", "medium", "high"],
  extras: Object.assign(
    {
      quality: quality(["auto", "low", "medium", "high"]),
      background: oneOf(["auto", "opaque", "transparent"]),
      moderation: oneOf(["auto", "low"]),
      output_format: oneOf(["png", "jpeg"]),
      output_compression: int(0, 100),
    },
    NSFW,
  ),
  check: noTransparentJpeg,
  billing: ["size", "quality"],
});

const GPT_2 = model({
  ratios: RATIOS_GPT,
  auto: true,
  pixels: anyPixels,
  tiers: ["1k", "2k", "4k"],
  // Upper pixel counts of APIMart's 1k and 2k size tables.
  tierLimits: [2200000, 5300000, Infinity],
  defaultTier: "1k",
  maxN: 4,
  refs: { max: 15, data: true, maxBytes: 20 * MB },
  extras: Object.assign({ official_fallback: bool }, NSFW),
});

const GPT_25_EXT = model({
  ratios: RATIOS_10,
  auto: true,
  tiers: ["1K", "2K", "4K"],
  defaultTier: "1K",
  maxN: 4,
  refs: { max: 16, data: true, maxBytes: 20 * MB },
  versions: ["flare", "sunburst"],
  extras: { version: oneOf(["flare", "sunburst"]) },
  billing: ["version", "resolution"],
});

function gemini(options) {
  return model(
    Object.assign(
      {
        ratios: RATIOS_10,
        auto: true,
        tiers: ["1K"],
        defaultTier: "1K",
        refs: { max: 14, data: true, maxBytes: 10 * MB },
        extras: Object.assign({}, NSFW, options.fallback ? { official_fallback: bool } : {}),
      },
      options,
    ),
  );
}

const NANO_BANANA_21 = gemini({
  ratios: RATIOS_GEMINI_WIDE,
  tiers: ["1K", "2K", "4K"],
  maxN: 4,
  // The 2.1 docs set no reference count limit; this only guards the request size.
  refs: { max: 32, data: true, maxBytes: 20 * MB },
  extras: {},
});
const NANO_BANANA_21_EXT = gemini({
  ratios: RATIOS_GEMINI_WIDE,
  tiers: ["1K", "2K", "4K"],
  refs: { max: 32, data: true, maxBytes: 20 * MB },
  extras: { official_fallback: bool },
});
function geminiFlash(fallback) {
  return gemini({
    ratios: RATIOS_GEMINI_WIDE,
    tiers: ["0.5K", "1K", "2K", "4K"],
    extras: Object.assign({ google_search: bool, google_image_search: bool }, NSFW, fallback ? { official_fallback: bool } : {}),
    check: geminiSearchCheck,
  });
}
const GEMINI_31_FLASH = geminiFlash(true);
const GEMINI_31_FLASH_OFFICIAL = geminiFlash(false);
const GEMINI_31_LITE = gemini({ maxN: 4 });
const GEMINI_3_PRO = gemini({ tiers: ["1K", "2K", "4K"], refs: { max: 14, data: true, maxBytes: 30 * MB }, fallback: true });
const GEMINI_3_PRO_OFFICIAL = gemini({ tiers: ["1K", "2K", "4K"], refs: { max: 14, data: true, maxBytes: 30 * MB } });
const GEMINI_25_FLASH = gemini({ promptMax: 1000, fallback: true });
const GEMINI_25_FLASH_OFFICIAL = gemini({ promptMax: 1000 });

const IMAGEN_4 = model({ ratios: ["1:1", "4:3", "3:4", "16:9", "9:16"], extras: NSFW });

const SEEDREAM_GROUP_EXTRAS = Object.assign(
  {
    watermark: bool,
    sequential_image_generation: oneOf(["disabled", "auto"]),
    sequential_image_generation_options: json,
  },
  NSFW,
);
const SEEDREAM_4 = model({
  ratios: RATIOS_SEEDREAM.concat(["9:21"]),
  auto: true,
  tiers: ["1K", "2K", "4K"],
  defaultTier: "2K",
  maxN: 15,
  refs: { max: 14, data: true, maxBytes: 10 * MB },
  promptMax: 1000,
  extras: Object.assign({ optimize_prompt_options: json }, SEEDREAM_GROUP_EXTRAS),
  check: seedreamGroupCheck(true),
  reserve: seedreamGroupReserve,
});
const SEEDREAM_45 = model({
  ratios: RATIOS_SEEDREAM.concat(["9:21"]),
  auto: true,
  tiers: ["2K", "4K"],
  defaultTier: "2K",
  maxN: 15,
  refs: { max: 14, data: true, maxBytes: 10 * MB },
  extras: Object.assign({ optimize_prompt_options: json, "optimize_prompt_options.mode": oneOf(["standard", "fast"]) }, SEEDREAM_GROUP_EXTRAS),
  check: seedreamGroupCheck(true),
  reserve: seedreamGroupReserve,
});
const SEEDREAM_5_LITE = model({
  ratios: RATIOS_SEEDREAM,
  auto: true,
  tiers: ["2K", "3K", "4K"],
  defaultTier: "2K",
  maxN: 15,
  refs: { max: 14, data: true, maxBytes: 10 * MB },
  extras: Object.assign({ output_format: oneOf(["jpeg", "png"]) }, SEEDREAM_GROUP_EXTRAS),
  check: seedreamGroupCheck(false),
  reserve: seedreamGroupReserve,
});
const SEEDREAM_5_PRO = model({
  ratios: RATIOS_SEEDREAM,
  auto: true,
  pixels: pixelRange({ minArea: 921600, maxArea: 4624220, maxRatio: 16 }),
  tiers: ["1K", "1.5K", "2K"],
  // APIMart prices outputs up to 2,601,124 pixels at the lower rate.
  tierLimits: [1200000, 2601124, Infinity],
  defaultTier: "1K",
  refs: { max: 10, data: true, maxBytes: 30 * MB },
  extras: Object.assign(
    {
      watermark: bool,
      output_format: oneOf(["jpeg", "png"]),
      background: oneOf(["opaque", "transparent"]),
      layer_decomposition: bool,
      optimize_prompt_options: json,
    },
    NSFW,
  ),
  check: seedreamProCheck,
  // Layer decomposition returns a base image plus up to 16 layers.
  reserve: (body) => (body.layer_decomposition === true ? 17 : 1),
  promptOptional: (raw) => raw.layer_decomposition === true || raw.layer_decomposition === "true",
  billing: ["resolution", "reference_images"],
});

const FLUX_COMMON = Object.assign({ seed: int(0, 4294967295), prompt_upsampling: bool }, NSFW);
const FLUX_KONTEXT = model({
  ratios: RATIOS_FLUX,
  auto: true,
  refs: { max: 4, data: true },
  extras: Object.assign({ output_format: oneOf(["png", "jpeg", "webp"]), safety_tolerance: int(0, 6) }, FLUX_COMMON),
});
function flux2(extra) {
  return model({
    ratios: RATIOS_FLUX,
    auto: true,
    pixels: pixelRange({ minSide: 64, maxArea: 4194304 }),
    tiers: ["1MP", "2MP", "3MP", "4MP"],
    tierAliases: { 512: "1MP", "512p": "1MP", "1m": "1MP", "1k": "2MP", 1024: "2MP", "2k": "3MP", 2048: "3MP", "4k": "4MP" },
    defaultTier: "2MP",
    refs: { max: 8, data: true },
    extras: Object.assign({ output_format: oneOf(["jpeg", "png", "webp"]), safety_tolerance: int(0, 5) }, FLUX_COMMON, extra),
  });
}
const FLUX_2 = flux2({});
const FLUX_2_FLEX = flux2({ steps: int(1, 50), guidance: num(1.5, 10) });
// FLUX 3 rejects unknown fields with HTTP 400, so these extras are complete.
function flux3(extra) {
  return model({
    sizeKey: "aspect_ratio",
    ratios: RATIOS_FLUX_3,
    auto: true,
    tiers: ["768sq", "1k", "1.5k", "2k", "4k"],
    tierAliases: { 768: "768sq" },
    defaultTier: "1k",
    refs: { max: 10, data: true },
    extras: Object.assign({ safety_tolerance: int(0, 4) }, extra),
  });
}
const FLUX_3 = flux3({ grounding: bool });
const FLUX_3_KLEIN = flux3({ seed: int(0, 4294967295), steps: int(1, 16), output_format: oneOf(["jpeg", "png"], { jpg: "jpeg" }) });

const HY_IMAGE = model({
  ratios: RATIOS_10,
  auto: true,
  pixels: pixelRange({ minSide: 256, maxSide: 8192, maxArea: 8294400 }),
  tiers: ["1K", "2K", "4K"],
  defaultTier: "1K",
  // Exact sizes are priced by their short side.
  tierOfPixels: (width, height) => (Math.min(width, height) <= 1024 ? "1K" : Math.min(width, height) <= 2048 ? "2K" : "4K"),
  refs: { max: 5, data: false },
  extras: { negative_prompt: text(), seed: int(0, 2147483647) },
});

const MAI_IMAGE = model({
  // Any whole-number ratio between 1:4 and 4:1.
  ratios: (ratio) => /^\d+:\d+$/.test(ratio) && ratioValue(ratio) >= 0.25 && ratioValue(ratio) <= 4,
  auto: true,
  pixels: pixelRange({ minSide: 768, maxArea: 2359296 }),
  tiers: ["1K", "2K"],
  defaultTier: "1K",
  refs: { max: 5, data: true },
  extras: { auto_aspect_ratio: bool, web_grounding: bool },
});

const QWEN_2 = model({
  ratios: RATIOS_7,
  tiers: ["1K", "2K"],
  defaultTier: "1K",
  maxN: 6,
  // The docs set no reference count limit; this only guards the request size.
  refs: { max: 16, data: false },
  promptMax: 800,
  extras: Object.assign({ negative_prompt: text(500) }, NSFW),
});
const QWEN_3 = model({
  ratios: RATIOS_7,
  pixels: pixelRange({ minSide: 512, maxSide: 2048, maxRatio: 8 }),
  tiers: ["1K", "2K"],
  // Outputs above 2,250,000 pixels are priced as 2K.
  tierLimits: [2250000, Infinity],
  defaultTier: "1K",
  maxN: 6,
  refs: { max: 3, data: true, maxBytes: 10 * MB },
  extras: Object.assign({ negative_prompt: text(), prompt_extend: bool, prompt_extend_mode: oneOf(["direct", "agent"]) }, NSFW),
  check: function (body, info) {
    if (body.prompt_extend_mode === "agent" && info.refs) throw new Error("prompt_extend_mode agent supports text-to-image only");
  },
});
const Z_IMAGE_TURBO = model({
  ratios: RATIOS_7,
  tiers: ["1K", "2K"],
  defaultTier: "1K",
  promptMax: 800,
  extras: Object.assign({ prompt_extend: bool }, NSFW),
  billing: ["resolution", "prompt_extend"],
});

function wan(pro) {
  return model({
    ratios: RATIOS_7,
    pixels: pixelRange({ minArea: 768 * 768, maxArea: pro ? 4096 * 4096 : 2048 * 2048 }),
    tiers: pro ? ["1K", "2K", "4K"] : ["1K", "2K"],
    defaultTier: "2K",
    maxN: 12,
    refs: { max: 9, data: true, maxBytes: 20 * MB },
    promptMax: 5000,
    promptOptional: (raw, refs) => refs > 0,
    extras: Object.assign(
      {
        negative_prompt: text(),
        watermark: bool,
        seed: int(0, 2147483647),
        thinking_mode: bool,
        enable_sequential: bool,
        bbox_list: json,
        color_palette: json,
      },
      NSFW,
    ),
    check: function (body, info) {
      if (info.reserve > 4 && body.enable_sequential !== true) throw new Error("n above 4 requires enable_sequential true");
      if (body.resolution === "4K" && (info.refs || body.enable_sequential === true)) {
        throw new Error("4K is available only for text-to-image without enable_sequential");
      }
    },
    // The price does not depend on resolution or aspect ratio.
    billing: [],
  });
}
const WAN_27_PRO = wan(true);
const WAN_27 = wan(false);

const GROK_15 = model({
  ratios: ["1:1", "16:9", "9:16", "3:2", "2:3"],
  maxN: 10,
  refs: { max: 5, data: false },
  extras: NSFW,
});
function grokImage(refs, extra, billing) {
  return model({
    sizeKey: "aspect_ratio",
    ratios: RATIOS_GROK,
    auto: true,
    tiers: ["1k", "2k"],
    defaultTier: "1k",
    maxN: 10,
    refs: { max: refs, data: false },
    extras: Object.assign({}, NSFW, extra),
    versionHeader: true,
    billing: billing || ["resolution", "reference_images"],
  });
}
const GROK_IMAGE = grokImage(5, {});
const GROK_IMAGE_QUALITY = grokImage(3, {});
const GROK_IMAGE_2 = Object.assign(grokImage(3, { quality: quality(["medium", "low"]) }, ["resolution", "quality", "reference_images"]), {
  qualities: ["medium", "low"],
  check: function (body, info) {
    if (body.quality && info.refs) throw new Error("quality is available only for text-to-image requests without image_urls");
  },
});
const GROK_2_EXT = model({
  ratios: ["1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9"],
  pixelSizes: ["1024x1024", "1024x1792", "1792x1024", "720x1280", "1280x720"],
  maxN: 12,
  extras: NSFW,
  versionHeader: true,
});

const MODEL_GROUPS = [
  [GPT_25, ["gpt-image-2.5-flare", "gpt-image-2.5-sunburst"]],
  [GPT_25_EXT, ["gpt-image-2.5-ext"]],
  [GPT_2, ["gpt-image-2", "gpt-image-2-ext"]],
  [GPT_2_OFFICIAL, ["gpt-image-2-official"]],
  [GPT_1, ["gpt-image-1-official", "gpt-image-1.5-official"]],
  [NANO_BANANA_21, ["gemini-nano-banana-2.1"]],
  [NANO_BANANA_21_EXT, ["gemini-nano-banana-2.1-ext"]],
  [GEMINI_31_FLASH, ["gemini-3.1-flash-image-preview", "nano-banana-2-ext"]],
  [GEMINI_31_FLASH_OFFICIAL, ["gemini-3.1-flash-image-preview-official", "nano-banana-2"]],
  [GEMINI_31_LITE, ["gemini-3.1-flash-lite-image", "nano-banana-2-lite", "gemini-3.1-flash-lite-image-ext", "nano-banana-2-lite-ext"]],
  [GEMINI_3_PRO, ["gemini-3-pro-image-preview", "nano-banana-pro-ext"]],
  [GEMINI_3_PRO_OFFICIAL, ["gemini-3-pro-image-preview-official", "nano-banana-pro"]],
  [GEMINI_25_FLASH, ["gemini-2.5-flash-image-preview", "nano-banana-ext"]],
  [GEMINI_25_FLASH_OFFICIAL, ["gemini-2.5-flash-image-preview-official", "nano-banana"]],
  [IMAGEN_4, ["imagen-4.0-apimart"]],
  [SEEDREAM_4, ["seedream-4.0"]],
  [SEEDREAM_45, ["seedream-4.5"]],
  [SEEDREAM_5_LITE, ["seedream-5-0-lite"]],
  [SEEDREAM_5_PRO, ["seedream-5-0-pro", "seedream-5-0-flash"]],
  [FLUX_KONTEXT, ["flux-kontext-pro", "flux-kontext-max"]],
  [FLUX_2, ["flux-2-pro", "flux-2-max"]],
  [FLUX_2_FLEX, ["flux-2-flex"]],
  [FLUX_3, ["flux-3-image"]],
  [FLUX_3_KLEIN, ["flux-3-image-klein"]],
  [HY_IMAGE, ["hy-image-v3.5-preview"]],
  [MAI_IMAGE, ["mai-image-2.6", "mai-image-2.6-flash"]],
  [QWEN_2, ["qwen-image-2.0", "qwen-image-2.0-pro"]],
  [QWEN_3, ["qwen-image-3.0", "qwen-image-3.0-pro"]],
  [Z_IMAGE_TURBO, ["z-image-turbo"]],
  [WAN_27_PRO, ["wan2.7-image-pro"]],
  [WAN_27, ["wan2.7-image"]],
  [GROK_15, ["grok-imagine-1.5-apimart", "grok-imagine-1.5-ext"]],
  [GROK_IMAGE, ["grok-imagine-image"]],
  [GROK_IMAGE_QUALITY, ["grok-imagine-image-quality"]],
  [GROK_IMAGE_2, ["grok-imagine-image-2.0"]],
  [GROK_2_EXT, ["grok-imagine-2.0-ext"]],
];

const SPECS = {};
for (const [spec, names] of MODEL_GROUPS) for (const name of names) SPECS[name] = spec;
const MODELS = Object.keys(SPECS);

function specFor(name) {
  return Object.prototype.hasOwnProperty.call(SPECS, name) ? SPECS[name] : null;
}

// ---------------------------------------------------------------------------
// Usage schemas

const TOKEN_USAGE_SCHEMA = {
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
};

const TOKEN_USAGE_EXAMPLES = [
  { label: "1:1 · 1K · low", facts: { input_tokens: 16, output_tokens: 196 } },
  { label: "1:1 · 1K · medium", facts: { input_tokens: 16, output_tokens: 439 } },
  { label: "1:1 · 1K · high", facts: { input_tokens: 16, output_tokens: 1756 } },
  { label: "16:9 · 2K · high", facts: { input_tokens: 16, output_tokens: 1413 } },
  { label: "1:1 · 4K · max", facts: { input_tokens: 16, output_tokens: 23719 } },
];

function enumField(values, description) {
  return { enum: values, description: description };
}

// Facts that may price an image besides image_count: the schema field, the
// value reported for a prepared request, and a display label.
const BILLING_FACTS = {
  resolution: {
    field: function (spec) {
      const field = enumField(spec.tiers.map((tier) => tier[0].toLowerCase()), { en: "Resolution tier", zh: "分辨率档位" });
      field.enumLabels = {};
      for (const tier of spec.tiers) field.enumLabels[tier[0].toLowerCase()] = { en: tier[0].toUpperCase().replace("SQ", "sq") };
      return field;
    },
    value: (prep) => prep.tier.toLowerCase(),
  },
  quality: {
    field: (spec) => enumField(spec.qualities, { en: "Quality tier", zh: "质量档位" }),
    value: (prep) => prep.body.quality || prep.spec.qualities[0],
  },
  size: {
    field: (spec) => enumField(spec.ratios, { en: "Image size", zh: "图片尺寸" }),
    value: (prep) => prep.body.size || prep.spec.ratios[0],
  },
  version: {
    field: (spec) => enumField(spec.versions, { en: "Model version", zh: "模型版本" }),
    value: (prep) => prep.body.version || prep.spec.versions[0],
  },
  reference_images: {
    field: () => ({ type: "number", unit: "count", description: { en: "Reference image unit price", zh: "参考图单价" } }),
    value: (prep) => prep.refs,
  },
  prompt_extend: {
    field: () => ({ type: "boolean", description: { en: "Prompt rewriting enabled", zh: "开启智能改写" } }),
    value: (prep) => prep.body.prompt_extend === true,
  },
};

const IMAGE_COUNT_FIELD = {
  type: "number",
  unit: "count",
  description: { en: "Generated image unit price", zh: "生成图片单价" },
};

function imageUsageSchema(spec) {
  const schema = { image_count: IMAGE_COUNT_FIELD };
  for (const key of spec.billing) schema[key] = BILLING_FACTS[key].field(spec);
  return schema;
}

// Display examples: one image at each resolution tier, other facts at their
// first value.
function imageUsageExamples(schema) {
  const tiers = schema.resolution ? schema.resolution.enum : [null];
  return tiers.slice(0, 5).map(function (tier) {
    const facts = {};
    const label = [];
    for (const key of Object.keys(schema)) {
      const field = schema[key];
      if (key === "image_count") facts[key] = 1;
      else if (key === "resolution") facts[key] = tier;
      else if (field.enum) facts[key] = field.enum[0];
      else if (field.type === "boolean") facts[key] = false;
      else facts[key] = 0;
      if (field.enum) label.push(field.enumLabels ? field.enumLabels[facts[key]].en : facts[key]);
    }
    return { label: (label.length ? label.join(" · ") + " · " : "") + "1 image", facts: facts };
  });
}

// Models sharing a schema share one profile. Token-billed models use the
// plugin-level schema.
function buildUsageProfiles() {
  const profiles = [];
  const byKey = {};
  for (const name of MODELS) {
    const spec = SPECS[name];
    if (spec.billing === "tokens") continue;
    const schema = imageUsageSchema(spec);
    const key = JSON.stringify(schema);
    if (!byKey[key]) {
      byKey[key] = { models: [], schema: schema, examples: imageUsageExamples(schema) };
      profiles.push(byKey[key]);
    }
    byKey[key].models.push(name);
  }
  return profiles;
}

export const meta = {
  apiVersion: 1,
  key: "apimart",
  name: "APIMart",
  icon: "text:AM",
  version: "1.1.0",
  author: { name: "newapi-plugin-apimart contributors" },
  website: "https://apimart.ai",
  description: {
    en: "APIMart image models: GPT-Image, Nano Banana, Imagen, Seedream, FLUX, Qwen, Wan, Grok Imagine and more",
    zh: "APIMart 图像模型：GPT-Image、Nano Banana、Imagen、Seedream、FLUX、Qwen、万相、Grok Imagine 等",
  },
  baseUrl: "https://api.apimart.ai",
  // Result images are served from APIMart's upload host; artifact downloads
  // need it in addition to the channel Base URL host.
  allowedHosts: ["upload.apimart.ai"],
  auth: "api_key",
  models: MODELS,
  fetchMode: "per_task",
  protocols: ["openai_image"],
  usageSchema: TOKEN_USAGE_SCHEMA,
  usageExamples: TOKEN_USAGE_EXAMPLES,
  usageProfiles: buildUsageProfiles(),
};

// ---------------------------------------------------------------------------
// Request normalization
//
// prepareRequest turns a client body (OpenAI Images or APIMart shape) into the
// APIMart request body for one model, plus what billing needs to know about
// it. Its body is accepted again as input and yields the same result: the
// host runs decoders more than once and driver hooks receive the decoded body.

// Collect reference images from APIMart's image_urls and the OpenAI-style
// image / images fields. Entries may be strings, {image_url}, {url},
// {image_url: {url}}, or multipart file placeholders.
function referenceImages(value, field, spec) {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.map(function (item) {
    if (isFilePlaceholder(item)) {
      if (!spec.refs.data) throw new Error(URL_ONLY_MESSAGE);
      return item;
    }
    let url = item;
    if (isObject(item)) {
      url = item.image_url !== undefined ? item.image_url : item.url;
      if (isObject(url)) url = url.url;
    }
    url = trimmed(url);
    if (!url) throw new Error(field + " entries must be image URLs");
    if (isHttpUrl(url)) return url;
    if (spec.refs.data && isImageDataUrl(url)) return url;
    throw new Error(spec.refs.data ? field + " entries must be http(s) URLs or data:image/...;base64 data URLs" : URL_ONLY_MESSAGE);
  });
}

const URL_ONLY_MESSAGE =
  "This model only accepts reference images as public http(s) URLs; upload the image first and send its URL in image_urls";

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

function matchTier(spec, value) {
  const key = trimmed(String(value)).toLowerCase();
  if (spec.tierAliases && Object.prototype.hasOwnProperty.call(spec.tierAliases, key)) return spec.tierAliases[key];
  const tier = spec.tiers.find((item) => item[0].toLowerCase() === key);
  return tier ? tier[0] : null;
}

function tierForPixels(spec, width, height) {
  if (spec.tierOfPixels) return spec.tierOfPixels(width, height);
  const area = width * height;
  const tier = spec.tiers.find((item) => area <= item[1]);
  return (tier || spec.tiers[spec.tiers.length - 1])[0];
}

function ratioAllowed(spec, ratio) {
  return typeof spec.ratios === "function" ? spec.ratios(ratio) : spec.ratios.includes(ratio);
}

function nearestRatio(spec, width, height) {
  const target = Math.log(width / height);
  let best = null;
  for (const ratio of spec.ratios) {
    const distance = Math.abs(Math.log(ratioValue(ratio)) - target);
    if (!best || distance < best.distance) best = { ratio: ratio, distance: distance };
  }
  return best ? best.ratio : null;
}

function sizeHint(spec) {
  const forms = [];
  if (spec.auto) forms.push("auto");
  if (Array.isArray(spec.ratios) && spec.ratios.length) forms.push(spec.ratios.join(", "));
  else if (typeof spec.ratios === "function") forms.push("a whole-number aspect ratio");
  if (spec.pixels) forms.push("pixels such as 1600x1200");
  return "size must be " + forms.join(", or ");
}

// Returns {size, tier, pixels}: the size to send, the resolution tier to send
// (null to leave it out) and the exact pixels when the size names them.
function resolveSize(raw, spec) {
  const input = has(raw, "size") ? raw.size : has(raw, "aspect_ratio") ? raw.aspect_ratio : undefined;
  let tier = null;
  if (has(raw, "resolution") && spec.tiers) {
    tier = matchTier(spec, raw.resolution);
    if (!tier) throw new Error("resolution must be one of " + spec.tiers.map((item) => item[0]).join(", "));
  }
  if (input === undefined) return { size: null, tier: tier, pixels: null };

  const source = trimmed(String(input));
  const lower = source.toLowerCase();
  if (lower === "auto") return { size: spec.auto ? "auto" : null, tier: tier, pixels: null };
  // A tier name in size (APIMart allows "2K" there for some models) selects
  // the tier and wins over resolution, as upstream does.
  if (spec.tiers && spec.tiers.some((item) => item[0].toLowerCase() === lower)) {
    return { size: null, tier: matchTier(spec, lower), pixels: null };
  }
  if (spec.pixelSizes && spec.pixelSizes.includes(lower)) return { size: lower, tier: tier, pixels: null };

  let match = /^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/.exec(source);
  let pixels = null;
  if (!match) {
    match = /^(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)$/i.exec(source);
    if (!match) throw new Error(sizeHint(spec));
    // "16x9" is a ratio; "1024x1024" is pixels.
    if (Number(match[1]) >= 64 && Number(match[2]) >= 64) {
      if (!Number.isInteger(Number(match[1])) || !Number.isInteger(Number(match[2]))) throw new Error("size pixels must be whole numbers");
      pixels = { width: Number(match[1]), height: Number(match[2]) };
    }
  }
  if (!pixels) {
    const ratio = ratioText(match[1], match[2]);
    if (!Number(match[1]) || !Number(match[2]) || !ratioAllowed(spec, ratio)) throw new Error(sizeHint(spec));
    return { size: ratio, tier: tier, pixels: null };
  }
  if (spec.pixels) {
    spec.pixels(pixels.width, pixels.height);
    return { size: pixels.width + "x" + pixels.height, tier: tier, pixels: pixels };
  }
  // The model takes no exact sizes: use the closest ratio, and a tier that
  // covers the requested pixels when the client did not choose one.
  if (typeof spec.ratios === "function" || !spec.ratios.length) throw new Error(sizeHint(spec));
  if (!tier && spec.tiers) tier = tierForPixels(spec, pixels.width, pixels.height);
  return { size: nearestRatio(spec, pixels.width, pixels.height), tier: tier, pixels: null };
}

function assertSupported(model) {
  if (!model) throw new Error("model is required");
  const spec = specFor(model);
  if (!spec) throw new Error("Unsupported model " + model + "; use a model listed by the APIMart plugin, or map an alias to one");
  return spec;
}

function prepareRequest(raw, model) {
  const spec = assertSupported(model);
  if (!isObject(raw)) throw new Error("request body must be a JSON object");
  if (has(raw, "stream") && raw.stream !== false && raw.stream !== "false") {
    throw new Error("stream is not supported; the complete image response is returned once generation finishes");
  }

  const hasReferences = ["image_urls", "image", "images"].some((key) => has(raw, key) && !(Array.isArray(raw[key]) && !raw[key].length));
  if (hasReferences && !spec.refs) throw new Error(model + " does not accept reference images");
  const refs = spec.refs
    ? referenceImages(raw.image_urls, "image_urls", spec)
        .concat(referenceImages(raw.image, "image", spec))
        .concat(referenceImages(raw.images, "images", spec))
    : [];
  if (spec.refs && refs.length > spec.refs.max) throw new Error(model + " accepts at most " + spec.refs.max + " reference images");

  const body = { model: model };
  const prompt = trimmed(raw.prompt);
  if (!prompt && !(spec.promptOptional && spec.promptOptional(raw, refs.length))) throw new Error("prompt is required");
  if (prompt) {
    if (spec.promptMax && prompt.length > spec.promptMax) throw new Error("prompt must be at most " + spec.promptMax + " characters");
    body.prompt = prompt;
  }

  const sizing = resolveSize(raw, spec);
  if (sizing.size) body[spec.sizeKey] = sizing.size;
  if (sizing.tier) body.resolution = sizing.tier;

  const n = has(raw, "n") ? integerValue(raw.n, 1, spec.maxN, "n") : 1;
  if (n > 1) body.n = n;

  for (const name of Object.keys(spec.extras)) {
    if (!has(raw, name)) continue;
    const value = spec.extras[name](raw[name], name);
    if (value !== undefined) body[name] = value;
  }

  if (refs.length) body.image_urls = refs;
  if (spec.mask) {
    const mask = has(raw, "mask_url") ? maskValue(raw.mask_url) : maskValue(raw.mask);
    if (mask !== undefined) {
      if (!refs.length) throw new Error("mask requires at least one reference image in image_urls");
      body.mask_url = mask;
    }
  }

  const reserve = spec.reserve ? spec.reserve(body) : n;
  if (spec.check) spec.check(body, { refs: refs.length, reserve: reserve });

  let tier = null;
  if (spec.tiers) tier = sizing.pixels ? tierForPixels(spec, sizing.pixels.width, sizing.pixels.height) : sizing.tier || spec.defaultTier || spec.tiers[0][0];
  return { spec: spec, body: body, refs: refs.length, reserve: reserve, tier: tier };
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
    if (field === "image" || field === "image_urls") {
      // Inlined as data URLs for models that accept them; prepareRequest
      // rejects them for URL-only models.
      raw.image = (raw.image || []).concat([{ __fileRef: file.ref, encoding: "dataUrl" }]);
      continue;
    }
    throw new Error(file.field + " file uploads are not supported");
  }
  return raw;
}

// Uploaded reference files carry the model's size cap once the model is known.
function withFileLimits(body, spec) {
  if (!body.image_urls) return body;
  const maxBytes = spec.refs && spec.refs.maxBytes;
  if (!maxBytes) return body;
  body.image_urls = body.image_urls.map((item) => (isFilePlaceholder(item) && !item.maxBytes ? Object.assign({}, item, { maxBytes: maxBytes }) : item));
  return body;
}

function requestAction(prep) {
  return prep.refs ? "image_edit" : "text_to_image";
}

// The model the vendor sees, after channel model mapping.
function upstreamModel(ctx) {
  return ctx.upstreamModel || ctx.model || (isObject(ctx.requestBody) ? trimmed(ctx.requestBody.model) : "");
}

function prepare(ctx) {
  const prep = prepareRequest(ctx.requestBody, upstreamModel(ctx));
  withFileLimits(prep.body, prep.spec);
  return prep;
}

// ---------------------------------------------------------------------------
// Usage estimation

function estimateOutputTokensPerImage(prep) {
  const body = prep.body;
  const column = prep.spec.tokenColumn;
  const qualityIndex = column[body.quality || "auto"];
  const resolution = body.resolution || "1k";
  const size = body.size || "auto";
  const pixels = /^(\d+)x(\d+)$/.exec(size);

  if (pixels) {
    // Exact pixels: the smallest table size that covers them, else the
    // largest entry scaled by pixel count.
    const area = Number(pixels[1]) * Number(pixels[2]);
    const pixelsOf = (row) => row[2] * row[3];
    let best = null;
    let largest = OUTPUT_TOKEN_TABLE[0];
    for (const row of OUTPUT_TOKEN_TABLE) {
      if (pixelsOf(row) > pixelsOf(largest)) largest = row;
      if (pixelsOf(row) < area) continue;
      // Smallest covering size; among equal sizes, the higher token count.
      if (!best || pixelsOf(row) < pixelsOf(best) || (pixelsOf(row) === pixelsOf(best) && row[4][qualityIndex] > best[4][qualityIndex])) {
        best = row;
      }
    }
    if (best) return best[4][qualityIndex];
    return Math.ceil((largest[4][qualityIndex] * area) / (largest[2] * largest[3]));
  }

  const rows = OUTPUT_TOKEN_TABLE.filter(function (row) {
    return row[1] === resolution && (size === "auto" || row[0] === size);
  });
  return rows.reduce(function (max, row) {
    return Math.max(max, row[4][qualityIndex]);
  }, 0);
}

function estimateTokens(prep) {
  const references = prep.refs + (prep.body.mask_url ? 1 : 0);
  return {
    input_tokens: INPUT_TOKENS_PROMPT_OVERHEAD + (prep.body.prompt || "").length + references * INPUT_TOKENS_PER_REFERENCE_IMAGE,
    output_tokens: estimateOutputTokensPerImage(prep) * prep.reserve,
  };
}

function imageFacts(prep) {
  const facts = { image_count: prep.reserve };
  for (const key of prep.spec.billing) facts[key] = BILLING_FACTS[key].value(prep);
  return facts;
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

// Successful submissions answer code 200, 202 or "success".
function submitAccepted(code) {
  return code === undefined || Number(code) === 200 || Number(code) === 202 || String(code).toLowerCase() === "success";
}

// ---------------------------------------------------------------------------
// Driver hooks

export function buildSubmitRequest(ctx) {
  const prep = prepare(ctx);
  const headers = {
    Authorization: authHeader(ctx),
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (prep.spec.versionHeader) {
    // Grok Imagine's newer endpoints ask for a pinned response version and an
    // idempotency key that stays the same across retries of one task.
    headers["X-APIMart-Response-Version"] = "2026-07-27";
    headers["Idempotency-Key"] = ctx.publicTaskId || utils.uuid();
  }
  return {
    url: apiRoot(ctx) + "/v1/images/generations",
    method: "POST",
    headers: headers,
    body: prep.body,
  };
}

export function parseSubmitResponse(ctx, response) {
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error("APIMart returned HTTP " + response.statusCode);
  }
  const body = response.body;
  if (!isObject(body)) throw new Error("APIMart returned an unreadable submission response");
  if (!submitAccepted(body.code) || (isObject(body.error) && !body.data)) {
    const message = isObject(body.error) ? trimmed(body.error.message) : trimmed(body.message);
    throw new Error("APIMart rejected the task" + (message ? ": " + message : ""));
  }
  const entry = Array.isArray(body.data) ? body.data[0] : body.data;
  const taskId = isObject(entry) ? trimmed(entry.task_id || entry.id) : "";
  if (!taskId) throw new Error("APIMart response has no task_id");
  const result = { taskId: taskId, taskData: body };
  // Per-image billing keeps its submission facts so completion can report a
  // complete fact set with the delivered image count. The task already exists
  // upstream, so a request that no longer prepares only loses the state.
  const spec = specFor(upstreamModel(ctx));
  if (spec && spec.billing !== "tokens" && ctx.requestBody) {
    try {
      result.state = { facts: imageFacts(prepare(ctx)) };
    } catch (error) {
      // Completion then reports image_count alone over the frozen facts.
    }
  }
  return result;
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
  const prep = prepare(ctx);
  if (ctx.usagePurpose === "billing_ratios") return { image_count: prep.reserve };
  if (prep.spec.billing === "tokens") return estimateTokens(prep);
  return imageFacts(prep);
}

// Settlement on completion. Token models settle on the usage APIMart reports;
// per-image models settle on the number of images delivered. Throwing keeps the
// reservation and makes the host log the missing usage instead of billing zero.
export function extractUsageOnComplete(task, result, data) {
  const spec = specFor((task && (task.upstreamModel || task.model)) || "");
  if (spec && spec.billing !== "tokens") {
    const count = imageUrls(data).length;
    if (!count) throw new Error("APIMart task result has no images to bill");
    const state = task && isObject(task.state) && isObject(task.state.facts) ? task.state.facts : {};
    return Object.assign({}, state, { image_count: count });
  }
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
      // not be resolved yet. An unknown name passes through as the client sent
      // it; buildSubmitRequest validates it against the vendor model.
      const known = specFor(trimmed(ctx.upstreamModel)) ? trimmed(ctx.upstreamModel) : specFor(model) ? model : "";
      if (!known) {
        if (!trimmed(raw.prompt) && !has(raw, "image_urls") && !has(raw, "image")) throw new Error("prompt is required");
        const action = has(raw, "image_urls") || has(raw, "image") || has(raw, "images") ? "image_edit" : "text_to_image";
        return { kind: "submit", model: model, action: action, requestBody: raw };
      }
      const prep = prepareRequest(raw, known);
      if (ctx.operation === "edit" && !prep.refs) {
        throw new Error("image editing requires at least one reference image in image_urls");
      }
      prep.body.model = model;
      return { kind: "submit", model: model, action: requestAction(prep), requestBody: prep.body };
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
