#!/usr/bin/env node
/**
 * MiniMax H3 视频生成与运镜提示词优化 CLI 脚本
 *
 * 功能特性：
 * 1. 支持 MiniMax-H3（2K/768P 旗舰高清，首尾帧/多图生视频）
 * 2. 支持 MiniMax-H3-Max（480P/768P/1080P 极速生成，支持参考视频）
 * 3. 支持 MiniMax-H3-Regeneration（768P -> 2K 升级画质再生成）
 * 4. 支持 MiniMax-H3-Context-IR（纯文本多模态分镜与运镜提示词增强）
 * 5. 独家联动开关 --enhance-prompt：先自动调用 Context-IR 扩写分镜，再提交生成视频
 * 6. 支持 --task-id 直接查询与流式断点下载已有任务结果
 * 7. 纯原生 Node.js 实现，零外部依赖，跨平台兼容
 */

const https = require('https');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const VIDEO_CONFIG_PATH = path.join(os.homedir(), '.nange-ai', 'video-config.json');
const COMMON_CONFIG_PATH = path.join(os.homedir(), '.nange-ai', 'config.json');
const BASE_URL = 'https://api.nange-ai.com/video/v1';

const MODEL_H3 = 'MiniMax-H3';
const MODEL_H3_MAX = 'MiniMax-H3-Max';
const MODEL_H3_REGEN = 'MiniMax-H3-Regeneration';
const MODEL_H3_CONTEXT_IR = 'MiniMax-H3-Context-IR';

const VALID_MODELS = [MODEL_H3, MODEL_H3_MAX, MODEL_H3_REGEN, MODEL_H3_CONTEXT_IR];
const MIME_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
};

/**
 * 读取 API Key
 * 优先级：
 * 1. 环境变量 NANGE_VIDEO_API_KEY
 * 2. 环境变量 NANGE_API_KEY
 * 3. ~/.nange-ai/video-config.json (api_key)
 * 4. ~/.nange-ai/config.json (video_api_key 或 api_key)
 */
function loadApiKey() {
  const envKey = process.env.NANGE_VIDEO_API_KEY || process.env.NANGE_API_KEY;
  if (envKey && envKey.trim()) {
    return envKey.trim();
  }

  if (fs.existsSync(VIDEO_CONFIG_PATH)) {
    try {
      const config = JSON.parse(fs.readFileSync(VIDEO_CONFIG_PATH, 'utf-8'));
      if (config.api_key && config.api_key !== 'YOUR_KEY' && config.api_key.trim()) {
        return config.api_key.trim();
      }
    } catch (_) { /* ignore parse error */ }
  }

  if (fs.existsSync(COMMON_CONFIG_PATH)) {
    try {
      const config = JSON.parse(fs.readFileSync(COMMON_CONFIG_PATH, 'utf-8'));
      if (config.video_api_key && config.video_api_key !== 'YOUR_KEY' && config.video_api_key.trim()) {
        return config.video_api_key.trim();
      }
      if (config.api_key && config.api_key !== 'YOUR_KEY' && config.api_key.trim()) {
        return config.api_key.trim();
      }
    } catch (_) { /* ignore parse error */ }
  }

  console.error('错误：未找到 Video API Key');
  console.error('');
  console.error('请选择以下任一方式配置：');
  console.error('');
  console.error('  方式 A（环境变量，推荐）：');
  console.error('    export NANGE_VIDEO_API_KEY="your-api-key"');
  console.error('');
  console.error('  方式 B（Video 专属配置文件）：');
  if (process.platform === 'win32') {
    console.error(`    mkdir "%USERPROFILE%\\.nange-ai" && echo {"api_key":"YOUR_KEY"} > "%USERPROFILE%\\.nange-ai\\video-config.json"`);
  } else {
    console.error(`    mkdir -p ~/.nange-ai && echo '{"api_key":"YOUR_KEY"}' > ~/.nange-ai/video-config.json`);
  }
  console.error('');
  console.error('API Key 创建地址：https://api.nange-ai.com/keys（创建时必须关联 Video 分组）');
  process.exit(1);
}

function request(url, options, body) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.request(url, options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 400) {
          let errMsg = `HTTP ${res.statusCode}: ${data}`;
          try {
            const errObj = JSON.parse(data);
            if (errObj.error && errObj.error.message) {
              errMsg = errObj.error.message;
            } else if (errObj.message) {
              errMsg = errObj.message;
            }
          } catch (_) {}
          reject(new Error(errMsg));
        } else {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`无效的 JSON 响应: ${data.substring(0, 200)}`));
          }
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function resolveMediaArg(arg, label) {
  if (!arg) return null;
  const trimmed = arg.trim();
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://') || trimmed.startsWith('data:')) {
    return trimmed;
  }
  const absPath = path.resolve(trimmed);
  if (!fs.existsSync(absPath)) {
    console.error(`错误：${label || '素材'}文件不存在 → ${absPath}`);
    process.exit(1);
  }
  const ext = path.extname(absPath).toLowerCase();
  const mime = MIME_TYPES[ext] || 'application/octet-stream';
  const b64 = fs.readFileSync(absPath).toString('base64');
  process.stderr.write(`已载入本地素材: ${absPath} (${mime})\n`);
  return `data:${mime};base64,${b64}`;
}

function downloadFile(url, dest, apiKey) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const urlObj = new URL(url);
    const headers = {};
    if (urlObj.hostname.includes('nange-ai.com') && apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const doDownload = (targetUrl) => {
      const curMod = targetUrl.startsWith('https') ? https : http;
      curMod.get(targetUrl, { headers }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return doDownload(res.headers.location);
        }
        if (res.statusCode >= 400) {
          reject(new Error(`下载失败 HTTP ${res.statusCode}`));
          return;
        }
        const ws = fs.createWriteStream(dest);
        res.pipe(ws);
        ws.on('finish', () => { ws.close(); resolve(); });
        ws.on('error', reject);
      }).on('error', reject);
    };

    doDownload(url);
  });
}

async function submitTask(apiKey, bodyObj) {
  const payload = JSON.stringify(bodyObj);
  const result = await request(`${BASE_URL}/videos/generations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
  }, payload);

  const taskID = result.task_id || (result.data && result.data.task_id) || result.id || (result.data && result.data.id);
  if (!taskID) {
    throw new Error('未获取到 task_id，接口返回: ' + JSON.stringify(result).substring(0, 300));
  }
  return taskID;
}

async function fetchTaskStatus(apiKey, taskID) {
  const result = await request(`${BASE_URL}/tasks/${taskID}`, {
    headers: {
      'Authorization': `Bearer ${apiKey}`,
    },
  });

  const data = result.data || result;
  const status = (data.status || '').toLowerCase();
  const resObj = data.result || {};
  const progress = data.progress !== undefined ? data.progress : (status === 'success' || status === 'completed' ? 100 : 0);
  const errMsg = (data.error && data.error.message) || data.message || '';

  return { status, resObj, progress, errMsg, raw: data };
}

async function pollTask(apiKey, taskID, pollIntervalMs = 5000) {
  const timeoutMs = 15 * 60 * 1000; // 最长等待 15 分钟
  const start = Date.now();

  while (true) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('任务超时（超过 15 分钟）');
    }

    const { status, resObj, progress, errMsg } = await fetchTaskStatus(apiKey, taskID);

    if (status === 'success' || status === 'completed') {
      return resObj;
    }
    if (status === 'failed') {
      throw new Error(errMsg || '任务生成失败');
    }

    const elapsedSec = Math.floor((Date.now() - start) / 1000);
    const progressText = progress > 0 ? ` (${progress}%)` : '';
    process.stderr.write(`处理中... [状态: ${status}]${progressText} 已耗时 ${elapsedSec}s\n`);

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

/**
 * 独家 Context-IR 提示词优化工作流
 */
async function optimizePromptWithContextIR(apiKey, rawPrompt) {
  process.stderr.write(`\n>>> [Context-IR] 正在智能扩展分镜与运镜提示词...\n`);
  const body = {
    model: MODEL_H3_CONTEXT_IR,
    prompt: rawPrompt,
  };
  const taskID = await submitTask(apiKey, body);
  process.stderr.write(`[Context-IR] 任务已提交: ${taskID}，等待优化结果...\n`);
  const res = await pollTask(apiKey, taskID, 2000);
  const optimizedPrompt = res.prompt || res.text || '';
  if (!optimizedPrompt) {
    process.stderr.write(`[Context-IR] 未返回扩写结果，继续使用原提示词\n`);
    return rawPrompt;
  }
  process.stderr.write(`[Context-IR] 优化完成！新运镜分镜 Prompt:\n${optimizedPrompt}\n\n`);
  return optimizedPrompt;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {
    prompt: '',
    model: '',
    resolution: '',
    duration: 0,
    aspectRatio: '',
    firstFrame: '',
    lastFrame: '',
    images: [],
    refVideos: [],
    sourceTaskId: '',
    watermark: undefined,
    enhancePrompt: false,
    taskId: '',
    out: '',
    pollInterval: 5000,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--prompt': parsed.prompt = args[++i]; break;
      case '--model': parsed.model = args[++i]; break;
      case '--resolution': parsed.resolution = args[++i]; break;
      case '--duration': parsed.duration = parseInt(args[++i], 10); break;
      case '--aspect-ratio': parsed.aspectRatio = args[++i]; break;
      case '--first-frame': parsed.firstFrame = args[++i]; break;
      case '--last-frame': parsed.lastFrame = args[++i]; break;
      case '--image':
      case '--image-url': parsed.images.push(args[++i]); break;
      case '--ref-video': parsed.refVideos.push(args[++i]); break;
      case '--source-task-id': parsed.sourceTaskId = args[++i]; break;
      case '--watermark': parsed.watermark = args[++i] === 'true'; break;
      case '--enhance-prompt': parsed.enhancePrompt = true; break;
      case '--task-id': parsed.taskId = args[++i]; break;
      case '--out': parsed.out = args[++i]; break;
      case '--poll-interval': parsed.pollInterval = parseInt(args[++i], 10) * 1000; break;
      case '--help':
      case '-h':
        printUsage();
        process.exit(0);
    }
  }

  return parsed;
}

function printUsage() {
  console.log(`
MiniMax H3 视频生成与运镜优化工具

用法:
  node generate.js [选项]

常规提交视频任务:
  node generate.js --prompt "赛博朋克夜景，宇航员漫步在霓虹街道上" --duration 6 --resolution 768p

首尾帧插值生视频:
  node generate.js --prompt "镜头平滑推移过渡" --first-frame ./start.jpg --last-frame ./end.jpg

智能运镜扩写后生视频:
  node generate.js --prompt "武侠客栈夜雨中的剑客对决" --enhance-prompt --duration 10

升级已有视频为 2K 画质:
  node generate.js --model MiniMax-H3-Regeneration --source-task-id "vid_task_xxx"

纯文本运镜提示词优化:
  node generate.js --model MiniMax-H3-Context-IR --prompt "海边日落" --out ./enhanced_prompt.txt

下载已有任务视频:
  node generate.js --task-id "vid_task_xxx" --out ./my_video.mp4

选项列表:
  --prompt <text>          视频场景描述或待优化的提示词
  --model <name>           模型名称: MiniMax-H3 (默认) | MiniMax-H3-Max | MiniMax-H3-Regeneration | MiniMax-H3-Context-IR
  --resolution <res>       视频分辨率: 2k (默认) | 768p | 1080p | 480p (视模型支持而定)
  --duration <sec>         生成时长: 6s (默认) | 10s (支持 4-15s, H3-Max 不支持 4s)
  --aspect-ratio <ratio>   画幅比例: 16:9 (默认) | 9:16 | 1:1 | 4:3 | 3:4 | 21:9
  --first-frame <path/url> 首帧图（支持本地图片路径或 HTTP URL）
  --last-frame <path/url>  尾帧图（支持本地图片路径或 HTTP URL）
  --image <path/url>       多图参考（可多次传递此选项，最多支持 10 张）
  --ref-video <url>        参考视频 URL（H3-Max 支持）
  --source-task-id <id>    溯源任务 ID（MiniMax-H3-Regeneration 必传）
  --watermark <bool>       是否携带水印 (默认 true, 1080P 下不支持加水印)
  --enhance-prompt         智能联动: 先调用 Context-IR 扩写分镜与运镜，再生成视频
  --task-id <id>           查询并下载已有任务，跳过提交
  --out <path>             输出文件路径 (视频默认 ./output.mp4, 提示词默认控制台输出)
  --poll-interval <sec>    轮询间隔秒数 (默认 5)
  -h, --help               查看使用说明
`);
}

async function main() {
  const opts = parseArgs();
  const apiKey = loadApiKey();

  // 1. 模式 A：直接根据 --task-id 下载已有结果
  if (opts.taskId) {
    process.stderr.write(`正在查询已有任务: ${opts.taskId}\n`);
    const res = await pollTask(apiKey, opts.taskId, opts.pollInterval);

    if (res.prompt) {
      console.log(res.prompt);
      if (opts.out) {
        fs.writeFileSync(path.resolve(opts.out), res.prompt, 'utf-8');
        process.stderr.write(`提示词已保存至: ${path.resolve(opts.out)}\n`);
      }
      return;
    }

    const videoUrl = res.video_url || (res.videos && res.videos[0] && (res.videos[0].url || res.videos[0]));
    if (!videoUrl) {
      throw new Error('任务返回结果中未包含有效视频链接');
    }

    const outPath = path.resolve(opts.out || './output.mp4');
    const outDir = path.dirname(outPath);
    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true });
    }
    process.stderr.write(`正在下载视频到 ${outPath} ...\n`);
    await downloadFile(videoUrl, outPath, apiKey);
    process.stderr.write(`下载完成！\n`);
    console.log(outPath);
    return;
  }

  // 2. 参数自动推导与智能校验
  let targetModel = opts.model ? opts.model.trim() : '';

  if (!targetModel) {
    if (opts.sourceTaskId) {
      targetModel = MODEL_H3_REGEN;
    } else if (opts.refVideos.length > 0 || (opts.resolution && opts.resolution.toUpperCase() === '1080P') || (opts.resolution && opts.resolution.toUpperCase() === '480P')) {
      targetModel = MODEL_H3_MAX;
    } else {
      targetModel = MODEL_H3;
    }
  }

  // 校验模型合法性（忽略大小写规范化）
  const matchedModel = VALID_MODELS.find(m => m.toLowerCase() === targetModel.toLowerCase());
  if (!matchedModel) {
    console.error(`错误：不支持的模型 "${targetModel}"，支持: ${VALID_MODELS.join(', ')}`);
    process.exit(1);
  }
  targetModel = matchedModel;

  // 提示词校验
  if (!opts.prompt && targetModel !== MODEL_H3_REGEN) {
    console.error('错误：必须提供 --prompt 视频生成描述提示词');
    printUsage();
    process.exit(1);
  }

  // 3. 执行 Context-IR 优化联动（如果启用）
  let finalPrompt = opts.prompt;
  if (opts.enhancePrompt && targetModel !== MODEL_H3_CONTEXT_IR) {
    finalPrompt = await optimizePromptWithContextIR(apiKey, opts.prompt);
  }

  // 4. 构建提交请求体
  const requestBody = {
    model: targetModel,
  };

  if (finalPrompt) {
    requestBody.prompt = finalPrompt;
  }

  // 针对 Context-IR 模型的特化执行
  if (targetModel === MODEL_H3_CONTEXT_IR) {
    process.stderr.write(`正在提交 Context-IR 运镜提示词优化任务...\n`);
    const taskID = await submitTask(apiKey, requestBody);
    process.stderr.write(`任务已提交: ${taskID}，正在等待结果...\n`);
    const res = await pollTask(apiKey, taskID, opts.pollInterval);
    const optimized = res.prompt || res.text || '';
    if (opts.out) {
      const outPath = path.resolve(opts.out);
      fs.writeFileSync(outPath, optimized, 'utf-8');
      process.stderr.write(`优化后提示词已写入文件: ${outPath}\n`);
    }
    console.log(optimized);
    return;
  }

  // 针对视频生成模型填充规格
  if (targetModel === MODEL_H3_REGEN) {
    if (!opts.sourceTaskId) {
      console.error(`错误：${MODEL_H3_REGEN} 模型必须传入 --source-task-id`);
      process.exit(1);
    }
    requestBody.source_task_id = opts.sourceTaskId;
    requestBody.resolution = '2K';
  } else {
    // 分辨率推导
    if (opts.resolution) {
      requestBody.resolution = opts.resolution.toUpperCase();
    } else {
      requestBody.resolution = targetModel === MODEL_H3 ? '2K' : '768P';
    }

    if (opts.aspectRatio) {
      requestBody.aspect_ratio = opts.aspectRatio;
    }
  }

  // 时长
  if (opts.duration > 0) {
    requestBody.duration = opts.duration;
  } else {
    requestBody.duration = 6;
  }

  if (opts.watermark !== undefined) {
    requestBody.watermark = opts.watermark;
  }

  // 挂载参考素材
  if (opts.firstFrame) {
    requestBody.first_frame_image = resolveMediaArg(opts.firstFrame, '首帧图片');
  }
  if (opts.lastFrame) {
    requestBody.last_frame_image = resolveMediaArg(opts.lastFrame, '尾帧图片');
  }
  if (opts.images && opts.images.length > 0) {
    requestBody.images = opts.images.map((img, i) => resolveMediaArg(img, `参考图片 #${i + 1}`));
  }
  if (opts.refVideos && opts.refVideos.length > 0) {
    requestBody.reference_videos = opts.refVideos;
  }

  // 5. 提交视频生成任务
  process.stderr.write(`\n正在提交视频生成任务...\n`);
  process.stderr.write(`  模型: ${targetModel}\n`);
  if (requestBody.resolution) process.stderr.write(`  分辨率: ${requestBody.resolution}\n`);
  if (requestBody.duration) process.stderr.write(`  时长: ${requestBody.duration}s\n`);
  if (requestBody.aspect_ratio) process.stderr.write(`  画幅: ${requestBody.aspect_ratio}\n`);
  if (requestBody.source_task_id) process.stderr.write(`  原任务溯源: ${requestBody.source_task_id}\n`);
  if (requestBody.first_frame_image) process.stderr.write(`  首帧图: [已加载]\n`);
  if (requestBody.last_frame_image) process.stderr.write(`  尾帧图: [已加载]\n`);
  if (requestBody.images) process.stderr.write(`  参考图片数: ${requestBody.images.length}\n`);

  const taskID = await submitTask(apiKey, requestBody);
  process.stderr.write(`任务已提交成功！Task ID: ${taskID}\n`);
  process.stderr.write(`正在轮询等待生成结果 (通常需要 1~3 分钟)...\n`);

  // 6. 轮询结果
  const res = await pollTask(apiKey, taskID, opts.pollInterval);
  const videoUrl = res.video_url || (res.videos && res.videos[0] && (res.videos[0].url || res.videos[0]));
  if (!videoUrl) {
    throw new Error('未在任务结果中找到有效的 video_url: ' + JSON.stringify(res));
  }

  // 7. 下载视频
  const outPath = path.resolve(opts.out || './output.mp4');
  const outDir = path.dirname(outPath);
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  process.stderr.write(`正在下载视频到 ${outPath} ...\n`);
  await downloadFile(videoUrl, outPath, apiKey);
  process.stderr.write(`视频生成并下载成功！\n`);
  console.log(outPath);
}

main().catch((err) => {
  console.error(`错误：${err.message}`);
  process.exit(1);
});
