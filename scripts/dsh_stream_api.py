"""dsh-gsv-tts 真流式 API 服务

修复 personal_api.py /tts/stream 的假流式问题：
- 原实现用 list(tts.infer_stream(...)) 一次性消费完再逐块发——首包延迟≈总耗时
- 本端点用 infer_stream_async 逐块 yield，首块到达即推送

路径处理（可移植，无机器硬编码）：
- 仓库根目录（本脚本位于 <repo>/API/ 下）优先，取仓库源码 gsv_tts
- 自动探测 --target 安装的 site-packages（同级或仓库内）并追加
- 系统 site-packages 保持在默认优先级（在 --target 之前），避免依赖版本冲突
- dsh_start_wrapper.py（setup.ts 生成）也会注入路径，二者互不干扰

v2.1 变更：
- lifespan 替代已废弃的 @app.on_event("startup")
- 增加 CORS 头（便于浏览器跨源播放/调试）
- prompt_text 为空时尝试 ASR 自动转写（能力探测，不可用时返回明确错误）
- done 事件 total_duration 按逐块采样数累加（真实秒数；注意 clip.audio_len_s 是跨块累计值，不能直接求和）
"""
import os
import sys
import json
import base64
import asyncio
import logging
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

os.environ['GSV_DISABLE_CUDA_GRAPH'] = '1'

# ─── 路径注入（可移植）───
# 仓库源码优先（支持 GSV_DISABLE_CUDA_GRAPH 环境变量，PyPI 版不支持）
repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, repo_root)
# 自动探测 --target 安装的依赖目录（同级 site-packages 或仓库内 site-packages）
for candidate in (
    os.path.join(os.path.dirname(repo_root), 'site-packages'),  # D:\GSV\site-packages 式布局
    os.path.join(repo_root, 'site-packages'),                    # 仓库内布局
):
    if os.path.isdir(candidate) and candidate not in sys.path:
        sys.path.append(candidate)

try:
    import transformers.utils.import_utils
    import transformers.modeling_utils
    transformers.utils.import_utils.check_torch_load_is_safe = lambda: None
    transformers.modeling_utils.check_torch_load_is_safe = lambda: None
except Exception:
    pass

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from gsv_tts import TTS

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("dsh_stream_api")

# 预热用的默认模型文件名（缺失时仅告警，不影响启动）
DEFAULT_GPT_CKPT = "s1v3.ckpt"
DEFAULT_SOVITS_PTH = "s2Gv2ProPlus.pth"
EXAMPLE_SPEAKER = "laffey.mp3"
EXAMPLE_PROMPT = "AnAn.ogg"

tts: Optional[TTS] = None
models_dir_global: Optional[Path] = None


class StreamRequest(BaseModel):
    text: str
    speaker_audio: str
    prompt_audio: str
    prompt_text: str = ""
    speed: float = 1.0
    stream_chunk: int = 25
    boost_first_chunk: bool = True
    stream_mode: str = "token"


@asynccontextmanager
async def lifespan(_: FastAPI):
    global tts, models_dir_global
    logger.info("正在加载 TTS 模型...")
    tts = TTS(models_dir=models_dir_global, sovits_cache=[50])
    # 预热：加载默认 GPT/SoVITS 模型 + 示例音频缓存，避免首请求延迟
    default_gpt = str(models_dir_global / DEFAULT_GPT_CKPT)
    default_sovits = str(models_dir_global / DEFAULT_SOVITS_PTH)
    example_spk = str(models_dir_global.parent / "examples" / EXAMPLE_SPEAKER)
    example_prompt = str(models_dir_global.parent / "examples" / EXAMPLE_PROMPT)

    def _preload():
        if hasattr(tts, 'load_gpt_model') and os.path.exists(default_gpt):
            try:
                tts.load_gpt_model(default_gpt)
            except Exception as e:
                logger.warning(f"预加载 GPT 失败: {e}")
        if hasattr(tts, 'load_sovits_model') and os.path.exists(default_sovits):
            try:
                tts.load_sovits_model(default_sovits)
            except Exception as e:
                logger.warning(f"预加载 SoVITS 失败: {e}")
        if os.path.exists(example_spk):
            try:
                tts.cache_spk_audio(example_spk)
            except Exception as e:
                logger.warning(f"预缓存 speaker 失败: {e}")
        if os.path.exists(example_prompt):
            try:
                tts.cache_prompt_audio(example_prompt, "ちが……ちがう。レイア、貴様は間違っている。")
            except Exception as e:
                logger.warning(f"预缓存 prompt 失败: {e}")

    await asyncio.get_running_loop().run_in_executor(None, _preload)
    logger.info("TTS 模型加载完成（含预热）！")
    try:
        yield
    finally:
        logger.info("TTS 服务关闭")


app = FastAPI(title="DSH-GSV-TTS Stream API", lifespan=lifespan)

# 允许跨源访问（浏览器跨源播放/调试需要）
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def _transcribe_prompt(tts_obj, audio_path: str) -> Optional[str]:
    """对提示音频做 ASR 转写。能力探测：gsv_tts 可能以不同名字/签名暴露。

    返回转写文本；引擎不支持 ASR 时返回 None（由调用方给出明确错误）。
    """
    candidates = [
        getattr(tts_obj, "asr", None),
        getattr(tts_obj, "recognize", None),
        getattr(tts_obj, "transcribe", None),
    ]
    for fn in candidates:
        if not callable(fn):
            continue
        try:
            result = fn(audio_path)
            if isinstance(result, (list, tuple)) and result:
                result = result[0]
            if isinstance(result, dict):
                result = result.get("text") or result.get("transcript") or result.get("result")
            if isinstance(result, str) and result.strip():
                return result.strip()
        except Exception as e:
            logger.warning(f"ASR 尝试失败（{getattr(fn, '__name__', '?')}）: {e}")
    return None


@app.get("/")
async def root():
    return {"message": "DSH-GSV-TTS Stream API", "endpoints": {"/tts/stream": "POST 真流式 SSE"}}


@app.post("/tts/stream")
async def tts_stream(request: StreamRequest):
    """真流式 TTS：用 infer_stream_async 逐块 yield，首块到达即推送"""
    prompt_text = request.prompt_text
    if not prompt_text:
        # 留空时尝试 ASR 自动转写（能力探测）
        if tts is None:
            raise HTTPException(status_code=503, detail="TTS 模型未加载")
        try:
            prompt_text = await asyncio.to_thread(_transcribe_prompt, tts, request.prompt_audio)
        except Exception as e:
            logger.warning(f"ASR 调用异常: {e}")
            prompt_text = None
        if not prompt_text:
            raise HTTPException(
                status_code=400,
                detail="prompt_text 不能为空，且当前引擎不支持 ASR 自动转写（请在音色预设中填写 promptText）",
            )
        logger.info(f"ASR 转写结果: {prompt_text}")

    async def generate():
        try:
            total_samples = 0
            sample_rate = 32000
            chunk_count = 0
            prev_duration = 0.0
            chunk_idx = 0
            async for clip in tts.infer_stream_async(
                spk_audio_path=request.speaker_audio,
                prompt_audio_path=request.prompt_audio,
                prompt_audio_text=prompt_text,
                text=request.text,
                stream_mode=request.stream_mode,
                stream_chunk=request.stream_chunk,
                boost_first_chunk=request.boost_first_chunk,
                speed=request.speed,
                debug=False,
            ):
                audio_bytes = clip.audio_data.tobytes()
                audio_b64 = base64.b64encode(audio_bytes).decode('utf-8')
                sample_rate = int(clip.samplerate)
                # audio_len_s 是累计值（跨块累加），逐块差值才是本块时长
                cumulative = float(getattr(clip, "audio_len_s", 0.0) or 0.0)
                chunk_duration = max(cumulative - prev_duration, 0.0)
                prev_duration = cumulative
                total_samples += len(clip.audio_data)
                chunk_count += 1

                chunk_data = {
                    "audio": audio_b64,
                    "sample_rate": sample_rate,
                    "duration": round(chunk_duration, 4),
                    "chunk_idx": chunk_idx,
                }
                chunk_idx += 1
                yield f"event: audio\ndata: {json.dumps(chunk_data, ensure_ascii=False)}\n\n"

            if chunk_count == 0:
                yield f"event: error\ndata: {json.dumps({'error': '未收到任何音频块'}, ensure_ascii=False)}\n\n"
                return
            yield f"event: done\ndata: {json.dumps({'total_duration': round(total_samples / sample_rate, 3)}, ensure_ascii=False)}\n\n"

        except Exception as e:
            logger.error(f"流式推理错误: {e}")
            yield f"event: error\ndata: {json.dumps({'error': str(e)}, ensure_ascii=False)}\n\n"

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


if __name__ == "__main__":
    import argparse
    import uvicorn
    parser = argparse.ArgumentParser()
    parser.add_argument("--models_dir", type=str, default="models")
    parser.add_argument("-p", "--port", type=int, default=9880)
    args = parser.parse_args()
    models_dir_global = Path(args.models_dir)
    uvicorn.run(app, host="0.0.0.0", port=args.port)
