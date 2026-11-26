# 发布指南

本插件通过 npm 分发。发布前 `npm run verify` 会自动校验必须的元数据；CI 也会在每次 push 时跑类型检查与构建。

在源码目录运行 `pnpm test:release` 可从清理后的产物目录重新构建并打包。测试用真实 DSH 将 tarball 装到临时 Web profile，检查客户端脚本、音色设置、朗读及下载链路。默认临时安装 DSH `0.2.2-rc.1`，也可用 `DSH_GSV_TEST_HARNESS` 指定本机 DSH 的 `lib/bin.js`。浏览器脚本的源码位于 `client/`，构建时复制到 `lib/`。

### Windows release harness 的已知限制

临时 Web profile 里的 `/settings/voice` 会触发 DSH 的 config-editor profile 重载。DSH `0.2.2-rc.1` 在 Windows 上对这种隔离 `dsh web --patch` 启动方式会返回 `dsh: profile reload requires the root Include entry`（Linux 正常）。因此 `tests/harness.test.mjs` 在 Windows 上跳过依赖配置持久化的断言，只保留 `400` 校验；Linux 继续跑完整断言。构建、`verify` 与单元测试在 Windows 上仍然全量执行。

## 被插件市场发现所需的元数据

`package.json` 必须同时满足：

- `dsh.bundle.patch` 存在——这是 `dsh plugin add` 能否安装的判断依据（只声明 `dsh.client` 不能安装）。
- `keywords` 包含 `"dsh-plugin"`——基于 npm 的市场（dshbase 等）通过 `npm search dsh-plugin` 发现插件。
- `repository` / `license` / `homepage` / `bugs` 完整——部分爬虫用 `repository` 关联 npm 包与源码仓库。

## DSH 兼容性元数据

DSH 0.2 起，宿主在加载/安装插件前会读取插件清单里的 `engines.dsh`（存在时优先于 `peerDependencies` 里的 `@deepseek-ai/dsh*` 范围）判断兼容性；不满足时会禁用插件并提示升级。

- `engines.dsh` 必须覆盖当前 DSH 运行时版本（含 prerelease），例如 `^0.2.1-rc.2`。
- `peerDependencies` 里的 `@deepseek-ai/dsh-tools` 等宿主包范围要同步到同一大版本，避免安装出错版 SDK。
- 升级宿主大版本时（例如 0.2 → 0.3），先更新这两个字段并重新验证启动，再发布新大版本插件。

## 版本发布步骤

```sh
npm version minor            # 升版本号（会自动触发 verify）
git push origin master --tags
npm publish
```

发布后 npm 会把 `latest` 标签切到新版本，搜索索引在几分钟到几小时内刷新。
