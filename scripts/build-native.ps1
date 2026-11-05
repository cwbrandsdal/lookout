$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$source = Join-Path $repo 'native\handoff'
$build = Join-Path $source 'build'
$bin = Join-Path $source 'bin'
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
if (!(Test-Path -LiteralPath $vswhere)) { throw 'Missing vswhere.exe. Install Visual Studio Build Tools with Desktop development with C++ and Windows SDK 10.0.26100 or newer.' }
$vs = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (!$vs) { throw 'No MSVC x64 toolchain found. Install the Visual Studio Desktop development with C++ workload.' }
$vcvars = Join-Path ($vs | Select-Object -First 1) 'VC\Auxiliary\Build\vcvars64.bat'
if (!(Test-Path -LiteralPath $vcvars)) { throw "Missing MSVC environment script: $vcvars" }
if (!(Get-Command cmake -ErrorAction SilentlyContinue)) { throw 'CMake is missing from PATH. Install CMake 3.20 or newer.' }
$conpty = Join-Path $repo 'node_modules\node-pty\third_party\conpty\1.23.251008001\win10-x64\conpty.dll'
if (!(Test-Path -LiteralPath $conpty)) { throw "Missing node-pty ConPTY runtime: $conpty. Install the repository dependencies first." }
New-Item -ItemType Directory -Force -Path $build,$bin | Out-Null
# Capture vcvars' environment without allowing paths to become command text.
$env:LOOKOUT_VCVARS = $vcvars
$env:Path = (Split-Path -Parent $vswhere) + ';' + $env:Path
try {
  $environment = & $env:ComSpec /d /s /c '""%LOOKOUT_VCVARS%" >nul && set"'
  if ($LASTEXITCODE -ne 0) { throw 'vcvars64.bat failed to initialize the MSVC environment.' }
  foreach ($line in $environment) {
    if ($line -match '^([^=]+)=(.*)$') { [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process') }
  }
} finally { Remove-Item Env:LOOKOUT_VCVARS -ErrorAction SilentlyContinue }
if (!(Get-Command midl.exe -ErrorAction SilentlyContinue)) { throw 'midl.exe is missing. Install Windows SDK 10.0.26100 or newer and its desktop C++ tools.' }
& cmake -S $source -B $build -G 'NMake Makefiles' -DCMAKE_BUILD_TYPE=Release
if ($LASTEXITCODE -ne 0) { throw 'Native handoff CMake configuration failed.' }
& cmake --build $build
if ($LASTEXITCODE -ne 0) { throw 'Native handoff compilation failed.' }
Copy-Item -LiteralPath $conpty -Destination (Join-Path $bin 'conpty.dll') -Force
Write-Host "Native handoff binaries: $bin"
