"""dsh-gsv-tts 真流式 API 服务

修复 personal_api.py /tts/stream 的假流式问题：
- 原实现用 list(tts.infer_stream(...)) 一次性消费完再逐块发——首包延迟≈总耗时
- 本端点用 infer_stream_async 逐块 yield，首块到达即推送
v2.1 变更：
- lifespan 替代已废弃的 @app.on_event("startup")
- prompt_text 为空时尝试 ASR 自动转写（能力探测，不可用时返回明确错误）
- done 事件 total_duration 按逐块采样数累加（真实秒数；注意 clip.audio_len_s 是跨块累计值，不能直接求和）
"""
import os
import json
import base64
import asyncio
import logging
import time
import hmac
from contextlib import aclosing, asynccontextmanager
from pathlib import Path
from typing import Optional

os.environ['GSV_DISABLE_CUDA_GRAPH'] = '1'

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
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
    return_subtitles: bool = False


class WarmupRequest(BaseModel):
    speaker_audio: str
    prompt_audio: str
    prompt_text: str = ""


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

    # 推理预热：初始化 CUDA kernel / 惰性模块，避免第一次真实请求多等几秒
    def _warm_infer():
        if os.path.exists(example_spk) and os.path.exists(example_prompt):
            try:
                tts.infer(
                    spk_audio_path=example_spk,
                    prompt_audio_path=example_prompt,
                    prompt_audio_text="ちが……ちがう。レイア、貴様は間違っている。",
                    text="你好。",
                )
                logger.info("推理预热完成")
            except Exception as e:
                logger.warning(f"推理预热失败: {e}")

    await asyncio.get_running_loop().run_in_executor(None, _warm_infer)
    logger.info("TTS 模型加载完成（含预热）！")
    try:
        yield
    finally:
        logger.info("TTS 服务关闭")


app = FastAPI(title="DSH-GSV-TTS Stream API", lifespan=lifespan)

engine_token = os.environ.get("DSH_GSV_ENGINE_TOKEN", "")


@app.middleware("http")
async def authorize(request: Request, call_next):
    if engine_token and not hmac.compare_digest(
        request.headers.get("authorization", "").encode(), f"Bearer {engine_token}".encode()
    ):
        return JSONResponse({"detail": "Unauthorized"}, status_code=401)
    if request.headers.get("origin"):
        return JSONResponse({"detail": "Browser origins are not accepted"}, status_code=403)
    return await call_next(request)


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


_ASR_CACHE: dict[str, str] = {}


def _transcribe_prompt_cached(tts_obj, audio_path: str) -> Optional[str]:
    """ASR 结果按（路径, mtime, size）缓存，避免同一提示音频每次请求都转写。"""
    try:
        st = os.stat(audio_path)
        key = f"{audio_path}:{st.st_mtime_ns}:{st.st_size}"
    except OSError:
        key = audio_path
    if key in _ASR_CACHE:
        return _ASR_CACHE[key]
    text = _transcribe_prompt(tts_obj, audio_path)
    if text:
        _ASR_CACHE[key] = text
    return text


@app.post("/warmup")
async def warmup(request: WarmupRequest):
    """预热指定音色：缓存 speaker/prompt 特征并跑一次极短推理。"""
    if tts is None:
        raise HTTPException(status_code=503, detail="TTS 模型未加载")
    if not request.prompt_text.strip():
        return {"ok": False, "message": "prompt_text 为空，跳过预热（避免触发 ASR）"}

    def _run():
        begin = time.perf_counter()
        tts.cache_spk_audio(request.speaker_audio)
        tts.cache_prompt_audio(request.prompt_audio, request.prompt_text)
        tts.infer(
            spk_audio_path=request.speaker_audio,
            prompt_audio_path=request.prompt_audio,
            prompt_audio_text=request.prompt_text,
            text="你好。",
        )
        return round((time.perf_counter() - begin) * 1000)

    ms = await asyncio.get_running_loop().run_in_executor(None, _run)
    logger.info(f"音色预热完成（{ms} ms）")
    return {"ok": True, "ms": ms}


@app.get("/")
async def root():
    return {"message": "DSH-GSV-TTS Stream API", "endpoints": {"/tts/stream": "POST 真流式 SSE", "/warmup": "POST 音色预热"}}


@app.post("/tts/stream")
async def tts_stream(request: StreamRequest):
    """真流式 TTS：用 infer_stream_async 逐块 yield，首块到达即推送"""
    prompt_text = request.prompt_text
    if not prompt_text:
        # 留空时尝试 ASR 自动转写（能力探测）
        if tts is None:
            raise HTTPException(status_code=503, detail="TTS 模型未加载")
        try:
            prompt_text = await asyncio.to_thread(_transcribe_prompt_cached, tts, request.prompt_audio)
        except Exception as e:
            logger.warning(f"ASR 调用异常: {e}")
            prompt_text = None
        if not prompt_text:
            raise HTTPException(
                status_code=400,
                detail="prompt_text 不能为空，且当前引擎不支持 ASR 自动转写（请在音色预设中填写 promptText）",
            )
        logger.info("已生成提示音频转写")

    async def generate():
        try:
            total_samples = 0
            sample_rate = 32000
            chunk_count = 0
            prev_duration = 0.0
            chunk_idx = 0
            clips = tts.infer_stream_async(
                spk_audio_path=request.speaker_audio,
                prompt_audio_path=request.prompt_audio,
                prompt_audio_text=prompt_text,
                text=request.text,
                stream_mode=request.stream_mode,
                stream_chunk=request.stream_chunk,
                boost_first_chunk=request.boost_first_chunk,
                speed=request.speed,
                return_subtitles=request.return_subtitles,
                debug=False,
            )
            async with aclosing(clips):
                async for clip in clips:
                    audio_bytes = clip.audio_data.tobytes()
                    audio_b64 = base64.b64encode(audio_bytes).decode('utf-8')
                    sample_rate = int(clip.samplerate)
                    # audio_len_s 是累计值，逐块差值才是本块时长。
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
                        "subtitles": [
                            {"text": cue["text"], "start_s": float(cue["start_s"]), "end_s": float(cue["end_s"])}
                            for cue in clip.subtitles if cue.get("end_s") is not None
                        ] if request.return_subtitles else [],
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
    models_dir_global = Path(args.models_dir).resolve()
    uvicorn.run(app, host="127.0.0.1", port=args.port)
