# 发布指南

本插件通过 npm 分发。发布前 `npm run verify` 会自动校验必须的元数据；CI 也会在每次 push 时跑类型检查与构建。

## 被插件市场发现所需的元数据

`package.json` 必须同时满足：

- `dsh.bundle.patch` 存在——这是 `dsh plugin add` 能否安装的判断依据（只声明 `dsh.client` 不能安装）。
- `keywords` 包含 `"dsh-plugin"`——基于 npm 的市场（dshbase 等）通过 `npm search dsh-plugin` 发现插件。
- `repository` / `license` / `homepage` / `bugs` 完整——部分爬虫用 `repository` 关联 npm 包与源码仓库。

## 版本发布步骤

```sh
npm version minor            # 升版本号（会自动触发 verify）
git push origin master --tags
npm publish
```

发布后 npm 会把 `latest` 标签切到新版本，搜索索引在几分钟到几小时内刷新。