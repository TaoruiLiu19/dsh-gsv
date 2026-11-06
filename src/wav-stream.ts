/**
 * 浏览器可直接播放的流式 WAV（未知长度）工具。
 *
 * 引擎输出 float32 PCM，浏览器 <audio> 需要 16-bit PCM WAV。
 * 由于总长度在开播时未知，RIFF/data 长度写 0xFFFFFFFF；Chromium 会边下边播
 * （已用无头 Edge 验证），播放结束后以服务端关闭连接为准。
 */

export function wavHeader(sampleRate: number, channels = 1, bits = 16): Buffer {
  const blockAlign = (channels * bits) / 8;
  const byteRate = sampleRate * blockAlign;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(0xffffffff, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bits, 34);
  header.write('data', 36);
  header.writeUInt32LE(0xffffffff, 40);
  return header;
}

/** 小端 float32 PCM → 16-bit PCM（带限幅）。 */
export function float32ToInt16(data: Buffer): Buffer {
  const frames = Math.floor(data.length / 4);
  const out = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) {
    const sample = Math.max(-1, Math.min(1, data.readFloatLE(i * 4)));
    out.writeInt16LE(Math.round(sample < 0 ? sample * 0x8000 : sample * 0x7fff), i * 2);
  }
  return out;
}
