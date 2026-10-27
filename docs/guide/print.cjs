// Electron entry used by build.mjs: prints an HTML file to PDF.
const { app, BrowserWindow } = require('electron')
const { writeFileSync } = require('node:fs')

const [html, pdf] = process.argv.slice(-2)
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false })
  await win.loadFile(html)
  const data = await win.webContents.printToPDF({
    printBackground: true,
    preferCSSPageSize: true,
    displayHeaderFooter: true,
    headerTemplate: '<div></div>',
    footerTemplate:
      '<div style="width:100%;font-size:8px;color:#9a9aa3;text-align:center;font-family:\'Apple SD Gothic Neo\',\'Malgun Gothic\',sans-serif">' +
      'BlockSQL · SQL 입문부터 실무까지 · <span class="pageNumber"></span> / <span class="totalPages"></span></div>'
  })
  writeFileSync(pdf, data)
  app.quit()
})
