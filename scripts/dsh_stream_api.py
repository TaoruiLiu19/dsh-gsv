"""dsh-gsv-tts 真流式 API 服务

修复 personal_api.py /tts/stream 的假流式问题：
- 原实现用 list(tts.infer_stream(...)) 一次性消费完再逐块发——首包延迟≈总耗时
- 本端点用 infer_stream_async 逐块 yield，首块到达即推送

路径由 dsh_start_wrapper.py（setup.ts 生成）通过 sys.path 注入，
本文件不硬编码任何路径。
"""
import os
import sys
import json
import base64
import logging

os.environ['GSV_DISABLE_CUDA_GRAPH'] = '1'

from pathlib import Path
from typing import Optional
from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from gsv_tts import TTS

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("dsh_stream_api")

app = FastAPI(title="DSH-GSV-TTS Stream API")

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


@app.on_event("startup")
async def startup():
    global tts, models_dir_global
    logger.info("正在加载 TTS 模型...")
    tts = TTS(
        models_dir=models_dir_global,
        sovits_cache=[50],
    )
    # 预热：加载默认 GPT/SoVITS 模型，避免首请求延迟
    import asyncio
    loop = asyncio.get_running_loop()
    default_gpt = str(models_dir_global / "s1v3.ckpt")
    default_sovits = str(models_dir_global / "s2Gv2ProPlus.pth")
    example_spk = str(models_dir_global.parent / "examples" / "laffey.mp3")
    example_prompt = str(models_dir_global.parent / "examples" / "AnAn.ogg")
    def _preload():
        if hasattr(tts, 'load_gpt_model') and os.path.exists(default_gpt):
            try: tts.load_gpt_model(default_gpt)
            except Exception as e: logger.warning(f"预加载 GPT 失败: {e}")
        if hasattr(tts, 'load_sovits_model') and os.path.exists(default_sovits):
            try: tts.load_sovits_model(default_sovits)
            except Exception as e: logger.warning(f"预加载 SoVITS 失败: {e}")
        if os.path.exists(example_spk):
            try: tts.cache_spk_audio(example_spk)
            except Exception as e: logger.warning(f"预缓存 speaker 失败: {e}")
        if os.path.exists(example_prompt):
            try: tts.cache_prompt_audio(example_prompt, "ちが……ちがう。レイア、貴様は間違っている。")
            except Exception as e: logger.warning(f"预缓存 prompt 失败: {e}")
    await loop.run_in_executor(None, _preload)
    logger.info("TTS 模型加载完成（含预热）！")


@app.get("/")
async def root():
    return {"message": "DSH-GSV-TTS Stream API", "endpoints": {"/tts/stream": "POST 真流式 SSE"}}


@app.post("/tts/stream")
async def tts_stream(request: StreamRequest):
    """真流式 TTS：用 infer_stream_async 逐块 yield，首块到达即推送"""
    prompt_text = request.prompt_text
    if not prompt_text:
        raise HTTPException(status_code=400, detail="prompt_text 不能为空")

    async def generate():
        try:
            total_len = 0
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
                total_len += len(clip.audio_data)

                chunk_data = {
                    "audio": audio_b64,
                    "sample_rate": clip.samplerate,
                    "duration": clip.audio_len_s,
                    "chunk_idx": chunk_idx,
                }
                chunk_idx += 1
                yield f"event: audio\ndata: {json.dumps(chunk_data, ensure_ascii=False)}\n\n"

            yield f"event: done\ndata: {json.dumps({'total_duration': total_len / 32000}, ensure_ascii=False)}\n\n"

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
