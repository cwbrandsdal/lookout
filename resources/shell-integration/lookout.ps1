# Adapted from VS Code shellIntegration.ps1 (Microsoft Corporation, MIT license).
# https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/terminal/common/scripts/shellIntegration.ps1
# Keep this compatible with Windows PowerShell 5.1, including its built-in PSReadLine.
try {
  if (Test-Path variable:global:__LookoutState) { return }
  if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { return }

  $global:__LookoutState = @{
    OriginalPrompt = $function:prompt
    OriginalReadLine = $null
    Nonce = $env:LOOKOUT_NONCE
    PromptSeen = $false
    Executing = $false
    Startup = $false
    StartupFailed = $false
    StartupNativeCode = $null
    LastHistoryId = -1
  }
  $env:LOOKOUT_NONCE = $null

  function global:__LookoutEscape([string]$Value) {
    try {
      [regex]::Replace($Value, '[\x00-\x1f;\\]', {
        param($Match)
        if ($Match.Value -eq '\') { return '\\' }
        return ('\x{0:x2}' -f [int][char]$Match.Value)
      })
    } catch { return '' }
  }

  function global:__LookoutPreExec([string]$CommandLine) {
    try {
      $global:__LookoutState.Executing = -not [string]::IsNullOrWhiteSpace($CommandLine)
      if ($global:__LookoutState.Executing) {
        [Console]::Write("$([char]27)]633;E;$(__LookoutEscape $CommandLine);$($global:__LookoutState.Nonce)`a$([char]27)]633;C`a")
      }
    } catch {}
  }

  function global:prompt {
    # Capture status before calling anything (including Set-StrictMode/Get-History).
    $failed = -not $global:?
    try {
      Set-StrictMode -Off
      $nativeCode = $global:LASTEXITCODE
      $state = $global:__LookoutState
      if ($state.Startup) {
        $failed = $state.StartupFailed
        $nativeCode = $state.StartupNativeCode
      }
      $history = Get-History -Count 1 -ErrorAction SilentlyContinue
      $historyId = if ($null -eq $history) { -1 } else { $history.Id }
      $prefix = ''
      if ($state.PromptSeen) {
        if ($state.Executing -and ($state.Startup -or $historyId -ne $state.LastHistoryId)) {
          $code = [int]$failed
          # Like VS Code, use $? for PowerShell commands and the native exit code
          # on failure. A successful cmdlet must not inherit a stale LASTEXITCODE.
          if ($failed -and $null -ne $nativeCode -and $nativeCode -ne 0) { $code = $nativeCode }
          $prefix += "$([char]27)]633;D;$code`a"
        } else {
          $prefix += "$([char]27)]633;D`a"
        }
      }
      $prefix += "$([char]27)]633;A`a"
      if ($pwd.Provider.Name -eq 'FileSystem') {
        $prefix += "$([char]27)]633;P;Cwd=$(__LookoutEscape $pwd.ProviderPath)`a"
      }
      $state.PromptSeen = $true
      $state.Executing = $false
      $state.Startup = $false
      $state.LastHistoryId = $historyId
      # Write before invoking the original prompt: themes may use Write-Host directly.
      [Console]::Write($prefix)
      if ($failed) { Write-Error 'failure' -ErrorAction Ignore }
      $original = $state.OriginalPrompt.Invoke()
      return "$($original -join '')$([char]27)]633;B`a"
    } catch {
      # Integration must not break input or leak errors if a prompt/theme fails.
      return "$([char]27)]633;B`a"
    }
  }

  if (-not (Get-Module PSReadLine)) {
    Import-Module PSReadLine -ErrorAction SilentlyContinue
  }
  if (Get-Module PSReadLine) {
    $global:__LookoutState.OriginalReadLine = $function:PSConsoleHostReadLine
    function global:PSConsoleHostReadLine {
      try {
        $line = $global:__LookoutState.OriginalReadLine.Invoke()
        __LookoutPreExec ($line -join "`n")
        return $line
      } catch { return '' }
    }
  }
} catch {
  # Loading the integration is best effort, including restrictive host policies.
}

if ($env:LOOKOUT_STARTUP_COMMAND) {
  $lookoutStartup = $env:LOOKOUT_STARTUP_COMMAND
  $env:LOOKOUT_STARTUP_COMMAND = $null
  try {
    # Execute on this shell's console, with no redirected streams or delayed typing.
    [Console]::Write((prompt))
    __LookoutPreExec $lookoutStartup
    $global:__LookoutState.Startup = $true
    # Capture inside the block: invoking a block can reset $? even when its
    # final native command failed (especially in Windows PowerShell 5.1).
    $lookoutCapture = "`n" + '$global:__LookoutState.StartupFailed = -not $?' + "`n" + '$global:__LookoutState.StartupNativeCode = Get-Variable LASTEXITCODE -Scope Global -ValueOnly -ErrorAction SilentlyContinue'
    . ([scriptblock]::Create($lookoutStartup + $lookoutCapture))
  } catch {
    $global:__LookoutState.StartupFailed = $true
    $global:__LookoutState.StartupNativeCode = Get-Variable LASTEXITCODE -Scope Global -ValueOnly -ErrorAction SilentlyContinue
  }
  Remove-Variable lookoutStartup -ErrorAction SilentlyContinue
  Remove-Variable lookoutCapture -ErrorAction SilentlyContinue
}
