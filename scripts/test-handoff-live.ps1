[CmdletBinding()]
param(
  [string]$NativeDir = (Join-Path (Split-Path -Parent $PSScriptRoot) 'native\handoff\bin'),
  [int]$TimeoutSeconds = 40
)
# Opt-in only: this script temporarily changes default-terminal delegation.
# Do not run it without the owner's explicit consent.
$ErrorActionPreference = 'Stop'
if ([IntPtr]::Size -ne 8) { throw 'Run this script in 64-bit PowerShell.' }
$helper = Join-Path $NativeDir 'LookoutHandoff.exe'
$proxy = Join-Path $NativeDir 'LookoutHandoffProxy.dll'
foreach ($file in @($helper, $proxy, (Join-Path $NativeDir 'conpty.dll'))) {
  if (!(Test-Path -LiteralPath $file -PathType Leaf)) { throw "Missing native runtime: $file. Run npm run build:native first." }
}
$node = (Get-Command node.exe -ErrorAction Stop).Source
$package = Get-AppxPackage Microsoft.WindowsTerminal | Where-Object { !$_.IsResourcePackage } | Select-Object -First 1
if (!$package) { throw 'Windows Terminal stable is required.' }
[xml]$manifest = Get-Content -LiteralPath (Join-Path $package.InstallLocation 'AppxManifest.xml')
$console = $manifest.SelectSingleNode("//*[local-name()='AppExtension' and @Name='com.microsoft.windows.console.host']//*[local-name()='Clsid']")
$interface = $manifest.SelectSingleNode("//*[local-name()='Interface' and @Id='6F23DA90-15C5-4203-9DB0-64E73F1B1B00']")
if (!$console -or !$interface) { throw 'Update Windows Terminal: ITerminalHandoff3 is required.' }
$id = '{' + [guid]::NewGuid().ToString().ToUpperInvariant() + '}'
$proxyId = '{E1C44C58-2D96-4A52-988B-D3017E3BC7C5}'
$terminalKey = 'Software\Classes\CLSID\' + $id
$proxyKey = 'Software\Classes\CLSID\' + $proxyId
$proxyExisting = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($proxyKey + '\InprocServer32')
$proxyRoot = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($proxyKey)
$createProxy = $null -eq $proxyRoot
if ($proxyRoot) { $proxyRoot.Dispose() }
if (!$createProxy -and (!$proxyExisting -or $proxyExisting.GetValue('') -ne $proxy)) {
  if ($proxyExisting) { $proxyExisting.Dispose() }
  throw 'The Lookout proxy CLSID is already registered to another path. This test will not overwrite it.'
}
if ($proxyExisting) { $proxyExisting.Dispose() }
$runDir = Join-Path ([IO.Path]::GetTempPath()) ('lookout-handoff-live-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $runDir | Out-Null
$pipeName = '\\.\pipe\lookout-live-' + [guid]::NewGuid().ToString('N')
$startup = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Console\%%Startup')
$original = @{
  StartupExisted = $null -ne $startup
  TerminalKey = $terminalKey
  ProxyKey = $proxyKey
  RemoveProxy = $createProxy
  Values = @()
}
foreach ($name in @('DelegationConsole', 'DelegationTerminal')) {
  $exists = $startup -and ($startup.GetValueNames() -contains $name)
  $original.Values += @{
    Name = $name; Exists = [bool]$exists
    Kind = $(if ($exists) { $startup.GetValueKind($name).ToString() } else { 'String' })
    Value = $(if ($exists) { $startup.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) } else { $null })
  }
}
if ($startup) { $startup.Dispose() }
$backupPath = Join-Path $runDir 'backup.clixml'
$original | Export-Clixml -LiteralPath $backupPath
$recoveryPath = Join-Path $runDir 'recover.ps1'
@'
param([Parameter(Mandatory=$true)][string]$BackupPath)
$ErrorActionPreference = 'Stop'
$backup = Import-Clixml -LiteralPath $BackupPath
$root = [Microsoft.Win32.Registry]::CurrentUser
$key = $root.CreateSubKey('Console\%%Startup')
try {
  foreach ($entry in $backup.Values) {
    if ($entry.Exists) { $key.SetValue($entry.Name, $entry.Value, [Microsoft.Win32.RegistryValueKind]::$($entry.Kind)) }
    else { $key.DeleteValue($entry.Name, $false) }
  }
  $empty = $key.ValueCount -eq 0 -and $key.SubKeyCount -eq 0
} finally { $key.Dispose() }
if (!$backup.StartupExisted -and $empty) { $root.DeleteSubKey('Console\%%Startup', $false) }
$root.DeleteSubKeyTree($backup.TerminalKey, $false)
if ($backup.RemoveProxy) { $root.DeleteSubKeyTree($backup.ProxyKey, $false) }
Write-Host 'Restored original default-terminal values and removed temporary registrations.'
'@ | Set-Content -LiteralPath $recoveryPath -Encoding UTF8
Write-Host 'Recovery command (also works if this test is interrupted):'
Write-Host "powershell -NoProfile -ExecutionPolicy Bypass -File `"$recoveryPath`" -BackupPath `"$backupPath`""
$receiverPath = Join-Path $runDir 'receiver.cjs'
$readyPath = Join-Path $runDir 'ready'
$resultPath = Join-Path $runDir 'result.json'
@'
const net = require('node:net');
const fs = require('node:fs');
const { StringDecoder } = require('node:string_decoder');
const [pipe, readyPath, resultPath] = process.argv.slice(2);
const frame = (type, payload = Buffer.alloc(0)) => {
  const result = Buffer.alloc(5 + payload.length);
  result.writeUInt32LE(payload.length + 1); result[4] = type; payload.copy(result, 5); return result;
};
const sockets = new Set();
const server = net.createServer(socket => {
  sockets.add(socket);
  let pending = Buffer.alloc(0), hello, output = '', found = false, answered = 0;
  const decoder = new StringDecoder('utf8');
  socket.on('error', error => console.error(error.message));
  socket.on('close', () => sockets.delete(socket));
  socket.on('data', chunk => {
    try {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 4) {
        const size = pending.readUInt32LE(0);
        if (!size || size > 1048576) throw new Error('Invalid frame');
        if (pending.length < size + 4) break;
        const type = pending[4], payload = pending.subarray(5, size + 4);
        pending = pending.subarray(size + 4);
        fs.appendFileSync(resultPath + '.trace', `frame type=${type} bytes=${payload.length}\n`);
        if (type === 1 && !hello) {
          hello = JSON.parse(payload.toString('utf8'));
          if (hello.version !== 1) throw new Error('Invalid protocol version');
          socket.write(frame(6));
        } else if (type === 2 && hello) {
          output += decoder.write(payload);
          fs.appendFileSync(resultPath + '.trace', JSON.stringify(payload.toString('utf8')) + '\n');
          // OpenConsole waits for a real terminal's answers before printing anything:
          // primary device attributes (DA1) and cursor position (DSR), like xterm.js answers them in Lookout.
          const queries = (output.match(/\x1b\[0?c|\x1b\[6n/g) || []);
          for (const query of queries.slice(answered)) {
            socket.write(frame(2, Buffer.from(query.endsWith('n') ? '\x1b[1;1R' : '\x1b[?1;2c')));
          }
          answered = queries.length;
          if (!found && output.includes('LOOKOUT_HANDOFF_OK')) {
            found = true;
            fs.writeFileSync(resultPath, JSON.stringify({ hello, output }));
            socket.write(frame(2, Buffer.from('exit\r')));
          }
        } else if (type === 5) {
          socket.end();
        } else throw new Error('Unexpected frame');
      }
    } catch (error) { console.error(error.message); socket.destroy(); }
  });
});
server.on('error', error => { console.error(error.message); process.exitCode = 1; });
server.listen(pipe, () => fs.writeFileSync(readyPath, 'ready'));
setTimeout(() => { for (const socket of sockets) socket.end(frame(4)); server.close(); }, 55000).unref();
'@ | Set-Content -LiteralPath $receiverPath -Encoding UTF8
$receiver = $null
$launcher = $null
try {
  $receiver = Start-Process -FilePath $node -ArgumentList @("`"$receiverPath`"", "`"$pipeName`"", "`"$readyPath`"", "`"$resultPath`"") -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runDir 'stdout.log') -RedirectStandardError (Join-Path $runDir 'stderr.log')
  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  while (!(Test-Path -LiteralPath $readyPath)) {
    if ($receiver.HasExited -or [DateTime]::UtcNow -gt $deadline) { throw "Receiver failed to start. See $runDir" }
    Start-Sleep -Milliseconds 50
  }
  $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($terminalKey + '\LocalServer32')
  try { $key.SetValue('', "`"$helper`" -Embedding --clsid $id --pipe $pipeName") } finally { $key.Dispose() }
  if ($createProxy) {
    $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($proxyKey + '\InprocServer32')
    try { $key.SetValue('', $proxy); $key.SetValue('ThreadingModel', 'Both') } finally { $key.Dispose() }
  }
  $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Console\%%Startup')
  try { $key.SetValue('DelegationConsole', $console.InnerText); $key.SetValue('DelegationTerminal', $id) } finally { $key.Dispose() }
  $launcher = Start-Process -FilePath $env:ComSpec -ArgumentList '/d /c start "" /wait cmd.exe /d /k echo LOOKOUT_HANDOFF_OK' -WindowStyle Hidden -PassThru
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  while (!(Test-Path -LiteralPath $resultPath)) {
    if ($receiver.HasExited -or [DateTime]::UtcNow -gt $deadline) { throw "No handoff echo received. See $runDir" }
    Start-Sleep -Milliseconds 100
  }
  $result = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
  if ($result.output -notmatch 'LOOKOUT_HANDOFF_OK') { throw 'Missing echo marker.' }
  Write-Host "PASS: received console PID $($result.hello.pid) and LOOKOUT_HANDOFF_OK through COM handoff."
  if ($launcher) { [void]$launcher.WaitForExit(5000) }
} finally {
  try { & $recoveryPath -BackupPath $backupPath }
  finally {
    if ($receiver -and !$receiver.HasExited) { Stop-Process -Id $receiver.Id -Force -ErrorAction SilentlyContinue }
    if ($launcher -and !$launcher.HasExited) {
      Get-CimInstance Win32_Process -Filter "ParentProcessId = $($launcher.Id)" -ErrorAction SilentlyContinue |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
      Stop-Process -Id $launcher.Id -Force -ErrorAction SilentlyContinue
    }
  }
}
