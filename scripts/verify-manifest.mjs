import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))

const failures = []
if (!pkg.dsh?.bundle?.patch) failures.push('dsh.bundle.patch is missing — plugin is not installable via dsh plugin add')
if (!Array.isArray(pkg.keywords) || !pkg.keywords.includes('dsh-plugin')) failures.push('keywords must include "dsh-plugin" for marketplace discovery')
if (!pkg.repository?.url) failures.push('repository.url is missing')
if (!pkg.license) failures.push('license is missing')

// DSH 兼容性：宿主优先用 engines.dsh 判定，缺失会被当作无要求或直接禁用。
if (typeof pkg.engines?.dsh !== 'string' || pkg.engines.dsh.trim() === '') {
  failures.push('engines.dsh is missing — the host cannot verify this plugin against the running DSH version')
}
const dshTools = pkg.peerDependencies?.['@deepseek-ai/dsh-tools']
if (typeof dshTools !== 'string' || !/^\^?0\.2\./.test(dshTools)) {
  failures.push(`peerDependencies["@deepseek-ai/dsh-tools"] must target the DSH 0.2 line (found ${JSON.stringify(dshTools)})`)
}

// 客户端 bundle 契约：platform=web、入口存在、inject 只列已存在的宿主包。
if (pkg.dsh?.client?.platform !== 'web') failures.push('dsh.client.platform must be "web"')
if (!Array.isArray(pkg.dsh?.client?.inject) || pkg.dsh.client.inject.length === 0) {
  failures.push('dsh.client.inject is missing — the client bundle would load before its services')
}
if (Array.isArray(pkg.dsh?.client?.inject) && pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-runtime')) {
  failures.push('dsh.client.inject still references the removed @deepseek-ai/dsh-client-runtime package')
}
if (!existsSync(resolve(root, 'lib/client.js'))) failures.push('lib/client.js is missing — client bundle must be committed')

if (failures.length) {
  console.error(`[verify-manifest] ${failures.length} issue(s):`)
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log(`[verify-manifest] OK: ${pkg.name}@${pkg.version} is publish-ready`)
