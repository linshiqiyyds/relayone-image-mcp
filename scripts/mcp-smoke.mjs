import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname.replace(/^\//, "").replaceAll("/", "\\");
const node = process.execPath;
const outputDir = join(root, "smoke-output");
await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });

const transport = new StdioClientTransport({
  command: node,
  args: [join(root, "dist", "index.js")],
  cwd: root,
  env: { ...process.env, SITE_IMAGE_API_KEY: "test-key-not-for-production" },
  stderr: "pipe",
});
const client = new Client({ name: "relayone-image-mcp-smoke", version: "0.3.0" }, { capabilities: {} });
await client.connect(transport);
const tools = await client.listTools();
const names = tools.tools.map((tool) => tool.name).sort();
if (!names.includes("generate_image") || !names.includes("prepare_image_request")) {
  throw new Error(`MCP tools missing: ${names.join(", ")}`);
}

const preview = await client.callTool({
  name: "prepare_image_request",
  arguments: { prompt: "smoke", size: "1024x1024", response_format: "b64_json" },
});
const previewText = JSON.stringify(preview);
if (!previewText.includes("https://aiapi.aiqji.cn/v1/images/generations")) {
  throw new Error("RelayOne endpoint was not prepared");
}

const bananaPreview = await client.callTool({
  name: "prepare_image_request",
  arguments: {
    provider: "banana",
    prompt: "banana smoke",
    aspectRatio: "16:9",
    imageSize: "2K",
  },
});
const bananaText = JSON.stringify(bananaPreview);
if (!bananaText.includes("/v1beta/models/gemini-3.1-flash-image:generateContent")) {
  throw new Error("Banana endpoint was not prepared");
}

const image2Capabilities = await client.callTool({
  name: "get_image_capabilities",
  arguments: { provider: "image2" },
});
const image2CapabilitiesText = JSON.stringify(image2Capabilities);
for (const model of ["gpt-image-2", "gpt-image-2-low", "gpt-image-2-medium", "gpt-image-2-high"]) {
  if (!image2CapabilitiesText.includes(model)) throw new Error(`Image2 model missing: ${model}`);
}

const bananaCapabilities = await client.callTool({
  name: "get_image_capabilities",
  arguments: { provider: "banana" },
});
const bananaCapabilitiesText = JSON.stringify(bananaCapabilities);
for (const model of ["gemini-3.1-flash-image", "gemini-3-pro-image"]) {
  if (!bananaCapabilitiesText.includes(model)) throw new Error(`Banana model missing: ${model}`);
}
if (!bananaCapabilitiesText.includes("text-to-image") || !bananaCapabilitiesText.includes("image-to-image")) {
  throw new Error("Banana capabilities do not list both text-to-image and image-to-image");
}

const bananaAliasPreview = await client.callTool({
  name: "prepare_image_request",
  arguments: { provider: "banana", model: "gemini-3-pro-image-preview", prompt: "alias smoke" },
});
const bananaAliasText = JSON.stringify(bananaAliasPreview);
if (!bananaAliasText.includes("/v1beta/models/gemini-3-pro-image:generateContent")) {
  throw new Error("Banana preview alias was not normalized");
}

const invalidModel = await client.callTool({
  name: "prepare_image_request",
  arguments: { provider: "banana", model: "gpt-image-2", prompt: "invalid model smoke" },
});
if (!JSON.stringify(invalidModel).includes("Unsupported model")) {
  throw new Error("Cross-provider model was not rejected");
}
if (!bananaText.includes("generationConfig") || !bananaText.includes("contents")) {
  throw new Error("Banana request did not use Gemini generateContent JSON");
}

const missingDirectory = await client.callTool({
  name: "generate_image",
  arguments: { prompt: "smoke", size: "1024x1024" },
});
if (!JSON.stringify(missingDirectory).includes("save_directory")) {
  throw new Error("generate_image did not require save_directory");
}

console.log(JSON.stringify({ tools: names, image2Models: 4, bananaModels: 2, bananaModes: ["text-to-image", "image-to-image"], image2Endpoint: "https://aiapi.aiqji.cn/v1/images/generations", bananaEndpoint: "https://aiapi.aiqji.cn/v1beta/models/gemini-3.1-flash-image:generateContent", bananaAliasNormalized: true, crossProviderModelRejected: true, saveDirectoryRequired: true }));
await transport.close();
await rm(outputDir, { recursive: true, force: true });
