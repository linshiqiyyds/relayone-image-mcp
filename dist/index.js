import { config as loadDotenv } from "dotenv";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { fetch as proxyFetch, ProxyAgent } from "undici";
import { z } from "zod";
const moduleDir = dirname(fileURLToPath(import.meta.url));
const configPath = resolve(moduleDir, "../config/providers.json");
const proxyAgents = new Map();
loadDotenv({ path: resolve(moduleDir, "../.env") });
async function loadProviders() {
    const config = JSON.parse(await readFile(configPath, "utf8"));
    return config.providers;
}
function baseUrl(provider) {
    const envValue = provider.baseUrlEnv ? process.env[provider.baseUrlEnv] : undefined;
    const value = (envValue || provider.defaultBaseUrl || "").trim().replace(/\/+$/, "");
    if (!value)
        throw new Error("Missing the site base URL. Configure defaultBaseUrl in config/providers.json.");
    let parsed;
    try {
        parsed = new URL(value);
    }
    catch {
        throw new Error("Site base URL must be an HTTP(S) URL.");
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
        throw new Error("Site base URL must be an HTTP(S) URL.");
    return value;
}
function apiKey(provider) {
    const value = process.env[provider.apiKeyEnv]?.trim();
    if (!value)
        throw new Error(`Missing ${provider.apiKeyEnv}. Set it only in the server environment.`);
    return value;
}
function proxyAgent(provider) {
    const proxyUrl = provider.proxyEnv ? process.env[provider.proxyEnv]?.trim() : undefined;
    if (!proxyUrl)
        return undefined;
    const existing = proxyAgents.get(proxyUrl);
    if (existing)
        return existing;
    const created = new ProxyAgent(proxyUrl);
    proxyAgents.set(proxyUrl, created);
    return created;
}
async function callProvider(provider, path, init) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 180_000);
    try {
        const headers = { ...init.headers, Authorization: `Bearer ${apiKey(provider)}` };
        if (init.body)
            headers["Content-Type"] = "application/json";
        const response = await proxyFetch(`${baseUrl(provider)}${path}`, {
            ...init,
            headers,
            signal: controller.signal,
            dispatcher: proxyAgent(provider)
        });
        const body = await response.text();
        let parsed = body;
        try {
            parsed = JSON.parse(body);
        }
        catch { /* preserve non-JSON provider errors */ }
        if (!response.ok)
            throw new Error(`Provider returned HTTP ${response.status}: ${JSON.stringify(parsed).slice(0, 2_000)}`);
        return parsed;
    }
    finally {
        clearTimeout(timeout);
    }
}
function asText(value) { return JSON.stringify(value, null, 2); }
function mimeTypeForFormat(format) {
    const value = typeof format === "string" ? format.toLowerCase() : "png";
    if (value === "jpeg" || value === "jpg")
        return "image/jpeg";
    if (value === "webp")
        return "image/webp";
    return "image/png";
}
async function downloadImageUrl(provider, url) {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
        throw new Error("Provider returned a non-HTTP image URL.");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);
    try {
        const response = await proxyFetch(parsed, { method: "GET", signal: controller.signal, dispatcher: proxyAgent(provider) });
        if (!response.ok)
            throw new Error(`Image URL returned HTTP ${response.status}.`);
        const maximumBytes = 25 * 1024 * 1024;
        if (Number(response.headers.get("content-length") || 0) > maximumBytes)
            throw new Error("Image exceeds the 25 MB safety limit.");
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length > maximumBytes)
            throw new Error("Image exceeds the 25 MB safety limit.");
        const mimeType = response.headers.get("content-type")?.split(";", 1)[0] || mimeTypeForFormat(parsed.pathname.split(".").pop());
        return { bytes, mimeType };
    }
    finally {
        clearTimeout(timeout);
    }
}
function decodeBase64Image(value, fallbackFormat) {
    const trimmed = value.trim();
    const dataUrl = trimmed.match(/^data:(image\/[a-z0-9.+-]+);base64,(.*)$/is);
    const mimeType = dataUrl?.[1]?.toLowerCase() || mimeTypeForFormat(fallbackFormat);
    const payload = (dataUrl?.[2] || trimmed).replace(/\s+/g, "");
    if (!payload)
        throw new Error("Provider returned an empty b64_json image.");
    const bytes = Buffer.from(payload, "base64");
    if (!bytes.length)
        throw new Error("Provider returned invalid b64_json image data.");
    return { bytes, mimeType };
}
function extensionForMimeType(mimeType) {
    if (mimeType === "image/jpeg")
        return "jpg";
    if (mimeType === "image/webp")
        return "webp";
    if (mimeType === "image/gif")
        return "gif";
    return "png";
}
function normalizedSaveDirectory(value) {
    const directory = value.trim();
    if (!directory || !isAbsolute(directory)) {
        throw new Error("save_directory must be an absolute local directory path selected by the user.");
    }
    return resolve(directory);
}
async function saveImageResponse(result, provider, saveDirectory, outputFormat) {
    const directory = normalizedSaveDirectory(saveDirectory);
    await mkdir(directory, { recursive: true });
    const prefix = `relayone-image-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
    const responsePath = join(directory, `${prefix}.response.json`);
    const serialized = typeof result === "string" ? result : JSON.stringify(result, null, 2) ?? "null";
    await writeFile(responsePath, serialized, "utf8");
    if (!result || typeof result !== "object" || !Array.isArray(result.data)) {
        return { content: [{ type: "text", text: asText({ responsePath, response: result }) }], responsePath, imagePaths: [] };
    }
    const response = result;
    const content = [];
    const imagePaths = [];
    for (const [index, item] of response.data.entries()) {
        if (typeof item.url === "string") {
            try {
                const image = await downloadImageUrl(provider, item.url);
                const imagePath = join(directory, `${prefix}-${String(index + 1).padStart(2, "0")}.${extensionForMimeType(image.mimeType)}`);
                await writeFile(imagePath, image.bytes);
                imagePaths.push(imagePath);
                content.push({ type: "image", data: image.bytes.toString("base64"), mimeType: image.mimeType });
            }
            catch (error) {
                content.push({ type: "text", text: `Image ${index + 1} URL could not be saved: ${error instanceof Error ? error.message : String(error)}. The original URL remains in ${responsePath}.` });
            }
        }
        else if (typeof item.b64_json === "string") {
            try {
                const image = decodeBase64Image(item.b64_json, item.output_format || response.output_format || outputFormat);
                const imagePath = join(directory, `${prefix}-${String(index + 1).padStart(2, "0")}.${extensionForMimeType(image.mimeType)}`);
                await writeFile(imagePath, image.bytes);
                imagePaths.push(imagePath);
                content.push({ type: "image", data: image.bytes.toString("base64"), mimeType: image.mimeType });
            }
            catch (error) {
                content.push({ type: "text", text: `Image ${index + 1} b64_json could not be saved: ${error instanceof Error ? error.message : String(error)}. The original b64_json remains in ${responsePath}.` });
            }
        }
        else
            content.push({ type: "text", text: `Image ${index + 1} response was not a URL or b64_json. The original response remains in ${responsePath}.` });
    }
    content.push({ type: "text", text: asText({ responsePath, imagePaths, preservedFields: ["url", "b64_json"] }) });
    return { content, responsePath, imagePaths };
}
const providerId = z.string().default("site").describe("Provider id from list_image_providers.");
async function selectedProvider(id) {
    const provider = (await loadProviders()).find((item) => item.id === id);
    if (!provider)
        throw new Error(`Unknown provider '${id}'. Call list_image_providers first.`);
    return provider;
}
const server = new McpServer({ name: "relayone-image-mcp", version: "0.2.0" });
server.tool("list_image_providers", "List configured providers without exposing credentials.", async () => ({
    content: [{ type: "text", text: asText((await loadProviders()).map(({ apiKeyEnv, ...provider }) => ({ ...provider, keyRequiredInEnvironment: apiKeyEnv }))) }]
}));
server.tool("list_remote_image_models", "Read the live model list. This is not a generation request.", { provider: providerId }, async ({ provider: id }) => {
    try {
        const provider = await selectedProvider(id);
        return { content: [{ type: "text", text: asText(await callProvider(provider, provider.modelsPath, { method: "GET" })) }] };
    }
    catch (error) {
        return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
    }
});
server.tool("get_image_capabilities", "Show the provider owner's recorded parameter capabilities.", { provider: providerId }, async ({ provider: id }) => {
    try {
        const provider = await selectedProvider(id);
        return { content: [{ type: "text", text: asText({ provider: provider.id, defaultModel: provider.defaultModel, evidence: provider.evidence, parameters: provider.parameters }) }] };
    }
    catch (error) {
        return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
    }
});
server.tool("get_image_usage", "Read the optional usage endpoint without generating images.", { provider: providerId }, async ({ provider: id }) => {
    try {
        const provider = await selectedProvider(id);
        if (!provider.usagePath)
            throw new Error(`Provider '${id}' has no configured usage endpoint.`);
        return { content: [{ type: "text", text: asText(await callProvider(provider, provider.usagePath, { method: "GET" })) }] };
    }
    catch (error) {
        return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
    }
});
const imageRequestSchema = {
    provider: providerId,
    model: z.string().min(1).optional(),
    prompt: z.string().min(1).max(20_000),
    size: z.string().min(1).max(100).optional(), quality: z.string().min(1).max(100).optional(),
    n: z.number().int().min(1).max(10).optional(), background: z.string().min(1).max(100).optional(),
    output_format: z.string().min(1).max(100).optional(), output_compression: z.number().int().min(0).max(100).optional(),
    response_format: z.enum(["url", "b64_json"]).optional(),
    moderation: z.string().min(1).max(100).optional(), stream: z.boolean().optional(), partial_images: z.number().int().min(0).max(10).optional(),
    custom_parameters: z.record(z.any()).optional().describe("Additional JSON fields for this request. Reserved fields cannot be overridden.")
};
function imageRequestBody(input, provider) {
    const { provider: _provider, model, custom_parameters, save_directory: _saveDirectory, ...standardFields } = input;
    const custom = custom_parameters ?? {};
    const reserved = new Set(["provider", "model", "prompt", "custom_parameters", ...Object.keys(standardFields)]);
    const conflicts = Object.keys(custom).filter((key) => reserved.has(key));
    if (conflicts.length)
        throw new Error(`custom_parameters contains reserved field(s): ${conflicts.join(", ")}`);
    const selectedModel = model ?? provider.defaultModel;
    if (!selectedModel)
        throw new Error("Missing model. Set defaultModel in config/providers.json or pass model for this request.");
    return { model: selectedModel, ...standardFields, ...custom };
}
server.tool("prepare_image_request", "Preview the outgoing JSON without contacting the provider.", imageRequestSchema, async (input) => {
    try {
        const provider = await selectedProvider(input.provider);
        return { content: [{ type: "text", text: asText({ endpoint: `${baseUrl(provider)}${provider.imageGenerationsPath}`, body: imageRequestBody(input, provider) }) }] };
    }
    catch (error) {
        return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
    }
});
const generateImageRequestSchema = {
    ...imageRequestSchema,
    save_directory: z.string().min(1).describe("Required absolute local directory selected by the user before generation. The response JSON and generated images are saved here.")
};
server.tool("generate_image", "Generate an image, preserve the original URL or b64_json response, save files to the user-selected directory, and return MCP image content.", generateImageRequestSchema, async (input) => {
    try {
        const provider = await selectedProvider(input.provider);
        const result = await callProvider(provider, provider.imageGenerationsPath, { method: "POST", body: JSON.stringify(imageRequestBody(input, provider)) });
        return { content: (await saveImageResponse(result, provider, input.save_directory, input.output_format)).content };
    }
    catch (error) {
        return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
    }
});
await server.connect(new StdioServerTransport());
