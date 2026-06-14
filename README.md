# llmstxt-mcp

用于管理远程 llms.txt 文档的 MCP

当前提供 6 个工具：

- add：新增一个 llms.txt，抓取成功后保存配置和文档。
- edit：按 id 修改名称、URL 或简介；URL 变更时会重新抓取文档。
- del：按 id 删除配置和本地文档目录。
- list：列出所有 llms 的 id、name、url、description。
- view：按 id 读取本地缓存的 llms.txt 内容，返回的文本里包含的绝对 URL 可通过 `view_doc` 进一步获取。
- view_doc：按绝对 URL 抓取并返回 llms.txt 中链接到的文档内容。

## 开发

### 1. 安装

```bash
pnpm install
```

### 2. 启动

```bash
pnpm dev
```

### 3. 调试

在弹出的 MCP Inspector 跳时网页，选择 SSE 模式并连接，SSE 支持自动重连，更好支持本地开发调试，当然你也可以选择其他模式

### 4. 参数传递

- stdio 模式，可以用 `process.env` 获取 mcp 配置的 env 变量
- see/streamable-http 模式，可以用封装的 ctx.get() 获取 mcp 配置的请求头，方便鉴权等

## 部署 Stdio

### 1. 打包

```bash
pnpm build
```

### 2. 发布到 npm

```bash
pnpm publish
```

### 3. MCP 配置

```json
{
  "mcpServers": {
    "llmstxt-mcp": {
      "type": "stdio",
      "command": "npx",
      "args": ["llmstxt-mcp"]
    }
  }
}
```

## 部署 docker

### 1. Build

```bash
docker build -t llmstxt-mcp .
```

### 2. Run the server

```bash
docker run -p 3000:3000 llmstxt-mcp
# 或启动 sse
docker run -p 4000:4000 llmstxt-mcp node sse.js
```

### 3. MCP 配置

```json
{
  "mcpServers": {
    "llmstxt-mcp": {
      "type": "streamableHttp",
      "url": "http://localhost:3000/mcp",
      "headers": {
        "API_KEY": "sk-123"
      }
    },
    // 或 sse
    "llmstxt-mcp": {
      "type": "sse",
      "url": "http://localhost:4000/mcp",
      "headers": {
        "API_KEY": "sk-123"
      }
    }
  }
}
```
