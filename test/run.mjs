// Local hook tests for the latest plugin.js. Run: node test/run.mjs
// These call each hook the way the New API host does, with responses shaped
// like APIMart's documented API. They do not contact any network service.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import path from "node:path";

globalThis.utils = { unixNow: () => 1780000000, uuid: () => "uuid" };

const VERSION = "1.1.0";
const plugin = await import(pathToFileURL(path.resolve(import.meta.dirname, "../plugins/tasks/apimart", VERSION, "plugin.js")).href);
const image = plugin.protocols.openai_image;

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log("ok   " + name);
  } catch (error) {
    console.error("FAIL " + name + "\n     " + error.message);
    process.exitCode = 1;
  }
}

const channel = {
  baseUrl: "https://api.apimart.ai",
  apiKey: "sk-test",
  authHeader: "Bearer sk-test",
  upstream: { kind: "vendor" },
};

function decode(value, operation = "generate", model = "gpt-image-2.5-flare") {
  return image.decodeRequest({ protocol: "openai_image", operation, model, stream: false, body: { kind: "json", value } });
}

// The APIMart body buildSubmitRequest sends for a client body.
function submitBody(model, value) {
  const requestBody = decode(value, "generate", model).requestBody;
  return plugin.buildSubmitRequest({ ...channel, model, upstreamModel: model, publicTaskId: "task_pub", requestBody }).body;
}

function facts(model, value, extra = {}) {
  return plugin.extractUsage({ ...channel, model, upstreamModel: model, requestBody: decode(value, "generate", model).requestBody, ...extra });
}

const completed = {
  code: 200,
  data: {
    id: "task_01K",
    status: "completed",
    progress: 100,
    result: { images: [{ url: ["https://upload.apimart.ai/f/image/a.png"], expires_at: 1789000000 }] },
    usage: { input_tokens: 16, output_tokens: 439, total_tokens: 455 },
  },
};

// --- meta -----------------------------------------------------------------
test("meta declares required fields and openai_image", () => {
  const m = plugin.meta;
  assert.equal(m.apiVersion, 1);
  assert.equal(m.version, VERSION);
  assert.ok(m.key.length <= 30);
  assert.deepEqual(m.protocols, ["openai_image"]);
  assert.equal(new Set(m.models).size, m.models.length, "model names are unique");
  for (const ex of m.usageExamples) assert.deepEqual(Object.keys(ex.facts).sort(), Object.keys(m.usageSchema).sort());
});

test("usage profiles are valid: declared models, at most one profile each, complete examples", () => {
  const seen = new Set();
  for (const profile of plugin.meta.usageProfiles) {
    assert.ok(profile.models.length > 0);
    for (const name of profile.models) {
      assert.ok(plugin.meta.models.includes(name), name + " is declared");
      assert.ok(!seen.has(name), name + " is in one profile");
      seen.add(name);
    }
    assert.ok(profile.examples.length > 0);
    for (const ex of profile.examples) {
      assert.deepEqual(Object.keys(ex.facts).sort(), Object.keys(profile.schema).sort(), ex.label);
      for (const [key, value] of Object.entries(ex.facts)) {
        const field = profile.schema[key];
        if (field.enum) assert.ok(field.enum.includes(value), ex.label + " " + key);
      }
    }
  }
  // Token-billed models keep the plugin-level schema.
  for (const name of ["gpt-image-2.5-flare", "gpt-image-2.5-sunburst", "gpt-image-2-official"]) assert.ok(!seen.has(name));
  assert.equal(seen.size + 3, plugin.meta.models.length);
});

test("every model accepts a minimal prompt and reserves usage", () => {
  for (const name of plugin.meta.models) {
    const body = submitBody(name, { prompt: "a cat" });
    assert.equal(body.model, name);
    assert.equal(body.prompt, "a cat");
    const usage = facts(name, { prompt: "a cat" });
    assert.ok(usage.image_count === 1 || usage.output_tokens > 0, name);
  }
});

test("every model's normalized body decodes to itself", () => {
  const inputs = [
    { prompt: "p", size: "1024x1024", n: 1, quality: "auto", response_format: "b64_json", user: "u" },
    { prompt: "p", size: "16:9", resolution: "2k" },
    { prompt: "p", size: "auto" },
  ];
  for (const name of plugin.meta.models) {
    for (const input of inputs) {
      let once;
      try {
        once = decode(input, "generate", name).requestBody;
      } catch (error) {
        continue; // not every input is valid for every model
      }
      assert.deepEqual(decode(once, "generate", name).requestBody, once, name + " " + JSON.stringify(input));
    }
  }
});

// --- GPT-Image-2.5 (unchanged behavior from 1.0.0) --------------------------
test("decode text-to-image keeps the client model and drops response_format", () => {
  const intent = decode({ model: "x", prompt: " a cat ", size: "16:9", resolution: "2K", quality: "high", n: 2, response_format: "b64_json", user: "u1" });
  assert.equal(intent.kind, "submit");
  assert.equal(intent.model, "gpt-image-2.5-flare");
  assert.equal(intent.action, "text_to_image");
  assert.deepEqual(intent.requestBody, { model: "gpt-image-2.5-flare", prompt: "a cat", size: "16:9", resolution: "2k", quality: "high", n: 2 });
});

test("decode maps DALL-E quality names and accepts OpenAI images[] URLs", () => {
  const intent = decode({ prompt: "p", quality: "hd", images: [{ image_url: "https://e.com/a.png" }, "https://e.com/b.png"] }, "edit");
  assert.equal(intent.requestBody.quality, "high");
  assert.deepEqual(intent.requestBody.image_urls, ["https://e.com/a.png", "https://e.com/b.png"]);
  assert.equal(intent.action, "image_edit");
});

test("decode accepts a PNG data URL mask with image_urls", () => {
  const intent = decode({ prompt: "p", image_urls: ["https://e.com/a.png"], mask_url: "data:image/png;base64,AAAA" }, "edit");
  assert.equal(intent.requestBody.mask_url, "data:image/png;base64,AAAA");
});

test("decode is idempotent on its own output", () => {
  const once = decode({ prompt: "p", size: "1600x1200", quality: "xhigh", image_urls: ["https://e.com/a.png"] }).requestBody;
  const twice = decode(once).requestBody;
  assert.deepEqual(twice, once);
});

for (const [name, body, message] of [
  ["missing prompt", { prompt: "  " }, /prompt is required/],
  ["bad quality", { prompt: "p", quality: "ultra" }, /quality must be one of/],
  ["n out of range", { prompt: "p", n: 5 }, /n must be an integer between 1 and 4/],
  ["n as fraction", { prompt: "p", n: 1.5 }, /n must be an integer/],
  ["size not multiple of 16", { prompt: "p", size: "1000x1000" }, /multiples of 16/],
  ["size too wide", { prompt: "p", size: "3840x1024" }, /3:1/],
  ["size too small", { prompt: "p", size: "512x512" }, /655,360/],
  ["unknown ratio", { prompt: "p", size: "7:5" }, /size must be/],
  ["transparent jpeg", { prompt: "p", background: "transparent", output_format: "jpeg" }, /png or webp/],
  ["data URL reference image", { prompt: "p", image_urls: ["data:image/png;base64,AAAA"] }, /public http\(s\) URLs/],
  ["too many references", { prompt: "p", image_urls: Array.from({ length: 17 }, (_, i) => "https://e.com/" + i + ".png") }, /at most 16/],
  ["mask without image", { prompt: "p", mask_url: "https://e.com/m.png" }, /requires at least one reference image/],
  ["jpeg mask data URL", { prompt: "p", image_urls: ["https://e.com/a.png"], mask_url: "data:image/jpeg;base64,AA" }, /data:image\/png/],
  ["stream true", { prompt: "p", stream: true }, /stream is not supported/],
  ["bad response_format", { prompt: "p", response_format: "png" }, /response_format/],
]) {
  test("decode rejects " + name, () => assert.throws(() => decode(body), message));
}

test("edit without reference image is rejected", () => {
  assert.throws(() => decode({ prompt: "p" }, "edit"), /requires at least one reference image/);
});

test("multipart: repeated and JSON image_urls, numeric n, mask file becomes a PNG data URL placeholder", () => {
  const intent = image.decodeRequest({
    operation: "edit",
    model: "gpt-image-2.5-sunburst",
    body: {
      kind: "multipart",
      fields: { prompt: ["edit it"], n: ["2"], "image_urls[]": ["https://e.com/a.png", '["https://e.com/b.png"]'] },
      files: [{ ref: "request_file:mask", field: "mask", filename: "m.png", mimeType: "image/png", size: 10 }],
    },
  });
  assert.equal(intent.requestBody.n, 2);
  assert.deepEqual(intent.requestBody.image_urls, ["https://e.com/a.png", "https://e.com/b.png"]);
  assert.deepEqual(intent.requestBody.mask_url, { __fileRef: "request_file:mask", encoding: "dataUrl", mimeType: "image/png", maxBytes: 4194304 });
});

test("multipart image file upload is rejected with guidance for URL-only models", () => {
  assert.throws(
    () =>
      image.decodeRequest({
        operation: "edit",
        model: "gpt-image-2.5-flare",
        body: { kind: "multipart", fields: { prompt: ["p"] }, files: [{ ref: "request_file:image", field: "image[]", filename: "a.png", mimeType: "image/png", size: 1 }] },
      }),
    /send its URL in image_urls/,
  );
});

// --- other models: sizes, tiers, references --------------------------------
test("OpenAI pixel sizes become the nearest ratio and a covering tier on ratio-only models", () => {
  assert.deepEqual(submitBody("gemini-3-pro-image-preview", { prompt: "p", size: "1024x1024" }), {
    model: "gemini-3-pro-image-preview",
    prompt: "p",
    size: "1:1",
    resolution: "1K",
  });
  const wide = submitBody("gemini-3-pro-image-preview", { prompt: "p", size: "2752x1536" });
  assert.equal(wide.size, "16:9");
  assert.equal(wide.resolution, "2K");
  // An explicit resolution wins over the inferred one.
  assert.equal(submitBody("gemini-3-pro-image-preview", { prompt: "p", size: "1024x1024", resolution: "4k" }).resolution, "4K");
  assert.equal(submitBody("imagen-4.0-apimart", { prompt: "p", size: "1792x1024" }).size, "16:9");
  assert.equal(submitBody("gpt-image-1-official", { prompt: "p", size: "1536x1024" }).size, "3:2");
});

test("size auto is dropped for models without it and ratios accept the x form", () => {
  assert.equal(submitBody("imagen-4.0-apimart", { prompt: "p", size: "auto" }).size, undefined);
  assert.equal(submitBody("seedream-5-0-pro", { prompt: "p", size: "16x9" }).size, "16:9");
});

test("resolution tiers keep APIMart's spelling and aliases", () => {
  assert.equal(submitBody("gpt-image-2.5-ext", { prompt: "p", resolution: "2k" }).resolution, "2K");
  assert.equal(submitBody("gpt-image-2", { prompt: "p", resolution: "2K" }).resolution, "2k");
  assert.equal(submitBody("flux-2-pro", { prompt: "p", resolution: "1K" }).resolution, "2MP");
  assert.equal(submitBody("flux-3-image", { prompt: "p", resolution: "768" }).resolution, "768sq");
  assert.equal(submitBody("grok-imagine-image", { prompt: "p", resolution: "2K" }).resolution, "2k");
  assert.throws(() => submitBody("seedream-4.5", { prompt: "p", resolution: "1K" }), /resolution must be one of 2K, 4K/);
  assert.throws(() => submitBody("gemini-3.1-flash-lite-image", { prompt: "p", resolution: "2K" }), /resolution must be one of 1K/);
});

test("a tier in size selects the resolution", () => {
  const body = submitBody("seedream-5-0-pro", { prompt: "p", size: "1.5K" });
  assert.equal(body.size, undefined);
  assert.equal(body.resolution, "1.5K");
  assert.equal(submitBody("wan2.7-image-pro", { prompt: "p", size: "4K" }).resolution, "4K");
});

test("models with their own aspect_ratio field receive it", () => {
  assert.deepEqual(submitBody("flux-3-image", { prompt: "p", size: "16:9" }), { model: "flux-3-image", prompt: "p", aspect_ratio: "16:9" });
  assert.equal(submitBody("grok-imagine-image-2.0", { prompt: "p", aspect_ratio: "9:19.5" }).aspect_ratio, "9:19.5");
});

test("exact pixel sizes follow each model's documented limits", () => {
  assert.equal(submitBody("flux-2-pro", { prompt: "p", size: "1920x1080" }).size, "1920x1080");
  assert.throws(() => submitBody("flux-2-pro", { prompt: "p", size: "4096x4096" }), /at most 4194304 pixels/);
  assert.throws(() => submitBody("mai-image-2.6", { prompt: "p", size: "512x512" }), /at least 768/);
  assert.throws(() => submitBody("qwen-image-3.0", { prompt: "p", size: "4096x512" }), /exceed 2048/);
  assert.throws(() => submitBody("seedream-5-0-pro", { prompt: "p", size: "800x800" }), /at least 921600/);
  assert.equal(submitBody("grok-imagine-2.0-ext", { prompt: "p", size: "1024x1792" }).size, "1024x1792");
  assert.equal(submitBody("grok-imagine-2.0-ext", { prompt: "p", size: "2048x2048" }).size, "1:1");
});

test("whitelists drop fields a model does not take", () => {
  // FLUX 3 rejects unknown fields upstream, so OpenAI extras must not reach it.
  assert.deepEqual(submitBody("flux-3-image", { prompt: "p", nsfw_check: true, output_format: "png", seed: 1, quality: "high", grounding: "false" }), {
    model: "flux-3-image",
    prompt: "p",
    grounding: false,
  });
  assert.deepEqual(submitBody("flux-3-image-klein", { prompt: "p", seed: "7", output_format: "jpg", grounding: true }), {
    model: "flux-3-image-klein",
    prompt: "p",
    seed: 7,
    output_format: "jpeg",
  });
  // grok-imagine-image must never receive quality.
  assert.equal(submitBody("grok-imagine-image", { prompt: "p", quality: "high" }).quality, undefined);
  assert.equal(submitBody("grok-imagine-image-2.0", { prompt: "p", quality: "standard" }).quality, "medium");
});

test("n limits follow the model", () => {
  assert.throws(() => submitBody("gemini-3-pro-image-preview", { prompt: "p", n: 2 }), /between 1 and 1/);
  assert.equal(submitBody("qwen-image-2.0", { prompt: "p", n: 6 }).n, 6);
  assert.equal(submitBody("z-image-turbo", { prompt: "p", n: 1 }).n, undefined);
  assert.throws(() => submitBody("wan2.7-image", { prompt: "p", n: 6 }), /enable_sequential/);
  assert.equal(submitBody("wan2.7-image", { prompt: "p", n: 6, enable_sequential: true }).n, 6);
});

test("reference images: data URLs where allowed, URL-only elsewhere, none for text-only models", () => {
  const data = "data:image/png;base64,AAAA";
  assert.deepEqual(submitBody("gemini-3-pro-image-preview", { prompt: "p", image: data }).image_urls, [data]);
  assert.throws(() => submitBody("grok-imagine-image", { prompt: "p", image_urls: [data] }), /public http\(s\) URLs/);
  assert.throws(() => submitBody("imagen-4.0-apimart", { prompt: "p", image_urls: ["https://e.com/a.png"] }), /does not accept reference images/);
  assert.throws(() => submitBody("grok-imagine-image-quality", { prompt: "p", image_urls: ["1", "2", "3", "4"].map((i) => "https://e.com/" + i) }), /at most 3/);
  assert.equal(submitBody("imagen-4.0-apimart", { prompt: "p", image_urls: [] }).image_urls, undefined);
});

test("multipart image files are inlined as data URLs with the model's size cap", () => {
  const intent = image.decodeRequest({
    operation: "edit",
    model: "seedream-4.0",
    body: { kind: "multipart", fields: { prompt: ["p"] }, files: [{ ref: "request_file:image", field: "image", filename: "a.png", mimeType: "image/png", size: 1 }] },
  });
  assert.equal(intent.action, "image_edit");
  const req = plugin.buildSubmitRequest({ ...channel, model: "seedream-4.0", upstreamModel: "seedream-4.0", requestBody: intent.requestBody });
  assert.deepEqual(req.body.image_urls, [{ __fileRef: "request_file:image", encoding: "dataUrl", maxBytes: 10485760 }]);
});

test("model-specific rules", () => {
  const url = "https://e.com/a.png";
  assert.throws(() => submitBody("seedream-4.0", { prompt: "p", n: 3 }), /requires at least one reference image/);
  assert.equal(submitBody("seedream-5-0-lite", { prompt: "p", n: 3 }).n, 3);
  assert.throws(() => submitBody("seedream-4.0", { prompt: "p", n: 10, image_urls: Array(6).fill(url) }), /must not exceed 15/);
  assert.throws(() => submitBody("seedream-5-0-pro", { prompt: "p", background: "transparent", image_urls: [url] }), /output_format png/);
  assert.throws(() => submitBody("seedream-5-0-pro", { layer_decomposition: true }), /exactly one reference image/);
  assert.equal(submitBody("seedream-5-0-pro", { layer_decomposition: true, image_urls: [url] }).layer_decomposition, true);
  assert.throws(() => submitBody("gemini-3.1-flash-image-preview", { prompt: "p", google_image_search: true }), /google_search true/);
  assert.throws(() => submitBody("grok-imagine-image-2.0", { prompt: "p", quality: "low", image_urls: [url] }), /text-to-image/);
  assert.throws(() => submitBody("qwen-image-3.0", { prompt: "p", prompt_extend: true, prompt_extend_mode: "agent", image_urls: [url] }), /text-to-image only/);
  assert.throws(() => submitBody("wan2.7-image-pro", { prompt: "p", resolution: "4K", image_urls: [url] }), /4K/);
  assert.equal(submitBody("wan2.7-image", { image_urls: [url] }).prompt, undefined);
  assert.throws(() => submitBody("qwen-image-2.0", { prompt: "x".repeat(801) }), /at most 800/);
});

test("Grok Imagine official models send the response version and idempotency headers", () => {
  const requestBody = decode({ prompt: "p" }, "generate", "grok-imagine-image").requestBody;
  const req = plugin.buildSubmitRequest({ ...channel, model: "grok-imagine-image", upstreamModel: "grok-imagine-image", publicTaskId: "task_pub", requestBody });
  assert.equal(req.headers["X-APIMart-Response-Version"], "2026-07-27");
  assert.equal(req.headers["Idempotency-Key"], "task_pub");
  const plain = plugin.buildSubmitRequest({ ...channel, model: "seedream-4.0", upstreamModel: "seedream-4.0", requestBody: { prompt: "p" } });
  assert.equal(plain.headers["Idempotency-Key"], undefined);
});

test("decode passes unknown aliases through for buildSubmitRequest to resolve", () => {
  const intent = decode({ prompt: "p", size: "1024x1024", image: "https://e.com/a.png" }, "edit", "my-alias");
  assert.equal(intent.model, "my-alias");
  assert.equal(intent.action, "image_edit");
  const req = plugin.buildSubmitRequest({ ...channel, model: "my-alias", upstreamModel: "nano-banana-pro", requestBody: intent.requestBody });
  assert.deepEqual(req.body, { model: "nano-banana-pro", prompt: "p", size: "1:1", resolution: "1K", image_urls: ["https://e.com/a.png"] });
});

// --- buildSubmitRequest ---------------------------------------------------
test("buildSubmitRequest targets /v1/images/generations with the mapped upstream model", () => {
  const requestBody = decode({ prompt: "p", size: "1:1" }, "generate", "my-alias").requestBody;
  const req = plugin.buildSubmitRequest({ ...channel, baseUrl: "https://api.apimart.ai/v1/", model: "my-alias", upstreamModel: "gpt-image-2.5-sunburst", requestBody });
  assert.equal(req.url, "https://api.apimart.ai/v1/images/generations");
  assert.equal(req.method, "POST");
  assert.equal(req.headers.Authorization, "Bearer sk-test");
  assert.equal(req.body.model, "gpt-image-2.5-sunburst");
  assert.equal(req.model, undefined, "descriptor must not set top-level model");
});

test("buildSubmitRequest rejects an unmapped unknown model", () => {
  assert.throws(() => plugin.buildSubmitRequest({ ...channel, model: "dall-e-3", upstreamModel: "dall-e-3", requestBody: { prompt: "p" } }), /Unsupported model/);
});

test("buildSubmitRequest accepts the raw generic /v1/tasks body", () => {
  const req = plugin.buildSubmitRequest({ ...channel, model: "gpt-image-2.5-flare", upstreamModel: "gpt-image-2.5-flare", requestBody: { model: "gpt-image-2.5-flare", prompt: "p", quality: "low" } });
  assert.deepEqual(req.body, { model: "gpt-image-2.5-flare", prompt: "p", quality: "low" });
});

// --- submit / poll --------------------------------------------------------
test("parseSubmitResponse reads data[0].task_id, data.id (202) and code success", () => {
  const out = plugin.parseSubmitResponse(channel, { statusCode: 200, headers: {}, body: { code: 200, data: [{ status: "submitted", task_id: "task_01K" }] } });
  assert.equal(out.taskId, "task_01K");
  const grok = plugin.parseSubmitResponse(channel, {
    statusCode: 202,
    headers: {},
    body: { code: 202, request_id: "r", data: { id: "task_02", object: "generation.task", status: "pending", progress: 0, poll_url: "/v1/tasks/task_02" } },
  });
  assert.equal(grok.taskId, "task_02");
  const wan = plugin.parseSubmitResponse(channel, { statusCode: 200, headers: {}, body: { code: "success", data: [{ task_id: "task_03", status: "processing" }] } });
  assert.equal(wan.taskId, "task_03");
});

test("parseSubmitResponse rejects a body without task_id or with an error code", () => {
  assert.throws(() => plugin.parseSubmitResponse(channel, { statusCode: 200, headers: {}, body: { code: 200, data: [] } }), /no task_id/);
  assert.throws(() => plugin.parseSubmitResponse(channel, { statusCode: 200, headers: {}, body: { code: 402, message: "余额不足" } }), /余额不足/);
});

test("parseSubmitResponse keeps per-image facts in state", () => {
  const requestBody = decode({ prompt: "p", resolution: "2K", n: 2 }, "generate", "qwen-image-3.0-pro").requestBody;
  const out = plugin.parseSubmitResponse(
    { ...channel, model: "qwen-image-3.0-pro", upstreamModel: "qwen-image-3.0-pro", requestBody },
    { statusCode: 200, headers: {}, body: { code: 200, data: [{ status: "submitted", task_id: "t" }] } },
  );
  assert.deepEqual(out.state, { facts: { image_count: 2, resolution: "2k" } });
  const tokens = plugin.parseSubmitResponse(
    { ...channel, model: "gpt-image-2.5-flare", upstreamModel: "gpt-image-2.5-flare", requestBody: { prompt: "p" } },
    { statusCode: 200, headers: {}, body: { code: 200, data: [{ status: "submitted", task_id: "t" }] } },
  );
  assert.equal(tokens.state, undefined);
});

test("buildQueryRequest targets /v1/tasks/{id}", () => {
  const req = plugin.buildQueryRequest({ ...channel, taskId: "task_01K" });
  assert.equal(req.url, "https://api.apimart.ai/v1/tasks/task_01K");
  assert.equal(req.method, "GET");
});

test("parseTaskResult maps statuses and progress", () => {
  const ok = { status: 200, headers: {} };
  assert.deepEqual(plugin.parseTaskResult({}, { code: 200, data: { status: "submitted" } }, ok), { status: "SUBMITTED" });
  assert.deepEqual(plugin.parseTaskResult({}, { code: 200, data: { status: "processing", progress: 42.4 } }, ok), { status: "IN_PROGRESS", progress: "42%" });
  const done = plugin.parseTaskResult({}, completed, ok);
  assert.equal(done.status, "SUCCESS");
  assert.equal(done.url, "https://upload.apimart.ai/f/image/a.png");
  const failed = plugin.parseTaskResult({}, { code: 200, data: { status: "failed", error: { message: "content blocked" } } }, ok);
  assert.deepEqual(failed, { status: "FAILURE", progress: "100%", reason: "content blocked" });
  assert.equal(plugin.parseTaskResult({}, { code: 200, data: { status: "weird" } }, ok).status, "UNKNOWN");
  assert.equal(plugin.parseTaskResult({}, { error: { message: "bad" } }, { status: 400, headers: {} }).status, "UNKNOWN");
});

test("parseTaskResult reads Seedream 5.0 Pro's unwrapped success snapshot", () => {
  const body = { id: "t", status: "success", progress: 100, cost: 0.045, result: { images: [{ url: ["https://cdn.example.com/a.png"], sizes: ["2048x1152"] }] } };
  const r = plugin.parseTaskResult({}, body, { status: 200, headers: {} });
  assert.equal(r.status, "SUCCESS");
  assert.equal(r.url, "https://cdn.example.com/a.png");
});

test("completed task without images fails instead of succeeding empty", () => {
  const r = plugin.parseTaskResult({}, { code: 200, data: { status: "completed", result: { images: [] } } }, { status: 200, headers: {} });
  assert.equal(r.status, "FAILURE");
});

// --- usage ----------------------------------------------------------------
function usage(value, extra = {}) {
  return facts("gpt-image-2.5-flare", value, extra);
}

test("extractUsage reserves table output tokens times n", () => {
  assert.equal(usage({ prompt: "p", size: "1:1", quality: "medium" }).output_tokens, 439);
  assert.equal(usage({ prompt: "p", size: "16:9", resolution: "2k", quality: "high", n: 3 }).output_tokens, 1413 * 3);
});

test("extractUsage reserves the max tier for quality auto and size auto", () => {
  assert.equal(usage({ prompt: "p" }).output_tokens, 7024);
  assert.equal(usage({ prompt: "p", resolution: "4k" }).output_tokens, 23719);
});

test("extractUsage covers exact pixel sizes with the smallest larger table size", () => {
  // 1600x1200 = 1.92M px; the smallest covering table size is 2048x1024 (2:1 at 1k).
  assert.equal(usage({ prompt: "p", size: "1600x1200", quality: "medium" }).output_tokens, 295);
  assert.ok(usage({ prompt: "p", size: "3840x2160", quality: "max" }).output_tokens >= 13342);
});

test("extractUsage reserves input tokens for reference images", () => {
  const u = usage({ prompt: "pp", image_urls: ["https://e.com/a.png", "https://e.com/b.png"] });
  assert.equal(u.input_tokens, 64 + 2 + 2 * 3000);
});

test("extractUsage returns image_count ratio for legacy per-call pricing", () => {
  assert.deepEqual(usage({ prompt: "p", n: 3 }, { usagePurpose: "billing_ratios" }), { image_count: 3 });
  assert.deepEqual(facts("seedream-5-0-lite", { prompt: "p", n: 4 }, { usagePurpose: "billing_ratios" }), { image_count: 4 });
});

test("gpt-image-2-official reserves tokens with gpt-image-2 quality weights", () => {
  assert.equal(facts("gpt-image-2-official", { prompt: "p", size: "1:1", quality: "low" }).output_tokens, 196);
  assert.equal(facts("gpt-image-2-official", { prompt: "p", size: "1:1", quality: "high" }).output_tokens, 7024);
});

test("per-image facts carry the tier, references and other price facts", () => {
  assert.deepEqual(facts("gemini-3-pro-image-preview", { prompt: "p", size: "2752x1536" }), { image_count: 1, resolution: "2k" });
  assert.deepEqual(facts("seedream-4.0", { prompt: "p" }), { image_count: 1, resolution: "2k" });
  assert.deepEqual(facts("hy-image-v3.5-preview", { prompt: "p", size: "3000x1500" }), { image_count: 1, resolution: "2k" });
  assert.deepEqual(facts("qwen-image-3.0-pro", { prompt: "p", size: "2048x1152" }), { image_count: 1, resolution: "2k" });
  assert.deepEqual(facts("qwen-image-3.0-pro", { prompt: "p", size: "1600x900" }), { image_count: 1, resolution: "1k" });
  assert.deepEqual(facts("gpt-image-1-official", { prompt: "p", size: "2:3", quality: "hd", n: 2 }), { image_count: 2, size: "2:3", quality: "high" });
  assert.deepEqual(facts("gpt-image-2.5-ext", { prompt: "p", version: "sunburst", resolution: "4K" }), { image_count: 1, version: "sunburst", resolution: "4k" });
  assert.deepEqual(facts("grok-imagine-image-2.0", { prompt: "p", n: 3 }), { image_count: 3, resolution: "1k", quality: "medium", reference_images: 0 });
  assert.deepEqual(facts("z-image-turbo", { prompt: "p", prompt_extend: true }), { image_count: 1, resolution: "1k", prompt_extend: true });
  assert.deepEqual(facts("wan2.7-image-pro", { prompt: "p", resolution: "4K", n: 2 }), { image_count: 2 });
  assert.deepEqual(facts("seedream-5-0-pro", { prompt: "p", size: "2048x2048", image_urls: ["https://e.com/a", "https://e.com/b"] }), {
    image_count: 1,
    resolution: "2k",
    reference_images: 2,
  });
});

test("Seedream reserves group and layer outputs", () => {
  const url = "https://e.com/a.png";
  assert.equal(facts("seedream-4.0", { prompt: "p", image_urls: [url], sequential_image_generation: "auto", sequential_image_generation_options: { max_images: 5 } }).image_count, 5);
  assert.equal(facts("seedream-5-0-pro", { layer_decomposition: true, image_urls: [url] }).image_count, 17);
});

test("extractUsageOnComplete settles tokens on reported usage and refuses to bill zero when missing", () => {
  assert.deepEqual(plugin.extractUsageOnComplete({}, { status: "SUCCESS" }, completed), { input_tokens: 16, output_tokens: 439 });
  assert.throws(() => plugin.extractUsageOnComplete({}, { status: "SUCCESS" }, { code: 200, data: { status: "completed" } }), /no usage/);
});

test("extractUsageOnComplete settles per-image models on delivered images over the submission facts", () => {
  const data = { code: 200, data: { status: "completed", result: { images: [{ url: ["https://e.com/1.png", "https://e.com/2.png"] }] } } };
  const task = { model: "seedream-5-0-lite", upstreamModel: "seedream-5-0-lite", state: { facts: { image_count: 4, resolution: "3k" } } };
  assert.deepEqual(plugin.extractUsageOnComplete(task, { status: "SUCCESS" }, data), { image_count: 2, resolution: "3k" });
  assert.deepEqual(plugin.extractUsageOnComplete({ model: "seedream-5-0-lite" }, { status: "SUCCESS" }, data), { image_count: 2 });
  assert.throws(() => plugin.extractUsageOnComplete(task, { status: "SUCCESS" }, { code: 200, data: { status: "completed" } }), /no images/);
});

// --- artifacts & render ---------------------------------------------------
const multi = { code: 200, data: { status: "completed", result: { images: [{ url: ["https://upload.apimart.ai/a.png", "https://upload.apimart.ai/b.webp"] }, { url: "https://upload.apimart.ai/c.jpg" }] } } };

test("listArtifacts flattens image URLs", () => {
  assert.deepEqual(plugin.listArtifacts({ status: "SUCCESS", data: multi }), [
    { key: "image-1", type: "image", mimeType: "image/png" },
    { key: "image-2", type: "image", mimeType: "image/webp" },
    { key: "image-3", type: "image", mimeType: "image/jpeg" },
  ]);
  assert.deepEqual(plugin.listArtifacts({ status: "IN_PROGRESS", data: multi }), []);
});

test("buildContentRequest fetches the selected image without credentials", () => {
  const req = plugin.buildContentRequest({ ...channel, artifactKey: "image-3", data: multi, clientRequest: { method: "GET", headers: {} } });
  assert.deepEqual(req, { url: "https://upload.apimart.ai/c.jpg", method: "GET", credentialless: true });
  assert.throws(() => plugin.buildContentRequest({ ...channel, artifactKey: "image-9", data: multi, clientRequest: { method: "GET", headers: {} } }), /artifact_not_found/);
});

test("render returns an OpenAI ImageResponse", () => {
  const out = image.render({}, { task_id: "t", status: "SUCCESS", created_at: 1780000000, data: completed });
  assert.deepEqual(out, { created: 1780000000, data: [{ url: "https://upload.apimart.ai/f/image/a.png" }] });
});

console.log("\n" + passed + " passed" + (process.exitCode ? ", some failed" : ""));
