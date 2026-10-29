# dsh-gsv 音色市场 · 投稿指南

> [中文](#中文) · [English](#english) · [返回音色市场](https://taoruiliu19.github.io/gsv-market/)

---

<a id="中文"></a>

## 中文

### 这是什么

[dsh-gsv 音色市场](https://taoruiliu19.github.io/gsv-market/) 是 DSH 插件 `dsh-gsv-tts` 的公开音色库：浏览、试听、一键安装社区分享的音色。它由所有愿意分享声音的人一起共建——**你上传的每一个音色，都会出现在网页和插件的音色市场里**。

### 为什么上传

- **让喜欢的声音被更多人用上**：试听、下载、一键安装，全流程免费。
- **作者署名**：音色卡片会公开展示作者姓名，好声音值得被记住。
- **一次上传，两处可用**：网页和插件共用同一份清单，不用重复提交。
- **完全开源**：清单、音频、审核流程都在公开仓库里，透明可查。

把你珍藏的、自己录的、拿到授权的好声音分享出来吧。

### 可以上传什么

✅ 欢迎：

- 你自己的声音（朗读、台词、配音片段等）
- 你获得**明确授权**可以分发的声音
- 无版权争议的素材（CC0、公共领域等）

🚫 请勿上传：

- 未获得授权的他人声音（包括明星、主播、亲友）
- 用于冒充、诈骗、虚假信息的声音
- 含侵权音乐、违法或不当内容的音频

上传即表示你确认拥有该声音的合法分发授权，并同意按所选许可公开展示与分发。

### 准备音频

| 项目 | 建议 |
|---|---|
| 时长 | **5–15 秒最佳**，最长 30 秒（上传页会自动截取前 30 秒） |
| 内容 | 单人说话，清晰、干净，**不要背景音乐**、不要混响和噪声 |
| 格式 | wav / mp3 / ogg / flac / m4a，≤15MB |
| 提示文本 | 填上音频里说的话，克隆效果通常更好（可留空） |

### 上传步骤

1. 打开 [上传页](https://taoruiliu19.github.io/gsv-market/upload.html)（需要 GitHub 账号）。
2. 选择或录制音频，页面会自动裁剪到 30 秒内并转成单声道 WAV。
3. 填写名称、**作者姓名**、许可协议、语言、标签和提示文本。
4. 勾选授权声明，点击“生成音色包并打开 GitHub”。
5. 把下载好的 `.gsvvoice` 文件拖进打开的 Issue 正文，提交即可。

### 审核与上架

1. 提交后自动校验：格式、时长、声道、采样率、体积、SHA-256 查重。
2. 通过后打上 `validated` 标签，评论里会显示名称、作者、许可、时长和音色 ID。
3. 维护者试听后添加 `approved` 标签。
4. 工作流自动转码、写入清单并部署， Issue 打上 `published` 并关闭。
5. GitHub Pages 部署完成后，网页和插件市场即可看到（通常几分钟内）。

审核通常需要 1–3 天，取决于维护者时间；节假日可能更久。

### 安装与使用

- **插件内**：设置 → 声音设置 → 音色市场 → 选择音色安装。
- **让 agent 安装**：复制音色卡片上的安装命令，例如
  `帮我安装音色 voice-xxxxxxxx（来自 dsh-gsv-tts 音色市场）`。
- **网页上**：可直接试听、下载音频，或复制安装命令。

### 常见问题

**为什么必须用 GitHub 账号？**
身份可追溯、方便审核与防滥用；投稿和审核记录都留在公开 Issue 里，透明可查。

**审核没通过怎么办？**
看 Issue 里的评论，按提示修改音频或信息，重新编辑 Issue 正文（重新拖入新的 `.gsvvoice`）即可自动重跑。

**可以下架自己的音色吗？**
可以。在 [gsv-market 仓库](https://github.com/TaoruiLiu19/gsv-market/issues) 提 Issue 申请下架，维护者会移除条目和音频。

**音质有什么要求？**
干净的人声比高码率更重要：安静环境、单人、无明显背景音乐和噪声，5–15 秒通常就够。

**可以上传多个吗？**
可以，每个音色单独提交一次，方便分别审核和署名。

### 相关链接

- [音色市场](https://taoruiliu19.github.io/gsv-market/)
- [上传音色](https://taoruiliu19.github.io/gsv-market/upload.html)
- [插件仓库](https://github.com/TaoruiLiu19/dsh-gsv)
- [市场仓库](https://github.com/TaoruiLiu19/gsv-market)

---

<a id="english"></a>

## English

### What this is

The [dsh-gsv Voice Market](https://taoruiliu19.github.io/gsv-market/) is the public voice library for the DSH plugin `dsh-gsv-tts`: browse, preview, and install community-shared voices in one click. It is built by everyone who is willing to share a voice — **every voice you upload appears in both the website and the plugin's voice market**.

### Why upload

- **Let a voice you love reach more people**: preview, download, and one-click install, all free.
- **Author credit**: the voice card shows the author's name publicly.
- **Upload once, use everywhere**: the website and the plugin share the same manifest.
- **Fully open source**: the manifest, audio, and review workflow all live in a public repository.

Share the voices you have recorded, collected, or been authorized to distribute.

### What you can upload

✅ Welcome:

- Your own voice (reading, lines, dubbing clips, etc.)
- Voices you have **explicit permission** to distribute
- Material with no copyright concerns (CC0, public domain, etc.)

🚫 Please do not upload:

- Voices of other people without permission (celebrities, streamers, friends, family)
- Voices used for impersonation, fraud, or disinformation
- Audio containing infringing music, illegal, or inappropriate content

By uploading, you confirm that you have the right to distribute the voice and agree to publish it under the selected license.

### Prepare your audio

| Item | Recommendation |
|---|---|
| Length | **5–15 seconds is ideal**, 30 seconds max (the upload page trims to the first 30s) |
| Content | Single speaker, clean and clear, **no background music**, no reverb or noise |
| Format | wav / mp3 / ogg / flac / m4a, ≤15MB |
| Prompt text | Transcribe what is said in the audio; it usually improves cloning (optional) |

### How to upload

1. Open the [upload page](https://taoruiliu19.github.io/gsv-market/upload.html) (a GitHub account is required).
2. Choose or record audio; the page trims it to 30 seconds and converts it to mono WAV.
3. Fill in the name, **author name**, license, language, tags, and prompt text.
4. Tick the consent box and click "Generate voice pack and open GitHub".
5. Drag the downloaded `.gsvvoice` file into the opened issue and submit.

### Review and publishing

1. Automatic validation: format, duration, channels, sample rate, size, and SHA-256 duplicate check.
2. On success the issue gets the `validated` label, with a comment listing name, author, license, duration, and voice ID.
3. A maintainer listens and adds the `approved` label.
4. The workflow transcodes the audio, updates the manifest, deploys, labels the issue `published`, and closes it.
5. Once GitHub Pages finishes deploying (usually within minutes), the voice appears on the website and in the plugin.

Review usually takes 1–3 days depending on maintainer availability.

### Install and use

- **In the plugin**: Settings → Voice Settings → Voice Market → install.
- **Ask the agent**: copy the install command from the voice card, for example
  `帮我安装音色 voice-xxxxxxxx（来自 dsh-gsv-tts 音色市场）`.
- **On the website**: preview, download the audio, or copy the install command.

### FAQ

**Why is a GitHub account required?**
It provides traceable identity, makes review and abuse prevention easier, and keeps the submission and review history public.

**What if validation fails?**
Read the comment on the issue, fix the audio or metadata, then edit the issue body and drag in the new `.gsvvoice`; validation reruns automatically.

**Can I remove my voice later?**
Yes. Open an issue in the [gsv-market repository](https://github.com/TaoruiLiu19/gsv-market/issues) requesting removal; a maintainer will remove the entry and audio.

**What audio quality do you need?**
Clean speech matters more than bitrate: quiet room, single speaker, no obvious music or noise. 5–15 seconds is usually enough.

**Can I upload several voices?**
Yes, submit each voice separately so they can be reviewed and credited individually.

### Links

- [Voice Market](https://taoruiliu19.github.io/gsv-market/)
- [Upload a voice](https://taoruiliu19.github.io/gsv-market/upload.html)
- [Plugin repository](https://github.com/TaoruiLiu19/dsh-gsv)
- [Market repository](https://github.com/TaoruiLiu19/gsv-market)
