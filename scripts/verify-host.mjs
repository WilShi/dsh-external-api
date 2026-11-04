/**
 * Release gate for the compiled Host entry: import lib/index.js the way the DSH
 * Loader does and assert the plugin surface the 0.2.1 runtime consumes.
 */

const mod = await import('../lib/index.js')
const failures = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}

check('module imports under node ESM', true)
check('exports a stable name', mod.name === 'dsh-external-api', String(mod.name))
check('exports apply()', typeof mod.apply === 'function')
check('apply(ctx, config) signature', mod.apply.length >= 1, String(mod.apply.length))
check('apply is async', mod.apply.constructor.name === 'AsyncFunction', mod.apply.constructor.name)
check('inject is a service list', Array.isArray(mod.inject), JSON.stringify(mod.inject))
check('inject does not require the removed settings service', !mod.inject.includes('settings'))
check('exports the Config schema', typeof mod.Config === 'function')
check('default export mirrors the plugin object', typeof mod.default?.apply === 'function')

const hostImports = ['@deepseek-ai/dsh-atomic-write', '@deepseek-ai/schemastery']
for (const name of hostImports) {
  try {
    await import(name)
    check(`host peer resolvable: ${name}`, true)
  } catch (error) {
    check(`host peer resolvable: ${name}`, false, String(error))
  }
}

if (failures.length > 0) {
  console.error(`\nhost entry verification FAILED — ${String(failures.length)} check(s): ${failures.join(', ')}`)
  process.exit(1)
}
console.log('\nhost entry OK')
