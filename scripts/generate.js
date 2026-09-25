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

/**
 * 校验是否为合法媒体 URL (http://, https://, asset://)
 */
function isMediaUrl(val) {
  if (typeof val !== 'string') return false;
  const trimmed = val.trim();
  return (
    trimmed.startsWith('http://') ||
    trimmed.startsWith('https://') ||
    trimmed.startsWith('asset://')
  );
}

/**
 * 纯原生 Node.js 实现 multipart/form-data 图片上传 (符合 APIMart 官方规范)
 * 官方端点规范：POST /v1/uploads/images，Header: Authorization: Bearer <key>，Body: file: <binary>
 */
function uploadImageFileToEndpoint(filePath, apiKey, uploadUrl) {
  return new Promise((resolve, reject) => {
    try {
      const boundary = '----NodeFormBoundary' + Math.random().toString(36).substring(2) + Date.now().toString(36);
      const filename = path.basename(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const mime = MIME_TYPES[ext] || 'image/png';
      const fileData = fs.readFileSync(filePath);

      const head = Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        `Content-Type: ${mime}\r\n\r\n`
      );
      const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
      const payload = Buffer.concat([head, fileData, tail]);

      const parsedUrl = new URL(uploadUrl);
      const mod = parsedUrl.protocol === 'https:' ? https : http;
      const req = mod.request(uploadUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': payload.length,
          'User-Agent': 'video-h3-gen/1.0',
        },
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode >= 400) {
            let errMsg = `HTTP ${res.statusCode}: ${data}`;
            try {
              const errObj = JSON.parse(data);
              if (errObj.error && errObj.error.message) errMsg = errObj.error.message;
              else if (errObj.message) errMsg = errObj.message;
            } catch (_) {}
            reject(new Error(errMsg));
          } else {
            try {
              const json = JSON.parse(data);
              const targetUrl = json.url || (json.data && json.data.url);
              if (targetUrl) {
                resolve(targetUrl);
              } else {
                reject(new Error(`响应数据未包含 url: ${data.substring(0, 150)}`));
              }
            } catch (e) {
              reject(new Error(`解析 JSON 失败: ${data.substring(0, 150)}`));
            }
          }
        });
      });

      req.on('error', reject);
      req.write(payload);
      req.end();
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * 候选上传端点探索与尝试
 */
async function tryUploadLocalImage(absPath, apiKey) {
  const candidateEndpoints = [];

  // 1. 用户自定义上传端点环境变量
  if (process.env.NANGE_UPLOAD_URL) candidateEndpoints.push(process.env.NANGE_UPLOAD_URL.trim());
  if (process.env.APIMART_UPLOAD_URL) candidateEndpoints.push(process.env.APIMART_UPLOAD_URL.trim());

  // 2. 根据 BASE_URL 衍生可能的上传路径
  try {
    const baseObj = new URL(BASE_URL);
    // 例如 https://api.nange-ai.com/video/v1/uploads/images
    candidateEndpoints.push(`${BASE_URL.replace(/\/+$/, '')}/uploads/images`);
    // 例如 https://api.nange-ai.com/v1/uploads/images
    candidateEndpoints.push(`${baseObj.origin}/v1/uploads/images`);
  } catch (_) {}

  const endpoints = [...new Set(candidateEndpoints)];

  let lastError = null;
  for (const endpoint of endpoints) {
    try {
      const url = await uploadImageFileToEndpoint(absPath, apiKey, endpoint);
      if (url && isMediaUrl(url)) {
        return { success: true, url, endpoint };
      }
    } catch (err) {
      lastError = err;
    }
  }

  return { success: false, error: lastError };
}

/**
 * 解析并规范化媒体入参
 * 严格遵照 APIMart 与 MiniMax 官方规范：
 * 1. 仅接收 http://, https://, asset://
 * 2. 严禁使用 Base64 Data URI
 * 3. 本地图片尝试自动上传为公网 URL；若服务节点不可用，给出清晰引导和明确拦截，绝不 fallback 到 Base64
 */
async function resolveMediaArg(arg, label, apiKey) {
  if (!arg) return null;
  const trimmed = arg.trim();

  // 拦截非法的 Base64 Data URI
  if (trimmed.startsWith('data:')) {
    console.error(`\n======================================================`);
    console.error(`[参数错误] ${label || '素材'}不能使用 Base64 Data URI！`);
    console.error(`======================================================`);
    console.error(`MiniMax-H3 / APIMart 视频 API 规范明确禁止在生成请求中传入 Base64 数据。`);
    console.error(`媒体参数必须是可直接访问的链接 (http://, https:// 或 asset://)。`);
    console.error(`建议：请使用公网图片链接（如生图任务生成的临时 https:// 地址，或图床链接）。\n`);
    process.exit(1);
  }

  // 若已是合法的公网 URL 或 asset:// 链接，直接返回
  if (isMediaUrl(trimmed)) {
    return trimmed;
  }

  // 检测本地文件路径
  const absPath = path.resolve(trimmed);
  if (!fs.existsSync(absPath)) {
    console.error(`\n======================================================`);
    console.error(`[参数错误] ${label || '素材'}不存在且非有效链接: ${trimmed}`);
    console.error(`======================================================`);
    console.error(`MiniMax 视频生成接口仅支持：`);
    console.error(`  1. 公网可访问的 HTTP/HTTPS 链接 (http:// 或 https://)`);
    console.error(`  2. 内部资产链接 (asset://)`);
    console.error(`  3. 本地图片文件（将由脚本尝试自动上传换取 URL）\n`);
    process.exit(1);
  }

  const ext = path.extname(absPath).toLowerCase();
  const isImage = Boolean(MIME_TYPES[ext]);

  if (isImage) {
    process.stderr.write(`[素材处理] 检测到本地图片: ${path.basename(absPath)}，正在尝试自动上传换取公网 URL...\n`);
    const uploadRes = await tryUploadLocalImage(absPath, apiKey);
    if (uploadRes.success) {
      process.stderr.write(`[素材处理] 图片上传成功 -> ${uploadRes.url}\n`);
      return uploadRes.url;
    }

    // 上传失败：严禁使用 Base64 乱搞，Fail-Fast 退出并给出解决方案
    const errReason = uploadRes.error ? uploadRes.error.message : '所有候选上传端点均不可用';
    console.error(`\n================================================================================`);
    console.error(`[错误] 本地图片无法直接用于视频生成: ${trimmed}`);
    console.error(`================================================================================`);
    console.error(`原因分析：`);
    console.error(`1. MiniMax 视频生成接口严格只接收 http://, https://, asset:// 链接，不支持直接传入本地文件。`);
    console.error(`2. 官方接口规范明确声明：为了更好的性能和成本控制，不再支持在生成接口中直接传入 Base64 数据。`);
    console.error(`3. 脚本尝试自动上传该图片换取公网 URL，但上传未成功 (${errReason})。`);
    console.error(``);
    console.error(`推荐解决方案：`);
    console.error(`• 方式 1 [工作流联动]：若素材来自上一阶段生图（如 GPT-Image），直接将返回的公网 https:// 临时链接传入本脚本。`);
    console.error(`• 方式 2 [图床/存储]：将本地图片上传至对象存储 (OSS/COS/S3/GitHub 图床等)，传入可公开访问的 https:// 链接。`);
    console.error(`• 方式 3 [指定端点]：若拥有可用的 APIMart 兼容上传端点，可通过设置环境变量指定：`);
    console.error(`    export NANGE_UPLOAD_URL="https://your-api.com/v1/uploads/images"`);
    console.error(`================================================================================\n`);
    process.exit(1);
  }

  // 本地视频/音频
  console.error(`\n================================================================================`);
  console.error(`[错误] 参考${label || '媒体'}不支持本地文件路径: ${trimmed}`);
  console.error(`================================================================================`);
  console.error(`MiniMax 视频与音频参考素材目前仅支持公网 http://, https:// 或 asset:// 链接。`);
  console.error(`请将本地视频/音频文件上传至公网对象存储或网盘直链后，使用 URL 格式传入本参数。`);
  console.error(`================================================================================\n`);
  process.exit(1);
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
      const curUrlObj = new URL(targetUrl);
      const curHeaders = {};
      const baseHost = new URL(BASE_URL).hostname;
      if ((curUrlObj.hostname === baseHost || curUrlObj.hostname.includes('nange-ai.com')) && apiKey) {
        curHeaders['Authorization'] = `Bearer ${apiKey}`;
      }

      curMod.get(targetUrl, { headers: curHeaders }, (res) => {
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

function extractTaskIdFromResult(result) {
  if (!result) return '';
  if (typeof result.task_id === 'string' && result.task_id) return result.task_id;
  if (typeof result.id === 'string' && result.id) return result.id;
  if (Array.isArray(result.data) && result.data.length > 0) {
    const first = result.data[0];
    if (first && typeof first === 'object') {
      if (typeof first.task_id === 'string' && first.task_id) return first.task_id;
      if (typeof first.id === 'string' && first.id) return first.id;
    } else if (typeof first === 'string' && first) {
      return first;
    }
  }
  if (result.data && typeof result.data === 'object' && !Array.isArray(result.data)) {
    if (typeof result.data.task_id === 'string' && result.data.task_id) return result.data.task_id;
    if (typeof result.data.id === 'string' && result.data.id) return result.data.id;
  }
  return '';
}

function extractVideoUrlFromRes(res) {
  if (!res) return '';
  if (typeof res.video_url === 'string' && res.video_url) return res.video_url;
  if (Array.isArray(res.videos) && res.videos.length > 0) {
    const v = res.videos[0];
    if (typeof v === 'string' && v) return v;
    if (v && typeof v === 'object') {
      if (Array.isArray(v.url) && v.url.length > 0 && typeof v.url[0] === 'string') {
        return v.url[0];
      }
      if (typeof v.url === 'string' && v.url) {
        return v.url;
      }
    }
  }
  if (typeof res.url === 'string' && res.url) return res.url;
  return '';
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

  const taskID = extractTaskIdFromResult(result);
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

  const data = (Array.isArray(result.data) ? result.data[0] : result.data) || result;
  const status = (data.status || '').toLowerCase();
  const resObj = data.result || {};
  const progress = data.progress !== undefined ? data.progress : (status === 'success' || status === 'completed' ? 100 : 0);
  const errMsg = (data.error && data.error.message) || (result.error && result.error.message) || data.message || '';

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
async function optimizePromptWithContextIR(apiKey, rawPrompt, duration, aspectRatio) {
  process.stderr.write(`\n>>> [Context-IR] 正在智能扩展分镜与运镜提示词...\n`);
  const body = {
    model: MODEL_H3_CONTEXT_IR,
    prompt: rawPrompt,
    duration: duration > 0 ? duration : 5,
    aspect_ratio: aspectRatio || '16:9',
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
    refAudios: [],
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
      case '--ref-video':
      case '--video-url': parsed.refVideos.push(args[++i]); break;
      case '--ref-audio':
      case '--audio-url': parsed.refAudios.push(args[++i]); break;
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
  node generate.js --prompt "镜头平滑推移过渡" --first-frame "https://example.com/start.jpg" --last-frame "https://example.com/end.jpg"

智能运镜扩写后生视频:
  node generate.js --prompt "武侠客栈夜雨中的剑客对决" --enhance-prompt --duration 10

升级已有视频为 2K 画质:
  node generate.js --model MiniMax-H3-Regeneration --source-task-id "vid_task_xxx"

纯文本运镜提示词优化:
  node generate.js --model MiniMax-H3-Context-IR --prompt "海边日落" --out ./enhanced_prompt.txt

下载已有任务视频:
  node generate.js --task-id "vid_task_xxx" --out ./my_video.mp4

选项列表:
  --prompt <text>          视频场景描述或待优化的提示词 (最长 7000 字符)
  --model <name>           模型名称: MiniMax-H3 (默认) | MiniMax-H3-Max | MiniMax-H3-Regeneration | MiniMax-H3-Context-IR
  --resolution <res>       视频分辨率: 2k (默认) | 768p | 1080p | 480p (视模型支持而定)
  --duration <sec>         生成时长: 6s (默认) (H3 支持 4-15s, H3-Max 支持 5-15s 不支持 4s)
  --aspect-ratio <ratio>   画幅比例: 16:9 (默认) | 9:16 | 1:1 | 4:3 | 3:4 | 21:9
  --first-frame <url/path> 首帧图 (支持 http/https/asset 链接，本地图片自动尝试上传)
  --last-frame <url/path>  尾帧图 (支持 http/https/asset 链接，本地图片自动尝试上传)
  --image <url/path>       多图参考 (支持 http/https/asset 链接，本地图片自动尝试上传，最多 9 张)
  --ref-video <url>        参考视频 URL (支持 http/https/asset 链接，最多 3 段)
  --ref-audio <url>        参考音频 URL (支持 http/https/asset 链接，最多 3 段)
  --source-task-id <id>    溯源任务 ID (MiniMax-H3-Regeneration 必传)
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

    const videoUrl = extractVideoUrlFromRes(res);
    if (!videoUrl) {
      throw new Error('任务返回结果中未包含有效视频链接: ' + JSON.stringify(res));
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
    finalPrompt = await optimizePromptWithContextIR(apiKey, opts.prompt, opts.duration, opts.aspectRatio);
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
    requestBody.aspect_ratio = opts.aspectRatio || '16:9';
    requestBody.duration = opts.duration > 0 ? opts.duration : 5;
    if (opts.firstFrame) requestBody.first_frame_image = await resolveMediaArg(opts.firstFrame, '首帧图片', apiKey);
    if (opts.lastFrame) requestBody.last_frame_image = await resolveMediaArg(opts.lastFrame, '尾帧图片', apiKey);
    if (opts.images && opts.images.length > 0) {
      requestBody.image_urls = await Promise.all(opts.images.map((img, i) => resolveMediaArg(img, `参考图片 #${i + 1}`, apiKey)));
    }
    if (opts.refVideos && opts.refVideos.length > 0) {
      requestBody.video_urls = await Promise.all(opts.refVideos.map((v, i) => resolveMediaArg(v, `参考视频 #${i + 1}`, apiKey)));
    }
    if (opts.refAudios && opts.refAudios.length > 0) {
      requestBody.audio_urls = await Promise.all(opts.refAudios.map((a, i) => resolveMediaArg(a, `参考音频 #${i + 1}`, apiKey)));
    }

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
    // 官方规范：Regeneration 只需要 source_task_id，平台自动回填 prompt、素材、画幅和时长
    delete requestBody.prompt;
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

    // 时长推导
    if (opts.duration > 0) {
      requestBody.duration = opts.duration;
    } else {
      requestBody.duration = 6;
    }

    // 校验各模型限制
    if (targetModel === MODEL_H3_MAX) {
      if (requestBody.duration === 4) {
        console.error(`错误：${MODEL_H3_MAX} 不支持 4 秒时长，支持范围为 5-15 秒`);
        process.exit(1);
      }
      if (requestBody.resolution === '2K') {
        console.error(`错误：${MODEL_H3_MAX} 不支持 2K 分辨率，支持: 480P, 768P, 1080P`);
        process.exit(1);
      }
      if (requestBody.resolution === '1080P') {
        if (opts.watermark === true) {
          console.error(`错误：${MODEL_H3_MAX} 在 1080P 分辨率下不支持加水印`);
          process.exit(1);
        }
        // 1080P 下完全不传递 watermark 字段，避免上游报 400
      } else if (opts.watermark !== undefined) {
        requestBody.watermark = opts.watermark;
      }
    } else if (targetModel === MODEL_H3) {
      if (requestBody.resolution !== '2K' && requestBody.resolution !== '768P') {
        console.error(`错误：${MODEL_H3} 仅支持 2K 或 768P 分辨率`);
        process.exit(1);
      }
      if (opts.watermark !== undefined) {
        requestBody.watermark = opts.watermark;
      }
    }

    // 挂载参考素材（使用 APIMart 官方规范字段名）
    if (opts.firstFrame) {
      requestBody.first_frame_image = await resolveMediaArg(opts.firstFrame, '首帧图片', apiKey);
    }
    if (opts.lastFrame) {
      requestBody.last_frame_image = await resolveMediaArg(opts.lastFrame, '尾帧图片', apiKey);
    }
    if (opts.images && opts.images.length > 0) {
      requestBody.image_urls = await Promise.all(opts.images.map((img, i) => resolveMediaArg(img, `参考图片 #${i + 1}`, apiKey)));
    }
    if (opts.refVideos && opts.refVideos.length > 0) {
      requestBody.video_urls = await Promise.all(opts.refVideos.map((v, i) => resolveMediaArg(v, `参考视频 #${i + 1}`, apiKey)));
    }
    if (opts.refAudios && opts.refAudios.length > 0) {
      requestBody.audio_urls = await Promise.all(opts.refAudios.map((a, i) => resolveMediaArg(a, `参考音频 #${i + 1}`, apiKey)));
    }
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
  if (requestBody.image_urls) process.stderr.write(`  参考图片数: ${requestBody.image_urls.length}\n`);
  if (requestBody.video_urls) process.stderr.write(`  参考视频数: ${requestBody.video_urls.length}\n`);
  if (requestBody.audio_urls) process.stderr.write(`  参考音频数: ${requestBody.audio_urls.length}\n`);

  const taskID = await submitTask(apiKey, requestBody);
  process.stderr.write(`任务已提交成功！Task ID: ${taskID}\n`);
  process.stderr.write(`正在轮询等待生成结果 (通常需要 1~3 分钟)...\n`);

  // 6. 轮询结果
  const res = await pollTask(apiKey, taskID, opts.pollInterval);
  const videoUrl = extractVideoUrlFromRes(res);
  if (!videoUrl) {
    throw new Error('未在任务结果中找到有效的视频链接: ' + JSON.stringify(res));
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
