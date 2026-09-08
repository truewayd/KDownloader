param()

$ErrorActionPreference = "Stop"
$generator = Join-Path $PSScriptRoot "../tools/generate-icons.mjs"
& node $generator
if ($LASTEXITCODE -ne 0) {
  throw "Icon generation failed. Run npm ci in truedown/desktop to install the pinned build tools."
}
