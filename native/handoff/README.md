# Windows default-terminal handoff

Lookout's unpackaged x64 COM local server implements the current
`ITerminalHandoff3` ABI. The helper creates a duplex VT pipe, returns two
console-side handles, duplicates every incoming handle retained after RPC,
and packs the duplicates with node-pty's `ConptyPackPseudoConsole`. The bundled
ConPTY DLL supplies matching pack/resize/release/close functions. Input and
output stay in the helper; no native Node addon is required.

## Console host and registration

Use **the installed stable Windows Terminal package's OpenConsole**, discovered
from its manifest. The package on the development machine is 1.24.12741.0 and
advertises `ITerminalHandoff3`, console CLSID
`{2EACA947-7F5F-4CFA-BA87-8F7FBEEFBE69}` and its own OpenConsoleProxy. Its COM
activation, proxy and servicing already work together. The node-pty OpenConsole
is a ConPTY runtime artifact, not a separately installed delegation COM server;
registering it under Microsoft's build-dependent CLSID would shadow other
installations. We use only node-pty's matching **conpty.dll**, without registering
or shipping its OpenConsole as a delegation target.

Lookout writes these per-user keys:

| Key | Values |
| --- | --- |
| `HKCU\Software\Classes\CLSID\{783ED3D2-4BC6-48B9-B30C-F13AE92A7AB9}\LocalServer32` | default: quoted helper path, `-Embedding` |
| `HKCU\Software\Classes\CLSID\{E1C44C58-2D96-4A52-988B-D3017E3BC7C5}\InprocServer32` | default: proxy DLL path; `ThreadingModel=Both` |
| `HKCU\Software\Lookout\Handoff` | `ExePath`, `LaunchArguments`, `PipeName` |
| `HKCU\Console\%%Startup` | `DelegationConsole`: installed package's console CLSID; `DelegationTerminal`: Lookout's helper CLSID |

The helper calls `CoRegisterPSClsid` for its process. The packaged OpenConsole
uses its manifest's proxy. **No global `Interface` mapping or Microsoft CLSID
is written, deleted or replaced.** The synthetic COM client similarly uses
`CoRegisterPSClsid`. Do not use `regsvr32` on this DLL: automatic registration
could shadow Microsoft's IID mapping. Only the current interface is implemented;
old `ITerminalHandoff`/`ITerminalHandoff2` callers are unsupported.

Before enabling, the TypeScript integration saves both previous delegation
values, their types and whether they existed to
`<userDataDir>/default-terminal-backup.json`. Repeated enable preserves this
backup. Disable restores it (including deleting previously missing values),
then removes Lookout's keys. Without a backup it restores the all-zero defaults.
The backup remains if restoration fails. Failed enable restores the immediately
preceding delegation values. Switching terminal apps while Lookout is enabled
does not alter the saved backup; disable explicitly restores the saved choice.

Unpackaged registration does not appear in the Windows Settings dropdown.
Elevated consoles ignore per-user COM registration and are outside this feature.
The stable Windows Terminal package is a prerequisite; removing it disables
handoff availability. Windows x64 only. The helper reads a process command line
when permitted; current working directory is not available in this ABI.

## Wire protocol, version 1

Each connection represents one session. A frame is a little-endian uint32
length **including the type byte**, followed by uint8 type and payload. Maximum
length: 1 MiB. VT payloads are raw UTF-8 byte streams, decoded incrementally in
the PTY host so split Unicode characters survive framing.

| Type | Direction | Payload |
| --- | --- | --- |
| 1 HELLO | helper → host | UTF-8 JSON: `version:1`, `pid`, `cols`, `rows`, optional `title`, `commandLine`, `elevated` |
| 2 DATA | either | Raw VT output / UTF-8 input |
| 3 RESIZE | host → helper | uint32 columns, uint32 rows, each 1..32767 |
| 4 CLOSE | host → helper | Empty; close the packed pseudo console |
| 5 EXIT | helper → host | uint32 Windows process exit code; 1 when unavailable |
| 6 READY | host → helper | Empty; host accepted HELLO and attached the offer |

The helper first tries the per-user named pipe. If unavailable it starts
`ExePath` with `LaunchArguments` and waits up to 10 seconds. READY has a further
3-second deadline and each transport write a 5-second deadline. Failed setup
returns a failure HRESULT so Windows can fall back. In development the integration
infers the repository from `<repo>/native/handoff/bin` and passes it to Electron;
packaged `ExePath` needs no arguments. The helper must not start through a shell.

The host exports `startHandoffServer({ pipeName, onSession, log }): HandoffServer`.
Each `HandoffOffer.pty` implements `PtyLike`, including resize, kill, optional
pause/resume, buffered output before subscription, and exactly-once exit delivery.
Malformed frames disconnect only that session. A broken host connection closes
the pseudo console; client exit drains final output briefly and reports its code.

## Build, package, wire up

Run `npm run build:native`. `scripts/build-native.ps1` locates MSVC through
vswhere and invokes CMake/NMake/MIDL. Requires MSVC x64 C++ Build Tools, CMake,
Windows SDK 10.0.26100+ and installed node-pty dependencies. Generated output:

- `native/handoff/bin/LookoutHandoff.exe`
- `native/handoff/bin/LookoutHandoffProxy.dll`
- `native/handoff/bin/conpty.dll`
- `native/handoff/bin/LookoutHandoffSelfTest.exe` (development only)
- `native/handoff/build/` (CMake, MIDL, object/import-library output)

The lead must ignore **`native/handoff/bin/` and `native/handoff/build/`** in git
and copy the first three binaries to `<resources>/native` when packaging. Ship
the node-pty/ConPTY license notices with the DLL. The native code uses the MSVC
runtime (same x64 redistributable requirement as the rest of the app).

The main process should call `getDefaultTerminalStatus`,
`enableDefaultTerminal`, and `disableDefaultTerminal` with the actual executable,
user-data directory, native directory and packaging flag. Start the pipe server
in the PTY utility process **before** enabling; route each offer into tab/session
creation and dispose the server when the host shuts down. Every instance uses
the exported `HANDOFF_PIPE_NAME`; only the app's primary instance may listen.
The app must forward a helper-launched secondary instance to its primary instance.

## Verification and recovery

Safe development checks:

```powershell
npm run build:native
npx vitest run electron/integrations/default-terminal.test.ts electron/pty-host/handoff-server.test.ts
npx tsc --noEmit --strict --target ES2023 --module ESNext --moduleResolution bundler --verbatimModuleSyntax --skipLibCheck --types node electron/integrations/default-terminal.ts electron/integrations/default-terminal.test.ts electron/pty-host/handoff-server.ts electron/pty-host/handoff-server.test.ts
.\native\handoff\bin\LookoutHandoffSelfTest.exe
.\native\handoff\bin\LookoutHandoffSelfTest.exe --close
```

The self-test registers a random temporary local-server CLSID and Lookout's
unique proxy CLSID, refusing to overwrite an existing proxy key. It tests real
cross-process COM activation, handle/BSTR marshalling, bidirectional VT transport,
resize through the bundled ConPTY DLL and exit code 37, and removes its keys.
The `--close` variant also checks that CLOSE releases the ConPTY signal handle.
It never reads or writes delegation settings and starts no real console handoff.

**Owner consent required before running** `scripts/test-handoff-live.ps1`.
That opt-in test backs up exact registry types/values, starts an isolated Node
receiver, temporarily selects a random test helper CLSID plus packaged
OpenConsole, and executes `cmd /c start cmd /k echo LOOKOUT_HANDOFF_OK`. It verifies
that the marker arrives through the helper, closes the test client, and restores
everything in `finally`. It prints a persistent recovery-script command before
the first write; run that command if the test process is forcibly terminated.
Do not delete the printed recovery files before checking restoration.

Actual OS fallback, double-clicked `.bat` files, Win+R, launch-on-demand into the
packaged Electron app and installer behavior still require consented live tests.

Sources: [ABI](https://github.com/microsoft/terminal/blob/main/src/host/proxy/ITerminalHandoff.idl),
[OpenConsole handoff](https://github.com/microsoft/terminal/blob/main/src/host/srvinit.cpp),
[Terminal connection](https://github.com/microsoft/terminal/blob/main/src/cascadia/TerminalConnection/ConptyConnection.cpp),
[OpenConsole class IDs](https://github.com/microsoft/terminal/blob/main/src/host/exe/CConsoleHandoff.h).
