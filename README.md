# RelayOne Image MCP

这是 RelayOne Image 的 MCP 接入包，同时支持 Image2 和 Gemini Banana 两条生图路线。每个使用者只需要配置一个 RelayOne API Key。

## 两种生图 Provider

| Provider | 协议 | 默认模型 | 适合场景 |
| --- | --- | --- | --- |
| `image2` | OpenAI Images `/v1/images/generations` | `gpt-image-2` | 精确像素尺寸、Image2 生图 |
| `banana` | Gemini `v1beta generateContent` | `gemini-3.1-flash-image` | Banana 文生图、最多 14 张参考图改图 |

Banana 还支持 `gemini-3-pro-image`。它的 `imageSize` 是 `512`、`1K`、`2K`、`4K` 清晰度档位，`aspectRatio` 控制比例；它不是 Image2 的固定 `宽x高` 尺寸协议。

选择 Provider 后，MCP 会自动选择协议：

- `image2` 没有 `reference_images` 时调用 `/v1/images/generations` JSON；有参考图时调用 `/v1/images/edits` multipart，并以 `image[]` 上传参考图。
- `banana` 始终调用 `/v1beta/models/{model}:generateContent`；参考图会转换成 `contents[].parts[].inlineData`，不是 multipart，也不是 OpenAI Images JSON。

## 站点需要填写的内容

1. `config/providers.json` 已配置 RelayOne 地址、模型和 Images 路径；如需切换站点再修改它。
2. 每个 agent 将 `.env.example` 复制为 `.env`，并只填写 `SITE_IMAGE_API_KEY`；不要把 Key 写入工具参数。
3. 如需代理，在运行 MCP 的机器上额外设置 `SITE_IMAGE_PROXY_URL`，这是可选项。
4. 如果站点不是 Bearer 鉴权或不是 OpenAI-compatible 请求格式，在 `src/index.ts` 的 `callProvider` 和请求 schema 中改适配逻辑。
5. 执行 `npm install`、`npm run build`，再将 `dist/index.js` 注册到 MCP 客户端。

`.env` 会在 MCP 启动时自动读取，因此 agent 不需要改启动命令。

## MCP 注册示例

把 `mcp-server.example.json` 中的 `PACKAGE_DIRECTORY` 替换为当前包目录，再按所用 MCP 客户端的配置格式注册。`.env` 和 `dist/index.js` 必须与该目录保持同级。

## 工具

- `list_image_providers`：显示本地配置的渠道，不显示密钥。
- `list_remote_image_models`：读取实时模型清单，不生图。
- `get_image_capabilities`：查看站长填写的参数能力。
- `get_image_usage`：读取可选的用量接口，不生图。
- `prepare_image_request`：预览实际 JSON，不联网。
- `generate_image`：调用前必须提供本地绝对路径 `save_directory`。工具会保留完整原始响应 JSON（包括 `url` 和 `b64_json`），并将图片保存到该目录，同时返回 MCP `image` 内容。

## 每次调用自定义参数

标准字段直接传入，站点专属字段放入 `custom_parameters`。例如：

```json
{
  "prompt": "一座雨夜城市",
  "size": "1024x1024",
  "custom_parameters": {
    "steps": 30,
    "guidance_scale": 7,
    "seed": 12345,
    "negative_prompt": "模糊、低清晰度"
  }
}
```

`custom_parameters` 会合并到本次请求 JSON；`provider`、`model`、`prompt`、`custom_parameters` 以及已传入的标准字段不能被覆盖。

## 安全约束

- 真实密钥只放进启动环境，不写入 `providers.json`、代码、日志或 MCP 工具参数。
- `save_directory` 必须由用户在每次生图前明确选择，MCP 不自行决定保存位置。
- 保存目录中会生成一个 `.response.json` 原始响应文件，以及按序号命名的图片文件。
- URL 图片下载仅允许 HTTP(S)，并限制为 25 MB；下载失败时原始 URL 仍保留在 `.response.json`。
- 请求和响应不会打印 Authorization 头。
- `advanced` 任意透传没有加入模板；站长应根据自己的接口逐项加入白名单字段。

## Codex 注册

在 Codex 的 MCP 配置中注册 `node dist/index.js`，并通过配置的环境变量传入 RelayOne Key。不要把真实值放进示例文件或发给第三方。

项目地址：`https://github.com/linshiqiyyds/relayone-image-mcp`

## 生图调用示例

调用 `generate_image` 时必须先选择保存目录，例如：

```json
{
  "prompt": "一只橘猫坐在窗边，电影感，自然光",
  "size": "1024x1024",
  "response_format": "b64_json",
  "save_directory": "D:\\RelayOne-MCP\\generated"
}
```

如果选择 `response_format: "url"`，MCP 会下载 URL 对应图片；如果选择 `b64_json`，MCP 会解码 Base64。两种原始字段都会原样保存在 `.response.json` 文件中。

## Image2 示例

```json
{
  "provider": "image2",
  "model": "gpt-image-2",
  "prompt": "一张产品摄影图",
  "size": "2048x1152",
  "response_format": "url",
  "save_directory": "D:\\RelayOne-MCP\\generated"
}
```

Image2 图生图只需增加本地参考图路径，MCP 会自动切换到 `/v1/images/edits`：

```json
{
  "provider": "image2",
  "model": "gpt-image-2",
  "prompt": "保留主体，把背景改成夜晚城市",
  "reference_images": ["D:\\References\\product.png"],
  "size": "2048x1152",
  "save_directory": "D:\\RelayOne-MCP\\generated"
}
```

## Banana 示例

```json
{
  "provider": "banana",
  "model": "gemini-3.1-flash-image",
  "prompt": "把产品放在夜晚城市街道中",
  "aspectRatio": "16:9",
  "imageSize": "2K",
  "reference_images": [
    "D:\\References\\product.png"
  ],
  "save_directory": "D:\\RelayOne-MCP\\generated"
}
```

Banana 的参考图会读取为纯 Base64，并按 Gemini 原生协议放入 `contents[].parts[].inlineData`。最多 14 张，每张最大 20 MB，支持 PNG、JPEG、WebP。Banana 的模型不使用 `gpt-image-2`，也不使用 Image2 的固定像素 `size` 字段。
