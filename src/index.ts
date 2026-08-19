import { config as loadDotenv } from "dotenv";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { fetch as proxyFetch, ProxyAgent } from "undici";
import { z } from "zod";

type Parameter = {
  name: string;
  requestKey: string;
  type: "string" | "integer" | "boolean";
  required: boolean;
  status: "verified-by-success" | "conventional" | "candidate";
  note: string;
};

type Provider = {
  id: string;
  label: string;
  protocol: "openai-images" | "gemini-generate-content";
  baseUrlEnv?: string;
  defaultBaseUrl: string;
  apiKeyEnv: string;
  proxyEnv?: string;
  modelsPath: string;
  imageGenerationsPath: string;
  imageEditsPath?: string;
  usagePath?: string;
  defaultModel: string;
  evidence: { verified: string[]; notVerified: string[] };
  parameters: Parameter[];
};

type ProviderFile = { providers: Provider[] };
type ProviderRequest = { method: "GET" | "POST"; body?: string | Buffer; headers?: Record<string, string> };
type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

const moduleDir = dirname(fileURLToPath(import.meta.url));
const configPath = resolve(moduleDir, "../config/providers.json");
const proxyAgents = new Map<string, ProxyAgent>();
loadDotenv({ path: resolve(moduleDir, "../.env") });

async function loadProviders(): Promise<Provider[]> {
  const config = JSON.parse(await readFile(configPath, "utf8")) as ProviderFile;
  return config.providers;
}

function baseUrl(provider: Provider): string {
  const envValue = provider.baseUrlEnv ? process.env[provider.baseUrlEnv] : undefined;
  const value = (envValue || provider.defaultBaseUrl || "").trim().replace(/\/+$/, "");
  if (!value) throw new Error("Missing the site base URL. Configure defaultBaseUrl in config/providers.json.");
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error("Site base URL must be an HTTP(S) URL."); }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("Site base URL must be an HTTP(S) URL.");
  return value;
}

function apiKey(provider: Provider): string {
  const value = process.env[provider.apiKeyEnv]?.trim();
  if (!value) throw new Error(`Missing ${provider.apiKeyEnv}. Set it only in the server environment.`);
  return value;
}

function proxyAgent(provider: Provider): ProxyAgent | undefined {
  const proxyUrl = provider.proxyEnv ? process.env[provider.proxyEnv]?.trim() : undefined;
  if (!proxyUrl) return undefined;
  const existing = proxyAgents.get(proxyUrl);
  if (existing) return existing;
  const created = new ProxyAgent(proxyUrl);
  proxyAgents.set(proxyUrl, created);
  return created;
}

async function callProvider(provider: Provider, path: string, init: ProviderRequest): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180_000);
  try {
    const headers: Record<string, string> = { ...init.headers, Authorization: `Bearer ${apiKey(provider)}` };
    if (typeof init.body === "string") headers["Content-Type"] = "application/json";
    const response = await proxyFetch(`${baseUrl(provider)}${path}`, {
      ...init,
      headers,
      signal: controller.signal,
      dispatcher: proxyAgent(provider)
    });
    const body = await response.text();
    let parsed: unknown = body;
    try { parsed = JSON.parse(body); } catch { /* preserve non-JSON provider errors */ }
    if (!response.ok) throw new Error(`Provider returned HTTP ${response.status}: ${JSON.stringify(parsed).slice(0, 2_000)}`);
    return parsed;
  } finally {
    clearTimeout(timeout);
  }
}

function asText(value: unknown): string { return JSON.stringify(value, null, 2); }

function mimeTypeForFormat(format: unknown): string {
  const value = typeof format === "string" ? format.toLowerCase() : "png";
  if (value === "jpeg" || value === "jpg") return "image/jpeg";
  if (value === "webp") return "image/webp";
  return "image/png";
}

type DownloadedImage = { bytes: Buffer; mimeType: string };

async function downloadImageUrl(provider: Provider, url: string): Promise<DownloadedImage> {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("Provider returned a non-HTTP image URL.");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  try {
    const response = await proxyFetch(parsed, { method: "GET", signal: controller.signal, dispatcher: proxyAgent(provider) });
    if (!response.ok) throw new Error(`Image URL returned HTTP ${response.status}.`);
    const maximumBytes = 25 * 1024 * 1024;
    if (Number(response.headers.get("content-length") || 0) > maximumBytes) throw new Error("Image exceeds the 25 MB safety limit.");
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maximumBytes) throw new Error("Image exceeds the 25 MB safety limit.");
    const mimeType = response.headers.get("content-type")?.split(";", 1)[0] || mimeTypeForFormat(parsed.pathname.split(".").pop());
    return { bytes, mimeType };
  } finally { clearTimeout(timeout); }
}

function imageMimeTypeForPath(path: string): string {
  const extension = path.toLowerCase().split(".").pop();
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "webp") return "image/webp";
  if (extension === "gif") return "image/gif";
  return "image/png";
}

async function readReferenceImages(paths: string[] | undefined): Promise<Array<{ path: string; mimeType: string; bytes: Buffer; base64: string }>> {
  const references = paths ?? [];
  if (references.length > 14) throw new Error("A maximum of 14 reference images is supported.");
  const maximumBytes = 20 * 1024 * 1024;
  const output = [];
  for (const rawPath of references) {
    const path = normalizedSaveDirectory(rawPath);
    const bytes = await readFile(path);
    if (bytes.length > maximumBytes) throw new Error(`Reference image exceeds the 20 MB limit: ${path}`);
    const mimeType = imageMimeTypeForPath(path);
    if (!["image/png", "image/jpeg", "image/webp"].includes(mimeType)) {
      throw new Error(`Unsupported reference image format: ${path}`);
    }
    output.push({ path, mimeType, bytes, base64: bytes.toString("base64") });
  }
  return output;
}

function decodeBase64Image(value: string, fallbackFormat: unknown): DownloadedImage {
  const trimmed = value.trim();
  const dataUrl = trimmed.match(/^data:(image\/[a-z0-9.+-]+);base64,(.*)$/is);
  const mimeType = dataUrl?.[1]?.toLowerCase() || mimeTypeForFormat(fallbackFormat);
  const payload = (dataUrl?.[2] || trimmed).replace(/\s+/g, "");
  if (!payload) throw new Error("Provider returned an empty b64_json image.");
  const bytes = Buffer.from(payload, "base64");
  if (!bytes.length) throw new Error("Provider returned invalid b64_json image data.");
  return { bytes, mimeType };
}

function extensionForMimeType(mimeType: string): string {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  if (mimeType === "image/gif") return "gif";
  return "png";
}

function normalizedSaveDirectory(value: string): string {
  const directory = value.trim();
  if (!directory || !isAbsolute(directory)) {
    throw new Error("save_directory must be an absolute local directory path selected by the user.");
  }
  return resolve(directory);
}

type SavedImageResult = {
  content: ToolContent[];
  responsePath: string;
  imagePaths: string[];
};

async function saveImageResponse(
  result: unknown,
  provider: Provider,
  saveDirectory: string,
  outputFormat: unknown
): Promise<SavedImageResult> {
  const directory = normalizedSaveDirectory(saveDirectory);
  await mkdir(directory, { recursive: true });
  const prefix = `relayone-image-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const responsePath = join(directory, `${prefix}.response.json`);
  const serialized = typeof result === "string" ? result : JSON.stringify(result, null, 2) ?? "null";
  await writeFile(responsePath, serialized, "utf8");

  const responseImages = extractResponseImages(result);
  if (!responseImages.length) {
    return { content: [{ type: "text", text: asText({ responsePath, response: result }) }], responsePath, imagePaths: [] };
  }

  const content: ToolContent[] = [];
  const imagePaths: string[] = [];
  for (const [index, item] of responseImages.entries()) {
    if (typeof item.url === "string") {
      try {
        const image = await downloadImageUrl(provider, item.url);
        const imagePath = join(directory, `${prefix}-${String(index + 1).padStart(2, "0")}.${extensionForMimeType(image.mimeType)}`);
        await writeFile(imagePath, image.bytes);
        imagePaths.push(imagePath);
        content.push({ type: "image", data: image.bytes.toString("base64"), mimeType: image.mimeType });
      } catch (error) {
        content.push({ type: "text", text: `Image ${index + 1} URL could not be saved: ${error instanceof Error ? error.message : String(error)}. The original URL remains in ${responsePath}.` });
      }
    } else if (typeof item.b64_json === "string") {
      try {
        const image = decodeBase64Image(item.b64_json, item.outputFormat || outputFormat);
        const imagePath = join(directory, `${prefix}-${String(index + 1).padStart(2, "0")}.${extensionForMimeType(image.mimeType)}`);
        await writeFile(imagePath, image.bytes);
        imagePaths.push(imagePath);
        content.push({ type: "image", data: image.bytes.toString("base64"), mimeType: image.mimeType });
      } catch (error) {
        content.push({ type: "text", text: `Image ${index + 1} b64_json could not be saved: ${error instanceof Error ? error.message : String(error)}. The original b64_json remains in ${responsePath}.` });
      }
    } else content.push({ type: "text", text: `Image ${index + 1} response was not a URL or b64_json. The original response remains in ${responsePath}.` });
  }
  content.push({ type: "text", text: asText({ responsePath, imagePaths, preservedFields: ["url", "b64_json"] }) });
  return { content, responsePath, imagePaths };
}

type ResponseImage = { url?: string; b64_json?: string; outputFormat?: unknown };

function extractResponseImages(result: unknown): ResponseImage[] {
  if (!result || typeof result !== "object") return [];
  const value = result as { data?: unknown; candidates?: unknown };
  if (Array.isArray(value.data)) {
    return value.data.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
      .map((item) => ({
        url: typeof item.url === "string" ? item.url : undefined,
        b64_json: typeof item.b64_json === "string" ? item.b64_json : undefined,
        outputFormat: item.output_format,
      }));
  }
  if (!Array.isArray(value.candidates)) return [];
  const output: ResponseImage[] = [];
  for (const candidate of value.candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const parts = (candidate as { content?: { parts?: unknown[] } }).content?.parts;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      if (!part || typeof part !== "object") continue;
      const inlineData = (part as { inlineData?: { data?: unknown; mimeType?: unknown }; inline_data?: { data?: unknown; mime_type?: unknown } }).inlineData;
      const snake = (part as { inline_data?: { data?: unknown; mime_type?: unknown } }).inline_data;
      const data = inlineData?.data ?? snake?.data;
      if (typeof data === "string") {
        output.push({ b64_json: data, outputFormat: inlineData?.mimeType ?? snake?.mime_type });
      }
    }
  }
  return output;
}

const providerId = z.string().default("image2").describe("Provider id from list_image_providers.");
async function selectedProvider(id: string): Promise<Provider> {
  const provider = (await loadProviders()).find((item) => item.id === id);
  if (!provider) throw new Error(`Unknown provider '${id}'. Call list_image_providers first.`);
  return provider;
}

const server = new McpServer({ name: "relayone-image-mcp", version: "0.3.0" });

server.tool("list_image_providers", "List configured providers without exposing credentials.", async () => ({
  content: [{ type: "text", text: asText((await loadProviders()).map(({ apiKeyEnv, ...provider }) => ({ ...provider, keyRequiredInEnvironment: apiKeyEnv }))) }]
}));

server.tool("list_remote_image_models", "Read the live model list. This is not a generation request.", { provider: providerId }, async ({ provider: id }) => {
  try { const provider = await selectedProvider(id); return { content: [{ type: "text", text: asText(await callProvider(provider, provider.modelsPath, { method: "GET" })) }] }; }
  catch (error) { return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] }; }
});

server.tool("get_image_capabilities", "Show the provider owner's recorded parameter capabilities.", { provider: providerId }, async ({ provider: id }) => {
  try { const provider = await selectedProvider(id); return { content: [{ type: "text", text: asText({ provider: provider.id, defaultModel: provider.defaultModel, evidence: provider.evidence, parameters: provider.parameters }) }] }; }
  catch (error) { return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] }; }
});

server.tool("get_image_usage", "Read the optional usage endpoint without generating images.", { provider: providerId }, async ({ provider: id }) => {
  try {
    const provider = await selectedProvider(id);
    if (!provider.usagePath) throw new Error(`Provider '${id}' has no configured usage endpoint.`);
    return { content: [{ type: "text", text: asText(await callProvider(provider, provider.usagePath, { method: "GET" })) }] };
  } catch (error) { return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] }; }
});

const imageRequestSchema = {
  provider: providerId,
  model: z.string().min(1).optional(),
  prompt: z.string().min(1).max(20_000),
  size: z.string().min(1).max(100).optional(), quality: z.string().min(1).max(100).optional(),
  n: z.number().int().min(1).max(10).optional(), background: z.string().min(1).max(100).optional(),
  output_format: z.string().min(1).max(100).optional(), output_compression: z.number().int().min(0).max(100).optional(),
  response_format: z.enum(["url", "b64_json"]).optional(),
  aspectRatio: z.string().min(1).max(20).optional(),
  imageSize: z.enum(["512", "1K", "2K", "4K"]).optional(),
  reference_images: z.array(z.string().min(1)).max(14).optional().describe("Absolute local image paths. Banana supports up to 14; Image2 uses edit_image for references."),
  moderation: z.string().min(1).max(100).optional(), stream: z.boolean().optional(), partial_images: z.number().int().min(0).max(10).optional(),
  custom_parameters: z.record(z.any()).optional().describe("Additional JSON fields for this request. Reserved fields cannot be overridden.")
};

function imageRequestBody(input: Record<string, any>, provider: Provider): Record<string, unknown> {
  const { provider: _provider, model, custom_parameters, save_directory: _saveDirectory, reference_images: _referenceImages, aspectRatio: _aspectRatio, imageSize: _imageSize, ...standardFields } = input;
  const custom = custom_parameters ?? {};
  const reserved = new Set(["provider", "model", "prompt", "custom_parameters", ...Object.keys(standardFields)]);
  const conflicts = Object.keys(custom).filter((key) => reserved.has(key));
  if (conflicts.length) throw new Error(`custom_parameters contains reserved field(s): ${conflicts.join(", ")}`);
  const selectedModel = model ?? provider.defaultModel;
  if (!selectedModel) throw new Error("Missing model. Set defaultModel in config/providers.json or pass model for this request.");
  return { model: selectedModel, ...standardFields, ...custom };
}

async function providerRequestBody(input: Record<string, any>, provider: Provider): Promise<Record<string, unknown>> {
  if (provider.protocol === "openai-images") return imageRequestBody(input, provider);
  const references = await readReferenceImages(input.reference_images);
  const parts = [{ text: input.prompt }, ...references.map((image) => ({ inlineData: { mimeType: image.mimeType, data: image.base64 } }))];
  const custom = input.custom_parameters ?? {};
  const reserved = new Set(["contents", "generationConfig", "model", "prompt", "reference_images", "custom_parameters"]);
  const conflicts = Object.keys(custom).filter((key) => reserved.has(key));
  if (conflicts.length) throw new Error(`custom_parameters contains reserved field(s): ${conflicts.join(", ")}`);
  return {
    contents: [{ parts }],
    generationConfig: {
      responseModalities: ["IMAGE"],
      imageConfig: {
        ...(input.aspectRatio ? { aspectRatio: input.aspectRatio } : {}),
        ...(input.imageSize ? { imageSize: input.imageSize } : {}),
      },
    },
    ...custom,
  };
}

function multipartPart(name: string, value: string, boundary: string): string {
  return `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
}

async function image2Request(provider: Provider, input: Record<string, any>): Promise<{ path: string; body: string | Buffer; headers?: Record<string, string> }> {
  const references = await readReferenceImages(input.reference_images);
  const model = input.model ?? provider.defaultModel;
  if (!references.length) {
    return {
      path: provider.imageGenerationsPath,
      body: JSON.stringify(imageRequestBody(input, provider)),
    };
  }
  if (!provider.imageEditsPath) throw new Error("Image2 edit endpoint is not configured.");
  const boundary = `----relayone-mcp-${randomUUID()}`;
  const parts: Buffer[] = [
    Buffer.from(multipartPart("model", model, boundary)),
    Buffer.from(multipartPart("prompt", input.prompt, boundary)),
  ];
  for (const field of ["size", "quality", "response_format", "output_format", "output_compression", "background"]) {
    if (input[field] !== undefined) parts.push(Buffer.from(multipartPart(field, String(input[field]), boundary)));
  }
  for (const image of references) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image[]"; filename="${image.path.split(/[\\/]/).pop()}"\r\nContent-Type: ${image.mimeType}\r\n\r\n`));
    parts.push(image.bytes);
    parts.push(Buffer.from("\r\n"));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    path: provider.imageEditsPath,
    body: Buffer.concat(parts),
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
  };
}

function providerEndpoint(provider: Provider, model: string): string {
  if (provider.protocol === "gemini-generate-content") {
    return `${provider.imageGenerationsPath.replace("{model}", encodeURIComponent(model))}`;
  }
  return provider.imageGenerationsPath;
}

server.tool("prepare_image_request", "Preview the outgoing JSON without contacting the provider.", imageRequestSchema, async (input) => {
  try {
    const provider = await selectedProvider(input.provider);
    const model = input.model ?? provider.defaultModel;
    const request = provider.protocol === "openai-images"
      ? await image2Request(provider, input)
      : { path: providerEndpoint(provider, model), body: JSON.stringify(await providerRequestBody(input, provider)) };
    return { content: [{ type: "text", text: asText({ endpoint: `${baseUrl(provider)}${request.path}`, body: typeof request.body === "string" ? JSON.parse(request.body) : { contentType: request.headers?.["Content-Type"], binaryBody: true } }) }] };
  }
  catch (error) { return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] }; }
});

const generateImageRequestSchema = {
  ...imageRequestSchema,
  save_directory: z.string().min(1).describe("Required absolute local directory selected by the user before generation. The response JSON and generated images are saved here.")
};

server.tool("generate_image", "Generate an image, preserve the original URL or b64_json response, save files to the user-selected directory, and return MCP image content.", generateImageRequestSchema, async (input) => {
  try {
    const provider = await selectedProvider(input.provider);
    const model = input.model ?? provider.defaultModel;
    const request = provider.protocol === "openai-images"
      ? await image2Request(provider, input)
      : { path: providerEndpoint(provider, model), body: JSON.stringify(await providerRequestBody(input, provider)) };
    const result = await callProvider(provider, request.path, { method: "POST", body: request.body, headers: request.headers });
    return { content: (await saveImageResponse(result, provider, input.save_directory, input.output_format)).content };
  } catch (error) { return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] }; }
});

await server.connect(new StdioServerTransport());
