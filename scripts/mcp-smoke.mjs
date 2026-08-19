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
const client = new Client({ name: "relayone-image-mcp-smoke", version: "0.2.0" }, { capabilities: {} });
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

const missingDirectory = await client.callTool({
  name: "generate_image",
  arguments: { prompt: "smoke", size: "1024x1024" },
});
if (!JSON.stringify(missingDirectory).includes("save_directory")) {
  throw new Error("generate_image did not require save_directory");
}

console.log(JSON.stringify({ tools: names, previewEndpoint: "https://aiapi.aiqji.cn/v1/images/generations", saveDirectoryRequired: true }));
await transport.close();
await rm(outputDir, { recursive: true, force: true });
