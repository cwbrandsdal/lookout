#include "common.h"
#include "ITerminalHandoff.h"
#include <iostream>
#include <thread>
#include <future>
#include <chrono>

namespace {
void Assert(bool value, const char* message) { if (!value) throw std::runtime_error(message); }
void SetDefault(const std::wstring& path, const std::wstring& value) {
    HKEY key;
    const auto error = RegCreateKeyExW(HKEY_CURRENT_USER, path.c_str(), 0, nullptr, 0, KEY_WRITE, nullptr, &key, nullptr);
    if (error) throw Failure{HRESULT_FROM_WIN32(error)};
    const auto result = RegSetValueExW(key, nullptr, 0, REG_SZ, reinterpret_cast<const BYTE*>(value.c_str()), static_cast<DWORD>((value.size() + 1) * sizeof(wchar_t)));
    RegCloseKey(key);
    if (result) throw Failure{HRESULT_FROM_WIN32(result)};
}
bool Reserve(const std::wstring& path) {
    HKEY key; DWORD disposition;
    const auto error = RegCreateKeyExW(HKEY_CURRENT_USER, path.c_str(), 0, nullptr, 0, KEY_WRITE, nullptr, &key, &disposition);
    if (error) throw Failure{HRESULT_FROM_WIN32(error)};
    RegCloseKey(key);
    return disposition == REG_CREATED_NEW_KEY;
}
}

int wmain(int argc, wchar_t** argv) {
    if (argc > 1 && wcscmp(argv[1], L"--client") == 0) { Sleep(30000); return 0; }
    const bool closeRequested = argc > 1 && wcscmp(argv[1], L"--close") == 0;
    const std::wstring proxyKey = L"Software\\Classes\\CLSID\\" + std::wstring(ProxyClsidText);
    std::wstring terminalKey;
    bool proxyCreated = false, terminalCreated = false, com = false;
    PROCESS_INFORMATION child{};
    Handle childProcess, childThread;
    int result = 1;
    try {
        Check(CoInitializeEx(nullptr, COINIT_MULTITHREADED)); com = true;
        Check(CoRegisterPSClsid(IID_ITerminalHandoff3, ProxyClsid));
        GUID clsid; Check(CoCreateGuid(&clsid)); wchar_t id[40]; StringFromGUID2(clsid, id, 40);
        terminalKey = L"Software\\Classes\\CLSID\\" + std::wstring(id);
        terminalCreated = Reserve(terminalKey);
        Assert(terminalCreated, "Test CLSID already exists");
        proxyCreated = Reserve(proxyKey);
        Assert(proxyCreated, "Lookout proxy CLSID already exists; disable the integration before this isolated test");
        const auto dir = ModuleDir();
        const auto name = L"\\\\.\\pipe\\lookout-self-test-" + std::wstring(id);
        SetDefault(terminalKey + L"\\LocalServer32", L"\"" + dir + L"\\LookoutHandoff.exe\" -Embedding --clsid " + id + L" --pipe " + name);
        SetDefault(proxyKey + L"\\InprocServer32", dir + L"\\LookoutHandoffProxy.dll");
        HKEY key;
        WinCheck(RegOpenKeyExW(HKEY_CURRENT_USER, (proxyKey + L"\\InprocServer32").c_str(), 0, KEY_WRITE, &key) == ERROR_SUCCESS);
        const wchar_t both[] = L"Both";
        RegSetValueExW(key, L"ThreadingModel", 0, REG_SZ, reinterpret_cast<const BYTE*>(both), sizeof(both)); RegCloseKey(key);

        // An actual separate process provides a waitable client with a known exit code.
        auto command = L"\"" + dir + L"\\LookoutHandoffSelfTest.exe\" --client";
        STARTUPINFOW startup{sizeof(startup)};
        WinCheck(CreateProcessW(nullptr, command.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW, nullptr, nullptr, &startup, &child));
        childProcess.reset(child.hProcess); childThread.reset(child.hThread);

        std::promise<void> listening;
        std::promise<void> resized;
        auto resizeObserved = resized.get_future();
        auto receiver = std::async(std::launch::async, [&] {
            Handle pipe(CreateNamedPipeW(name.c_str(), PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_REJECT_REMOTE_CLIENTS, 1, 131072, 131072, 0, nullptr));
            Assert(!!pipe, "Create test pipe");
            Handle event(CreateEventW(nullptr, TRUE, FALSE, nullptr)); OVERLAPPED ov{}; ov.hEvent = event.value;
            const auto connected = ConnectNamedPipe(pipe.value, &ov); const auto error = connected ? ERROR_SUCCESS : GetLastError();
            listening.set_value();
            if (error == ERROR_IO_PENDING) {
                if (WaitForSingleObject(event.value, 20000) != WAIT_OBJECT_0) { CancelIoEx(pipe.value, &ov); DWORD n; GetOverlappedResult(pipe.value, &ov, &n, TRUE); throw std::runtime_error("COM never connected"); }
                DWORD n; WinCheck(GetOverlappedResult(pipe.value, &ov, &n, FALSE));
            } else Assert(error == ERROR_SUCCESS || error == ERROR_PIPE_CONNECTED, "Connect test pipe");
            uint8_t type; std::vector<uint8_t> payload;
            Assert(ReadFrame(pipe.value, type, payload, nullptr, 5000) && type == Hello, "Expected HELLO");
            const std::string hello(payload.begin(), payload.end());
            Assert(hello.find("COM synthetic handoff") != std::string::npos, "Startup BSTR did not cross COM");
            Assert(hello.find("\"cols\":91") != std::string::npos, "Startup dimensions did not cross COM");
            Assert(WriteFrame(pipe.value, Ready, nullptr, 0), "Send READY");
            const std::string input = "synthetic-input";
            Assert(WriteFrame(pipe.value, Data, input.data(), static_cast<uint32_t>(input.size())), "Send input");
            Assert(ReadFrame(pipe.value, type, payload, nullptr, 5000) && type == Data, "Expected output");
            Assert(std::string(payload.begin(), payload.end()) == "synthetic-output", "Output corruption");
            const uint32_t size[] = {101, 42};
            Assert(WriteFrame(pipe.value, Resize, size, sizeof(size)), "Send RESIZE");
            if (closeRequested) {
                Assert(resizeObserved.wait_for(std::chrono::seconds(5)) == std::future_status::ready, "Resize not observed");
                Assert(WriteFrame(pipe.value, Close, nullptr, 0), "Send CLOSE");
            }
            Assert(ReadFrame(pipe.value, type, payload, nullptr, 10000) && type == Exit && payload.size() == 4, "Expected EXIT");
            uint32_t code; memcpy(&code, payload.data(), 4); Assert(code == 37, "Wrong exit code");
        });
        listening.get_future().wait();
        ITerminalHandoff3* handoff = nullptr;
        Check(CoCreateInstance(clsid, nullptr, CLSCTX_LOCAL_SERVER, IID_ITerminalHandoff3, reinterpret_cast<void**>(&handoff)));
        Handle signalRead, signalWrite;
        HANDLE read, write; WinCheck(CreatePipe(&read, &write, nullptr, 0)); signalRead.reset(read); signalWrite.reset(write);
        wchar_t tempDir[MAX_PATH], tempFile[MAX_PATH]; GetTempPathW(MAX_PATH, tempDir); GetTempFileNameW(tempDir, L"loh", 0, tempFile);
        Handle reference(CreateFileW(tempFile, GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_TEMPORARY | FILE_FLAG_DELETE_ON_CLOSE, nullptr));
        Assert(!!reference, "Create reference handle");
        TERMINAL_STARTUP_INFO info{};
        info.pszTitle = SysAllocString(L"COM synthetic handoff"); info.dwXCountChars = 91; info.dwYCountChars = 33;
        HANDLE in = nullptr, out = nullptr;
        const auto hr = handoff->EstablishPtyHandoff(&in, &out, signalWrite.value, reference.value, childProcess.value, childProcess.value, &info);
        SysFreeString(info.pszTitle); handoff->Release(); Check(hr);
        Handle input(in), output(out);
        // Caller handles can be closed immediately after RPC; the helper owns duplicates.
        signalWrite.reset(); reference.reset();
        DWORD available = 0;
        const auto deadline = GetTickCount64() + 5000;
        while (GetTickCount64() < deadline) {
            WinCheck(PeekNamedPipe(input.value, nullptr, 0, nullptr, &available, nullptr));
            if (available) break; Sleep(20);
        }
        char data[64]{}; DWORD count;
        Assert(available > 0, "Input relay timed out");
        WinCheck(ReadFile(input.value, data, sizeof(data), &count, nullptr));
        Assert(std::string(data, count) == "synthetic-input", "Input corruption");
        // Behave like OpenConsole: its input thread keeps a *synchronous* read
        // pending while another thread writes output. If both handles were the
        // same pipe object, the write would queue behind the read forever.
        std::thread reader([&] { char more[16]; DWORD n = 0; ReadFile(input.value, more, sizeof(more), &n, nullptr); });
        Sleep(150);
        std::promise<bool> wrote; auto wroteDone = wrote.get_future();
        std::thread writer([&] {
            const std::string text = "synthetic-output"; DWORD n = 0;
            wrote.set_value(WriteFile(output.value, text.data(), static_cast<DWORD>(text.size()), &n, nullptr) != FALSE);
        });
        const bool writeOk = wroteDone.wait_for(std::chrono::seconds(3)) == std::future_status::ready && wroteDone.get();
        while (WaitForSingleObject(writer.native_handle(), 50) == WAIT_TIMEOUT) CancelSynchronousIo(writer.native_handle());
        writer.join();
        while (WaitForSingleObject(reader.native_handle(), 50) == WAIT_TIMEOUT) CancelSynchronousIo(reader.native_handle());
        reader.join();
        Assert(writeOk, "Output write blocked behind a pending input read (input and output share one pipe)");
        available = 0;
        const auto resizeDeadline = GetTickCount64() + 5000;
        while (GetTickCount64() < resizeDeadline) {
            WinCheck(PeekNamedPipe(signalRead.value, nullptr, 0, nullptr, &available, nullptr));
            if (available) break; Sleep(20);
        }
        Assert(available >= 6, "Packed ConPTY resize did not reach signal pipe");
        uint8_t signal[64]{}; WinCheck(ReadFile(signalRead.value, signal, sizeof(signal), &count, nullptr));
        // ConPTY signal: uint16 opcode (resize=8), then COORD (two int16).
        SHORT cols = 0, rows = 0; memcpy(&cols, signal + 2, 2); memcpy(&rows, signal + 4, 2);
        Assert(cols == 101 && rows == 42, "Wrong ConPTY resize payload");
        resized.set_value();
        if (closeRequested) {
            bool closed = false;
            const auto closeDeadline = GetTickCount64() + 5000;
            while (GetTickCount64() < closeDeadline) {
                if (!PeekNamedPipe(signalRead.value, nullptr, 0, nullptr, &available, nullptr)) {
                    closed = GetLastError() == ERROR_BROKEN_PIPE; break;
                }
                Sleep(20);
            }
            Assert(closed, "CLOSE did not release the packed ConPTY signal handle");
        }
        WinCheck(TerminateProcess(childProcess.value, 37));
        receiver.get();
        std::cout << "PASS: cross-process COM activation, BSTR/handle marshalling, input/output, packed ConPTY resize, "
                  << (closeRequested ? "CLOSE cleanup, " : "") << "exit code 37\n";
        result = 0;
    } catch (const Failure& error) { std::cerr << "HRESULT 0x" << std::hex << static_cast<unsigned long>(error.hr) << '\n'; }
    catch (const std::exception& error) { std::cerr << error.what() << '\n'; }
    if (childProcess) { TerminateProcess(childProcess.value, 1); WaitForSingleObject(childProcess.value, 1000); }
    if (com) CoUninitialize();
    if (terminalCreated) RegDeleteTreeW(HKEY_CURRENT_USER, terminalKey.c_str());
    if (proxyCreated) RegDeleteTreeW(HKEY_CURRENT_USER, proxyKey.c_str());
    return result;
}
