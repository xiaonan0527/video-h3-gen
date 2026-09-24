# MiniMax H3 视频生成 Skill

面向 AI 编码助手（Claude Code、Codex 等）的一键电影级视频生成与运镜优化技能，通过 Nange AI 平台提供 MiniMax H3 官方全系列模型支持。

---

## 特性亮点

- **全系列四套模型支持**：
  - `MiniMax-H3`：旗舰超高清视频大模型，原生 2K 输出，首尾帧过渡，多图参考。
  - `MiniMax-H3-Max`：极速生成模型，支持参考视频（Reference Videos），支持 480P / 768P / 1080P。
  - `MiniMax-H3-Regeneration`：成品升 2K 再生成模型，支持基于已有任务一键画质跃升。
  - `MiniMax-H3-Context-IR`：多模态运镜与分镜增强模型，专用于视频生成提示词优化。
- **独家智能运镜联动 (`--enhance-prompt`)**：一键先调用 Context-IR 扩写镜头语言，再提交生成视频。
- **零依赖单脚本**：纯原生 Node.js 实现，无外部 npm 依赖，开箱即用。
- **断点与重试支持**：支持 `--task-id` 查询并补下已有视频，无需重复扣费生成。

---

## 一键安装

将以下内容发送给你的 AI 编码助手：

```
帮我安装 https://github.com/xiaonan0527/video-h3-gen/blob/main/README.md 这个 skill，并生成一个测试视频
```

或者手动克隆到技能目录：

```bash
git clone https://github.com/xiaonan0527/video-h3-gen.git video-h3
```

---

## 配置说明

使用前需配置 API Key。配置完全独立隔离，不会影响已有的 GPT-Image 或 Suno 密钥。

**方式 A：环境变量（推荐）**
```bash
export NANGE_VIDEO_API_KEY="your-api-key-here"
```

**方式 B：专属配置文件**
```bash
# macOS / Linux:
mkdir -p ~/.nange-ai && echo '{"api_key":"your-api-key-here"}' > ~/.nange-ai/video-config.json

# Windows PowerShell:
mkdir -Force "$env:USERPROFILE\.nange-ai" | Out-Null; '{"api_key":"your-api-key-here"}' | Set-Content "$env:USERPROFILE\.nange-ai\video-config.json"
```

> 前往 [API Keys 管理页面](https://api.nange-ai.com/keys) 创建专属密钥（**分组请选择 Video 分组**）。

---

## 快速使用

### 1. 经典文生视频（默认 MiniMax-H3 旗舰 2K）

```bash
node scripts/generate.js \
  --prompt "An astronaut walking in a neon cyberpunk city at night, cinematic 8k, rainy street reflections" \
  --resolution 2k \
  --duration 6 \
  --aspect-ratio 16:9 \
  --out ./cyberpunk.mp4
```

### 2. 首尾帧插值生视频

```bash
node scripts/generate.js \
  --prompt "A warrior drawing a sword smoothly, cinematic movement" \
  --first-frame ./start.jpg \
  --last-frame ./end.jpg \
  --duration 6 \
  --out ./warrior.mp4
```

### 3. 智能分镜扩写 + 视频生成联动

```bash
node scripts/generate.js \
  --prompt "雨夜古镇石桥上的独行剑客" \
  --enhance-prompt \
  --duration 10 \
  --out ./swordsman.mp4
```

### 4. 升级 768P 视频为 2K 超清

```bash
node scripts/generate.js \
  --model MiniMax-H3-Regeneration \
  --source-task-id "vid_task_1727142000_abc123" \
  --out ./swordsman_2k.mp4
```

### 5. 纯运镜分镜优化（仅优化文本提示词）

```bash
node scripts/generate.js \
  --model MiniMax-H3-Context-IR \
  --prompt "赛车穿过山谷隧道" \
  --out ./enhanced_prompt.txt
```

### 6. 任务断点重新下载

```bash
node scripts/generate.js \
  --task-id "vid_task_1727142000_abc123" \
  --out ./downloaded.mp4
```

---

## CLI 参数一览

| 参数 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `--prompt` | (必填) | 视频场景描述，或 Context-IR 待优化文本 |
| `--model` | `MiniMax-H3` | 模型名称：`MiniMax-H3`, `MiniMax-H3-Max`, `MiniMax-H3-Regeneration`, `MiniMax-H3-Context-IR` |
| `--resolution`| `2k` (H3) / `768p` (Max) | 分辨率：`2k`, `768p`, `1080p`, `480p`（根据模型支持） |
| `--duration` | `6` | 视频时长（秒），支持 4-15s（H3-Max 不支持 4s） |
| `--aspect-ratio`| `16:9` | 画幅比例：`16:9`, `9:16`, `1:1`, `4:3`, `3:4`, `21:9` |
| `--first-frame`| - | 首帧参考图（支持本地文件路径自动转换，或 HTTP 图片直链） |
| `--last-frame` | - | 尾帧参考图（支持本地文件路径或 HTTP 直链） |
| `--image` | - | 多图参考图片路径或 URL（可多次传递，最多 10 张） |
| `--ref-video` | - | 参考视频 URL（`MiniMax-H3-Max` 支持） |
| `--source-task-id`| - | 原任务 ID（`MiniMax-H3-Regeneration` 必传） |
| `--watermark` | `true` | 是否携带水印（1080P 分辨率强制不支持加水印） |
| `--enhance-prompt`| `false`| 开启后先调用 Context-IR 扩写分镜与运镜，再生成视频 |
| `--task-id` | - | 已有任务 ID，跳过生成直接查询并下载 |
| `--out` | `./output.mp4` | 输出文件路径 |
| `--poll-interval`| `5` | 轮询状态间隔秒数 |

---

## 计费与规则说明

- 提交任务时**不扣费**；
- 只有任务生成成功并返回后才扣费，失败或中断**绝不扣费**；
- 任务完成后视频链接具备安全鉴权与断点续传支持。

## 开源协议

MIT
