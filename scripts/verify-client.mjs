/**
 * Post-build gate for lib/client.js: static shape checks (ModuleLoader banner,
 * plugin id, CJS-only body, externalized shell modules) plus a sandboxed
 * dry-run of the factory so a broken wrapper fails `npm run build` instead of
 * the DSH web shell. Exits non-zero on any miss.
 */

import { readFile, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outFile = join(root, 'lib/client.js')
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const bundle = await readFile(outFile, 'utf8')
const size = (await stat(outFile)).size
const firstLine = bundle.split('\n', 1)[0]
const expectedId = pkg.name

const failures = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}

// --- static shape ---------------------------------------------------------
check('first line is the ModuleLoader banner', firstLine === 'window.__ModuleLoader__.load({', firstLine)
check('loader id is the package name', new RegExp(`^  id: "${expectedId}",$`, 'm').test(bundle), `expected ${expectedId}`)
check('factory signature present', /^  factory: \(require\) => \{$/m.test(bundle))
check('factory returns module.exports', /^    return module\.exports;$/m.test(bundle))
check('no ESM import statements', !/^import[\s{]/m.test(bundle))
check('no ESM export statements', !/^export[\s{]/m.test(bundle))
check('no inline source map', !/sourceMappingURL=/.test(bundle))
check('bundle is non-trivial', size > 20_000, `${String(size)} bytes`)

// --- externals ------------------------------------------------------------
const ALLOWED = [
  /^react$/,
  /^react\/jsx-runtime$/,
  /^react\/jsx-dev-runtime$/,
  /^react-dom$/,
  /^react-dom\/client$/,
  /^react-dom\/server$/,
  /^@deepseek-ai\//,
]
const requires = [...bundle.matchAll(/\brequire\("([^"]+)"\)/g)].map(match => match[1])
const unique = [...new Set(requires)]
const notExternal = unique.filter(spec => !ALLOWED.some(pattern => pattern.test(spec)))
check('every require() comes from the shell module table', notExternal.length === 0, notExternal.join(', '))
check('react is externalized', unique.includes('react'))
check('react/jsx-runtime is externalized', unique.includes('react/jsx-runtime'))
check('no Harness client package is required', unique.every(spec => !spec.startsWith('@deepseek-ai/')), unique.join(', '))
check('no bundled react copy', !/react-dom\.production\.min|react\.production\.min/.test(bundle))

// --- sandboxed factory run ------------------------------------------------
const loaderRequire = createRequire(join(root, 'lib/index.js'))
let loaded
const sandbox = {
  window: {
    __ModuleLoader__: {
      load(options) {
        loaded = { id: options.id, exports: options.factory(loaderRequire) }
      },
    },
  },
  console,
}
try {
  vm.runInNewContext(bundle, sandbox, { filename: outFile })
  check('factory executes in a bare sandbox', loaded !== undefined)
} catch (error) {
  check('factory executes in a bare sandbox', false, String(error))
}
if (loaded !== undefined) {
  const exported = loaded.exports
  check('loaded id matches the package name', loaded.id === expectedId, loaded.id)
  check('exports apply()', typeof exported.apply === 'function')
  check('exports inject list', Array.isArray(exported.inject) && exported.inject.includes('slots'), JSON.stringify(exported.inject))
  check('exports stable name', exported.name === expectedId, String(exported.name))
}

if (failures.length > 0) {
  console.error(`\nclient bundle verification FAILED — ${String(failures.length)} check(s): ${failures.join(', ')}`)
  process.exit(1)
}
console.log('\nclient bundle OK')
