import { readFile } from 'node:fs/promises'

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const installedVersion = packageJson.dependencies.openmoji

try {
  const response = await fetch('https://registry.npmjs.org/openmoji/latest', {
    signal: AbortSignal.timeout(5000),
  })
  if (!response.ok) throw new Error(`registry returned HTTP ${response.status}`)

  const { version: latestVersion } = await response.json()
  if (latestVersion === installedVersion) {
    console.log(`OpenMoji ${installedVersion} is current.`)
  } else {
    console.warn(`OpenMoji update available: ${installedVersion} -> ${latestVersion}. Review and update the pinned dependency deliberately.`)
  }
} catch (error) {
  console.warn(`OpenMoji version check skipped: ${error instanceof Error ? error.message : String(error)}`)
}
