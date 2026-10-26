// Local hook tests for plugin.js. Run: node test/run.mjs
// These call each hook the way the New API host does, with responses shaped
// like APIMart's documented API. They do not contact any network service.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import path from "node:path";

globalThis.utils = { unixNow: () => 1780000000, uuid: () => "uuid" };

const plugin = await import(pathToFileURL(path.resolve(import.meta.dirname, "../plugin.js")).href);
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
  assert.ok(m.key.length <= 30);
  assert.deepEqual(m.protocols, ["openai_image"]);
  for (const ex of m.usageExamples) assert.deepEqual(Object.keys(ex.facts).sort(), Object.keys(m.usageSchema).sort());
});

// --- decode ---------------------------------------------------------------
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

test("multipart image file upload is rejected with guidance", () => {
  assert.throws(
    () =>
      image.decodeRequest({
        operation: "edit",
        model: "gpt-image-2.5-flare",
        body: { kind: "multipart", fields: { prompt: ["p"] }, files: [{ ref: "request_file:image", field: "image[]", filename: "a.png", mimeType: "image/png", size: 1 }] },
      }),
    /send them in image_urls/,
  );
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
test("parseSubmitResponse reads data[0].task_id", () => {
  const out = plugin.parseSubmitResponse(channel, { statusCode: 200, headers: {}, body: { code: 200, data: [{ status: "submitted", task_id: "task_01K" }] } });
  assert.equal(out.taskId, "task_01K");
});

test("parseSubmitResponse rejects a body without task_id or with an error code", () => {
  assert.throws(() => plugin.parseSubmitResponse(channel, { statusCode: 200, headers: {}, body: { code: 200, data: [] } }), /no task_id/);
  assert.throws(() => plugin.parseSubmitResponse(channel, { statusCode: 200, headers: {}, body: { code: 402, message: "余额不足" } }), /余额不足/);
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

test("completed task without images fails instead of succeeding empty", () => {
  const r = plugin.parseTaskResult({}, { code: 200, data: { status: "completed", result: { images: [] } } }, { status: 200, headers: {} });
  assert.equal(r.status, "FAILURE");
});

// --- usage ----------------------------------------------------------------
function usage(value, extra = {}) {
  return plugin.extractUsage({ ...channel, model: "gpt-image-2.5-flare", upstreamModel: "gpt-image-2.5-flare", requestBody: decode(value).requestBody, ...extra });
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
});

test("extractUsageOnComplete settles on reported usage and refuses to bill zero when missing", () => {
  assert.deepEqual(plugin.extractUsageOnComplete({}, { status: "SUCCESS" }, completed), { input_tokens: 16, output_tokens: 439 });
  assert.throws(() => plugin.extractUsageOnComplete({}, { status: "SUCCESS" }, { code: 200, data: { status: "completed" } }), /no usage/);
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
