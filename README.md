# RelayOne Image MCP

这是 RelayOne Image 的 MCP 接入包，已适配 OpenAI-compatible 生图接口。默认使用 `https://aiapi.aiqji.cn/v1` 和 `gpt-image-2`，每个使用者只需要配置一个 RelayOne API Key。

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
