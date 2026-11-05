#include "common.h"
#include "ITerminalHandoff.h"
#include <shellapi.h>
#include <atomic>
#include <cstdarg>
#include <cstdio>
#include <memory>
#include <mutex>
#include <thread>

namespace {
std::atomic<unsigned> objects{0}, sessions{0}, locks{0};
std::wstring pipeOverride;
std::mutex logMutex;

// Diagnostics: %LOCALAPPDATA%\Lookout\logs\handoff.log (truncated past 512 KB).
// Windows gives no feedback when a handoff fails, so this is the only trail.
void Log(const wchar_t* format, ...) {
    wchar_t message[1024];
    va_list args;
    va_start(args, format);
    _vsnwprintf_s(message, _countof(message), _TRUNCATE, format, args);
    va_end(args);

    wchar_t base[MAX_PATH];
    if (!ExpandEnvironmentStringsW(L"%LOCALAPPDATA%\\Lookout", base, MAX_PATH)) return;
    CreateDirectoryW(base, nullptr);
    std::wstring dir = std::wstring(base) + L"\\logs";
    CreateDirectoryW(dir.c_str(), nullptr);
    const auto path = dir + L"\\handoff.log";

    std::lock_guard<std::mutex> guard(logMutex);
    WIN32_FILE_ATTRIBUTE_DATA attributes{};
    const bool tooBig = GetFileAttributesExW(path.c_str(), GetFileExInfoStandard, &attributes) && (attributes.nFileSizeHigh || attributes.nFileSizeLow > 512 * 1024);
    HANDLE file = CreateFileW(path.c_str(), tooBig ? GENERIC_WRITE : FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr,
        tooBig ? CREATE_ALWAYS : OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) return;
    SYSTEMTIME now; GetLocalTime(&now);
    wchar_t line[1200];
    const int length = _snwprintf_s(line, _countof(line), _TRUNCATE, L"%04u-%02u-%02u %02u:%02u:%02u.%03u [%lu] %s\r\n",
        now.wYear, now.wMonth, now.wDay, now.wHour, now.wMinute, now.wSecond, now.wMilliseconds, GetCurrentProcessId(), message);
    if (length > 0) {
        const int bytes = WideCharToMultiByte(CP_UTF8, 0, line, length, nullptr, 0, nullptr, nullptr);
        std::string utf8(bytes, '\0');
        WideCharToMultiByte(CP_UTF8, 0, line, length, utf8.data(), bytes, nullptr, nullptr);
        DWORD written = 0;
        WriteFile(file, utf8.data(), static_cast<DWORD>(utf8.size()), &written, nullptr);
    }
    CloseHandle(file);
}

std::wstring Setting(const wchar_t* name) {
    DWORD bytes = 0;
    if (RegGetValueW(HKEY_CURRENT_USER, L"Software\\Lookout\\Handoff", name, RRF_RT_REG_SZ, nullptr, nullptr, &bytes) != ERROR_SUCCESS) return {};
    std::wstring value(bytes / sizeof(wchar_t), L'\0');
    if (RegGetValueW(HKEY_CURRENT_USER, L"Software\\Lookout\\Handoff", name, RRF_RT_REG_SZ, nullptr, value.data(), &bytes) != ERROR_SUCCESS) return {};
    while (!value.empty() && value.back() == 0) value.pop_back();
    return value;
}
Handle ConnectLookout() {
    const auto pipeName = pipeOverride.empty() ? Setting(L"PipeName") : pipeOverride;
    if (pipeName.rfind(L"\\\\.\\pipe\\", 0) != 0) {
        Log(L"Invalid pipe name '%s'", pipeName.c_str());
        throw Failure{E_INVALIDARG};
    }
    auto pipe = OpenPipe(pipeName, 0);
    if (pipe) {
        Log(L"Connected to %s", pipeName.c_str());
        return pipe;
    }
    Log(L"%s not available yet (error %lu); %s", pipeName.c_str(), GetLastError(), pipeOverride.empty() ? L"starting Lookout" : L"waiting");
    if (pipeOverride.empty()) {
        const auto exe = Setting(L"ExePath");
        if (exe.empty() || exe.find(L'"') != std::wstring::npos) throw Failure{E_INVALIDARG};
        auto command = L"\"" + exe + L"\" " + Setting(L"LaunchArguments");
        STARTUPINFOW startup{sizeof(startup)};
        PROCESS_INFORMATION process{};
        WinCheck(CreateProcessW(exe.c_str(), command.data(), nullptr, nullptr, FALSE,
            DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_UNICODE_ENVIRONMENT, nullptr, nullptr, &startup, &process));
        Handle thread(process.hThread), child(process.hProcess);
    }
    pipe = OpenPipe(pipeName, 10000);
    if (!pipe) {
        Log(L"Gave up waiting for %s (error %lu)", pipeName.c_str(), GetLastError());
        throw Failure{HRESULT_FROM_WIN32(ERROR_TIMEOUT)};
    }
    Log(L"Connected to %s after waiting", pipeName.c_str());
    return pipe;
}
struct ConptyApi {
    HMODULE module;
    HRESULT (WINAPI* pack)(HANDLE,HANDLE,HANDLE,HPCON*);
    HRESULT (WINAPI* resize)(HPCON,COORD);
    HRESULT (WINAPI* release)(HPCON);
    void (WINAPI* close)(HPCON);
    ConptyApi() {
        module = LoadLibraryExW((ModuleDir() + L"\\conpty.dll").c_str(), nullptr, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32);
        if (!module) throw Failure{HRESULT_FROM_WIN32(GetLastError())};
        pack = reinterpret_cast<decltype(pack)>(GetProcAddress(module, "ConptyPackPseudoConsole"));
        resize = reinterpret_cast<decltype(resize)>(GetProcAddress(module, "ConptyResizePseudoConsole"));
        release = reinterpret_cast<decltype(release)>(GetProcAddress(module, "ConptyReleasePseudoConsole"));
        close = reinterpret_cast<decltype(close)>(GetProcAddress(module, "ConptyClosePseudoConsole"));
        if (!pack || !resize || !release || !close) { FreeLibrary(module); throw Failure{E_NOINTERFACE}; }
    }
    ~ConptyApi() { FreeLibrary(module); }
};
ConptyApi& Api() { static ConptyApi api; return api; }

// ProcessCommandLineInformation queries the target without reading its PEB.
std::wstring CommandLine(HANDLE process) {
    using Query = LONG (NTAPI*)(HANDLE, ULONG, PVOID, ULONG, PULONG);
    const auto query = reinterpret_cast<Query>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtQueryInformationProcess"));
    if (!query) return {};
    ULONG bytes = 0;
    query(process, 60, nullptr, 0, &bytes);
    if (!bytes || bytes > 1024 * 1024) return {};
    std::vector<uint8_t> buffer(bytes);
    if (query(process, 60, buffer.data(), bytes, &bytes) < 0) return {};
    struct String { USHORT length, capacity; PWSTR buffer; };
    const auto& value = *reinterpret_cast<const String*>(buffer.data());
    const auto begin = reinterpret_cast<uintptr_t>(value.buffer);
    const auto lower = reinterpret_cast<uintptr_t>(buffer.data());
    if (begin < lower || begin + value.length > lower + buffer.size()) return {};
    return std::wstring(value.buffer, value.length / sizeof(wchar_t));
}
bool Elevated(HANDLE process) {
    HANDLE rawToken = nullptr;
    if (!OpenProcessToken(process, TOKEN_QUERY, &rawToken)) return false;
    Handle token(rawToken);
    TOKEN_ELEVATION elevation{}; DWORD size = sizeof(elevation);
    return GetTokenInformation(token.value, TokenElevation, &elevation, sizeof(elevation), &size) && elevation.TokenIsElevated;
}

class Session {
    // vtIn: helper writes keyboard input, the console reads it.
    // vtOut: the console writes VT output, the helper reads it.
    // They must be separate pipes: OpenConsole uses synchronous I/O from two
    // threads, and synchronous I/O on one shared pipe object is serialized,
    // so a blocked input read would stall every output write (deadlock).
    Handle network, vtIn, vtOut, client, server, stop, outputDone;
    HPCON hpc = nullptr;
    std::mutex sendMutex;
    bool Send(FrameType type, const void* data, uint32_t size, bool final = false) {
        std::lock_guard<std::mutex> guard(sendMutex);
        const bool ok = WriteFrame(network.value, type, data, size, final ? nullptr : stop.value);
        if (!ok) SetEvent(stop.value);
        return ok;
    }
    void Output() {
        uint8_t buffer[32768]; DWORD count = 0;
        while (Io(vtOut.value, false, buffer, sizeof(buffer), count, stop.value, INFINITE) && count) {
            if (!Send(Data, buffer, count)) break;
        }
        SetEvent(outputDone.value);
    }
    void Input() {
        uint8_t type; std::vector<uint8_t> payload;
        while (ReadFrame(network.value, type, payload, stop.value)) {
            if (type == Data && !payload.empty()) {
                if (!Transfer(vtIn.value, true, payload.data(), static_cast<DWORD>(payload.size()), stop.value)) break;
            } else if (type == Resize && payload.size() == 8) {
                uint32_t size[2]; memcpy(size, payload.data(), 8);
                if (size[0] < 1 || size[0] > 32767 || size[1] < 1 || size[1] > 32767) break;
                if (FAILED(Api().resize(hpc, COORD{static_cast<SHORT>(size[0]), static_cast<SHORT>(size[1])}))) break;
            } else if (type == Close && payload.empty()) break;
            else break;
        }
        SetEvent(stop.value);
    }
public:
    Handle inputEnd, outputEnd;
    ~Session() { if (hpc) Api().close(hpc); }
    void Prepare(HANDLE signal, HANDLE reference, HANDLE serverProcess, HANDLE clientProcess, const TERMINAL_STARTUP_INFO& info) {
        stop.reset(CreateEventW(nullptr, TRUE, FALSE, nullptr));
        outputDone.reset(CreateEventW(nullptr, TRUE, FALSE, nullptr));
        WinCheck(static_cast<BOOL>(!!stop && !!outputDone));
        auto signalCopy = Duplicate(signal), referenceCopy = Duplicate(reference), serverCopy = Duplicate(serverProcess);
        client = Duplicate(clientProcess);
        server = Duplicate(serverProcess);
        GUID guid{}; Check(CoCreateGuid(&guid)); wchar_t suffix[40]; StringFromGUID2(guid, suffix, 40);
        const auto base = L"\\\\.\\pipe\\lookout-vt-" + std::to_wstring(GetCurrentProcessId()) + L"-" + suffix;
        auto inputPipes = DuplexPipe(base + L"-in");
        auto outputPipes = DuplexPipe(base + L"-out");
        vtIn = std::move(inputPipes.first); inputEnd = std::move(inputPipes.second);
        vtOut = std::move(outputPipes.first); outputEnd = std::move(outputPipes.second);
        network = ConnectLookout();
        auto title = info.pszTitle ? std::wstring(info.pszTitle, SysStringLen(info.pszTitle)) : std::wstring{};
        if (title.empty()) {
            wchar_t path[32768]; DWORD size = 32768;
            if (QueryFullProcessImageNameW(client.value, 0, path, &size)) title.assign(path, size);
        }
        const auto cols = info.dwXCountChars > 0 && info.dwXCountChars <= 32767 ? info.dwXCountChars : 120;
        const auto rows = info.dwYCountChars > 0 && info.dwYCountChars <= 32767 ? info.dwYCountChars : 30;
        const auto hello = std::string("{\"version\":1,\"pid\":") + std::to_string(GetProcessId(client.value)) +
            ",\"cols\":" + std::to_string(cols) + ",\"rows\":" + std::to_string(rows) +
            ",\"title\":" + JsonString(title) + ",\"commandLine\":" + JsonString(CommandLine(client.value)) +
            ",\"elevated\":" + (Elevated(client.value) ? "true}" : "false}");
        if (!Send(Hello, hello.data(), static_cast<uint32_t>(hello.size()))) {
            Log(L"Sending HELLO failed");
            throw Failure{HRESULT_FROM_WIN32(ERROR_BROKEN_PIPE)};
        }
        uint8_t type; std::vector<uint8_t> payload;
        if (!ReadFrame(network.value, type, payload, nullptr, 3000) || type != Ready || !payload.empty()) {
            Log(L"Lookout did not accept the session (no READY within 3 s)");
            throw Failure{HRESULT_FROM_WIN32(ERROR_TIMEOUT)};
        }
        const HRESULT packed = Api().pack(serverCopy.value, referenceCopy.value, signalCopy.value, &hpc);
        Log(L"Session accepted for client pid %lu (%lux%lu); ConptyPackPseudoConsole -> 0x%08lx", GetProcessId(client.value), cols, rows, static_cast<unsigned long>(packed));
        Check(packed);
        serverCopy.release(); referenceCopy.release(); signalCopy.release();
    }
    void Run() noexcept {
        try {
            Check(Api().release(hpc));
            std::thread output([this] { Output(); });
            std::thread input;
            try { input = std::thread([this] { Input(); }); }
            catch (...) { SetEvent(stop.value); output.join(); throw; }
            HANDLE waits[] = {stop.value, client.value, server.value, outputDone.value};
            const auto reason = WaitForMultipleObjects(4, waits, FALSE, INFINITE);
            // Give output already in flight time to drain before reporting exit.
            if (reason == WAIT_OBJECT_0 + 1 || reason == WAIT_OBJECT_0 + 2) WaitForSingleObject(outputDone.value, 500);
            SetEvent(stop.value);
            // Resize uses the ConPTY DLL's synchronous signal write. Cancel it
            // too if the console stops draining that pipe during shutdown.
            while (WaitForSingleObject(input.native_handle(), 50) == WAIT_TIMEOUT) CancelSynchronousIo(input.native_handle());
            input.join();
            Api().close(hpc); hpc = nullptr;
            output.join();
            WaitForSingleObject(client.value, 3000);
            DWORD code = 1;
            if (!GetExitCodeProcess(client.value, &code) || code == STILL_ACTIVE) code = 1;
            Send(Exit, &code, sizeof(code), true);
        } catch (...) { SetEvent(stop.value); }
        CancelIoEx(network.value, nullptr);
    }
};

class Terminal final : public ITerminalHandoff3 {
    std::atomic<ULONG> refs{1};
public:
    Terminal() { ++objects; }
    ~Terminal() { --objects; }
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, void** out) override {
        if (!out) return E_POINTER;
        *out = nullptr;
        if (iid == IID_IUnknown || iid == IID_ITerminalHandoff3) { *out = static_cast<ITerminalHandoff3*>(this); AddRef(); return S_OK; }
        return E_NOINTERFACE;
    }
    ULONG STDMETHODCALLTYPE AddRef() override { return ++refs; }
    ULONG STDMETHODCALLTYPE Release() override { const auto count = --refs; if (!count) delete this; return count; }
    HRESULT STDMETHODCALLTYPE EstablishPtyHandoff(HANDLE* in, HANDLE* out, HANDLE signal, HANDLE reference, HANDLE server, HANDLE client, const TERMINAL_STARTUP_INFO* info) override {
        if (!in || !out) return E_POINTER;
        *in = nullptr; *out = nullptr;
        if (!info) return E_POINTER;
        Log(L"EstablishPtyHandoff: client pid %lu, %lux%lu", GetProcessId(client), info->dwXCountChars, info->dwYCountChars);
        try {
            auto session = std::make_shared<Session>();
            session->Prepare(signal, reference, server, client, *info);
            ++sessions;
            try { std::thread([session] { session->Run(); --sessions; }).detach(); }
            catch (...) { --sessions; throw; }
            *in = session->inputEnd.release(); *out = session->outputEnd.release();
            return S_OK;
        } catch (const Failure& failure) {
            Log(L"Handoff failed: 0x%08lx (Windows falls back to the classic console)", static_cast<unsigned long>(failure.hr));
            return failure.hr;
        }
        catch (const std::bad_alloc&) { Log(L"Handoff failed: out of memory"); return E_OUTOFMEMORY; }
        catch (...) { Log(L"Handoff failed: unexpected error"); return E_FAIL; }
    }
};
class Factory final : public IClassFactory {
    std::atomic<ULONG> refs{1};
public:
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, void** out) override {
        if (!out) return E_POINTER;
        *out = nullptr;
        if (iid == IID_IUnknown || iid == IID_IClassFactory) { *out = static_cast<IClassFactory*>(this); AddRef(); return S_OK; }
        return E_NOINTERFACE;
    }
    ULONG STDMETHODCALLTYPE AddRef() override { return ++refs; }
    ULONG STDMETHODCALLTYPE Release() override { const auto count = --refs; if (!count) delete this; return count; }
    HRESULT STDMETHODCALLTYPE CreateInstance(IUnknown* outer, REFIID iid, void** out) override {
        if (outer) return CLASS_E_NOAGGREGATION;
        auto terminal = new (std::nothrow) Terminal(); if (!terminal) return E_OUTOFMEMORY;
        const auto hr = terminal->QueryInterface(iid, out); terminal->Release(); return hr;
    }
    HRESULT STDMETHODCALLTYPE LockServer(BOOL lock) override { if (lock) ++locks; else if (locks) --locks; return S_OK; }
};
}

int WINAPI wWinMain(HINSTANCE, HINSTANCE, PWSTR, int) {
    Log(L"Started: %s", GetCommandLineW());
    HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (FAILED(hr)) { Log(L"CoInitializeEx failed: 0x%08lx", static_cast<unsigned long>(hr)); return static_cast<int>(hr); }
    DWORD cookie = 0;
    try {
        Check(CoInitializeSecurity(nullptr, -1, nullptr, nullptr, RPC_C_AUTHN_LEVEL_PKT_PRIVACY,
            RPC_C_IMP_LEVEL_IDENTIFY, nullptr, EOAC_NONE, nullptr));
        // Do not modify global or packaged ITerminalHandoff3 interface mappings.
        Check(CoRegisterPSClsid(IID_ITerminalHandoff3, ProxyClsid));
        CLSID clsid = TerminalClsid;
        int argc; auto argv = CommandLineToArgvW(GetCommandLineW(), &argc);
        if (!argv) throw Failure{E_OUTOFMEMORY};
        for (int i = 1; i < argc; ++i) {
            if (wcscmp(argv[i], L"--clsid") == 0 && i + 1 < argc) Check(CLSIDFromString(argv[++i], &clsid));
            else if (wcscmp(argv[i], L"--pipe") == 0 && i + 1 < argc) pipeOverride = argv[++i];
        }
        LocalFree(argv);
        Api();
        auto factory = new Factory();
        hr = CoRegisterClassObject(clsid, factory, CLSCTX_LOCAL_SERVER, REGCLS_MULTIPLEUSE, &cookie);
        Log(L"CoRegisterClassObject -> 0x%08lx", static_cast<unsigned long>(hr));
        factory->Release(); Check(hr);
        ULONGLONG idleSince = GetTickCount64();
        for (;;) {
            Sleep(200);
            if (objects || sessions || locks) idleSince = GetTickCount64();
            else if (GetTickCount64() - idleSince > 15000) break;
        }
    } catch (const Failure& failure) { hr = failure.hr; Log(L"Startup failed: 0x%08lx", static_cast<unsigned long>(hr)); }
    catch (...) { hr = E_FAIL; Log(L"Startup failed: unexpected error"); }
    Log(L"Exiting (0x%08lx)", static_cast<unsigned long>(hr));
    if (cookie) CoRevokeClassObject(cookie);
    CoUninitialize();
    return static_cast<int>(hr);
}
