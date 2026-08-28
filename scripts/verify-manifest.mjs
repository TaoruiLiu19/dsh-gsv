import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))

const failures = []
if (!pkg.dsh?.bundle?.patch) failures.push('dsh.bundle.patch is missing — plugin is not installable via dsh plugin add')
if (!Array.isArray(pkg.keywords) || !pkg.keywords.includes('dsh-plugin')) failures.push('keywords must include "dsh-plugin" for marketplace discovery')
if (!pkg.repository?.url) failures.push('repository.url is missing')
if (!pkg.license) failures.push('license is missing')

if (failures.length) {
  console.error(`[verify-manifest] ${failures.length} issue(s):`)
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log(`[verify-manifest] OK: ${pkg.name}@${pkg.version} is publish-ready`)