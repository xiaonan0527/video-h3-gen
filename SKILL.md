---
name: video-h3-gen
description: 使用 Nange AI MiniMax H3 系列大模型生成电影级视频。支持 MiniMax-H3（2K/768P 旗舰高清，首尾帧过渡，图生视频）、MiniMax-H3-Max（极速版，支持参考视频）、MiniMax-H3-Regeneration（768P 升级 2K 再生成）以及 MiniMax-H3-Context-IR（分镜运镜智能增强）。当用户提到"生成视频"、"做个视频"、"文生视频"、"图生视频"、"首尾帧生视频"、"minimax 视频"、"H3 视频"、"视频运镜优化"等需求时触发此技能。首次使用引导配置 API Key，后续全自动执行。
---

# MiniMax H3 电影级视频生成与运镜工坊

通过 Nange AI 平台的 MiniMax H3 系列模型生成高质量视频。支持文本生视频、首尾帧过渡生成、多图连续参考、已有成品升级 2K，以及专属分镜与运镜提示词优化。异步流水线机制：任务提交 → 实时轮询 → 媒体安全流式下载。

---

## 前置环境检查

每次触发技能时，按序执行检查：

### 1. 检查 Node.js
运行 `node -v`。如未安装，提示用户前往 https://nodejs.org/ 安装 Node.js (推荐 v18+)。

### 2. 检查 API Key 配置
优先读取环境变量 `NANGE_VIDEO_API_KEY`（或 `NANGE_API_KEY`），未检测到时读取配置文件 `~/.nange-ai/video-config.json`。

若尚未配置，引导用户配置（仅首次）：

**方式 A：环境变量（推荐）**
```bash
export NANGE_VIDEO_API_KEY="your-api-key"
```

**方式 B：专属配置文件**
```bash
mkdir -p ~/.nange-ai && echo '{"api_key":"your-api-key"}' > ~/.nange-ai/video-config.json
```

> **提示**：API Key 创建地址：https://api.nange-ai.com/keys （**分组必须选择 Video 分组**）。本技能配置与 Suno / GPT-Image 互相独立隔离。

---

## 🎬 镜头语言与提示词工程规范（MiniMax H3 专属）

MiniMax H3 系列模型具备顶级的物理模拟与光影渲染力。为了得到电影级的动态画质，编写 prompt 时必须严格遵循以下结构：

### 1. 结构化公式
**[景别与运镜] + [主体外观与动态] + [环境与光影氛围] + [画面质感与电影级渲染参数]**

- **运镜词汇库（Camera Movements）**：
  - `Slow push-in / Zoom in`（缓慢推镜头，聚焦主体神态）
  - `Pull-back / Zoom out`（平稳拉镜头，展现环境全景）
  - `Smooth tracking shot`（平滑跟拍，伴随主体运动）
  - `Low-angle heroic pan`（低角度仰拍横移，增强宏大感与史诗感）
  - `Aerial crane shot`（高空升降鸟瞰镜头）
  - `Dynamic FPV drone shot`（第一人称穿梭机极速穿越）
- **光影与质感（Atmosphere & Rendering）**：
  - `Cinematic 8k, photorealistic, shallow depth of field`
  - `Volumetric lighting, golden hour rim light, neon street reflections`
  - `Anamorphic lens flare, 35mm film grain, 24fps motion blur`

### 2. 首尾帧插值生视频规范
若用户提供了**起始图**与**结束图**：
- prompt 重点描述**“从起始状态到终点状态的变化过程与中间动作”**；
- 避免在 prompt 里重复两张图片的静态细节，而是指示物理运动路径（例如“角色从站立缓慢转身面向大海，微风吹拂长发，镜头平滑推进”）。

---

## 🧠 决策树：模型与参数自动选择

根据用户需求，自动推导最合适的模型与参数组合：

| 用户需求场景 | 推荐模型 | 核心参数配置 | 说明 |
| :--- | :--- | :--- | :--- |
| **常规高品质文生视频 / 图生视频** | `MiniMax-H3` | `--resolution 2k --duration 6` | 旗舰画质，默认 2K 输出 |
| **想要更详细、专业的分镜，或描述较简单** | `MiniMax-H3` | `--enhance-prompt --duration 10` | 自动联动 Context-IR 扩写运镜后再出片 |
| **用户提供了首尾帧两张图片** | `MiniMax-H3` | `--first-frame <图1> --last-frame <图2>` | 首尾帧自然插值过渡 |
| **追求出片速度、参考视频驱动，或需要 1080P/480P** | `MiniMax-H3-Max` | `--model MiniMax-H3-Max --resolution 768p` | 极速响应，支持 reference_videos |
| **用户已有 768P 视频任务，希望提升到 2K** | `MiniMax-H3-Regeneration` | `--source-task-id <task_id>` | 必须传入原任务 ID，输出 2K |
| **用户只需要优化/扩写分镜提示词（不生成视频）** | `MiniMax-H3-Context-IR` | `--model MiniMax-H3-Context-IR --prompt "..."` | 输出优化文本，不产生视频耗时 |

---

## CLI 执行指令示例

```bash
# 1. 经典文生视频（旗舰 2K）
node "$SKILL_DIR/scripts/generate.js" \
  --prompt "An astronaut walking in a neon cyberpunk city at night, rain slicked streets, cinematic reflections, 8k" \
  --resolution 2k \
  --duration 6 \
  --aspect-ratio 16:9 \
  --out "./cyberpunk.mp4"

# 2. 首尾帧过渡图生视频
node "$SKILL_DIR/scripts/generate.js" \
  --prompt "A warrior drawing a glowing sword, transition from resting to battle stance" \
  --first-frame "./start.jpg" \
  --last-frame "./end.jpg" \
  --duration 6 \
  --out "./sword.mp4"

# 3. 智能运镜联动（先扩写分镜再生成视频）
node "$SKILL_DIR/scripts/generate.js" \
  --prompt "赛博朋克雨夜街道追逐" \
  --enhance-prompt \
  --duration 10 \
  --out "./chase.mp4"

# 4. 升级已有 768P 视频为 2K 画质
node "$SKILL_DIR/scripts/generate.js" \
  --model MiniMax-H3-Regeneration \
  --source-task-id "vid_task_1727142000_abc123" \
  --out "./cyberpunk_2k.mp4"

# 5. 下载已有任务或失败重试
node "$SKILL_DIR/scripts/generate.js" \
  --task-id "vid_task_1727142000_abc123" \
  --out "./downloaded.mp4"
```

---

## 结果输出与交付

脚本执行完成后：
- 视频将自动下载至 `--out` 指定的文件；
- `stdout` 会直接输出该生成视频的绝对文件路径；
- 将视频路径和主要参数（模型、时长、分辨率）清晰呈现给用户。
