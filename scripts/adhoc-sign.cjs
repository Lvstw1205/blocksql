// Ad-hoc sign the mac app. There is no Developer ID, and a personal certificate in the keychain
// (possibly revoked) must never end up in a build: macOS refuses to launch an app signed with one.
const { execFileSync } = require('node:child_process')
const path = require('node:path')

exports.default = async function (context) {
  if (context.electronPlatformName !== 'darwin') return
  // The per-arch halves of a universal build must stay identical until they are merged.
  if (context.appOutDir.endsWith('-temp')) return
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' })
}
