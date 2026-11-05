#pragma once
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <objbase.h>
#include <string>
#include <vector>
#include <stdexcept>
#include <algorithm>
#include <cstdint>
#include <utility>

inline const CLSID TerminalClsid = {0x783ed3d2,0x4bc6,0x48b9,{0xb3,0x0c,0xf1,0x3a,0xe9,0x2a,0x7a,0xb9}};
inline const CLSID ProxyClsid = {0xe1c44c58,0x2d96,0x4a52,{0x98,0x8b,0xd3,0x01,0x7e,0x3b,0xc7,0xc5}};
inline constexpr wchar_t TerminalClsidText[] = L"{783ED3D2-4BC6-48B9-B30C-F13AE92A7AB9}";
inline constexpr wchar_t ProxyClsidText[] = L"{E1C44C58-2D96-4A52-988B-D3017E3BC7C5}";
inline constexpr uint32_t MaxFrame = 1024 * 1024;
enum FrameType : uint8_t { Hello = 1, Data = 2, Resize = 3, Close = 4, Exit = 5, Ready = 6 };

struct Handle {
    HANDLE value = nullptr;
    Handle() = default;
    explicit Handle(HANDLE h) : value(h) {}
    ~Handle() { reset(); }
    Handle(const Handle&) = delete;
    Handle& operator=(const Handle&) = delete;
    Handle(Handle&& h) noexcept : value(h.release()) {}
    Handle& operator=(Handle&& h) noexcept { reset(h.release()); return *this; }
    explicit operator bool() const { return value && value != INVALID_HANDLE_VALUE; }
    HANDLE release() { return std::exchange(value, nullptr); }
    void reset(HANDLE h = nullptr) { if (*this) CloseHandle(value); value = h; }
};
struct Failure { HRESULT hr; };
inline void Check(HRESULT hr) { if (FAILED(hr)) throw Failure{hr}; }
inline void WinCheck(BOOL ok) { if (!ok) throw Failure{HRESULT_FROM_WIN32(GetLastError())}; }
inline Handle Duplicate(HANDLE source) {
    HANDLE result = nullptr;
    WinCheck(DuplicateHandle(GetCurrentProcess(), source, GetCurrentProcess(), &result, 0, FALSE, DUPLICATE_SAME_ACCESS));
    return Handle(result);
}
inline std::wstring ModuleDir() {
    wchar_t path[32768];
    const auto count = GetModuleFileNameW(nullptr, path, 32768);
    if (!count || count >= 32768) throw Failure{E_FAIL};
    const std::wstring result(path, count);
    return result.substr(0, result.find_last_of(L"\\/"));
}
inline std::string Utf8(const std::wstring& value) {
    if (value.empty()) return {};
    const auto count = WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
    std::string result(count, '\0');
    WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), result.data(), count, nullptr, nullptr);
    return result;
}
inline std::string JsonString(const std::wstring& value) {
    std::string result = "\"";
    constexpr char hex[] = "0123456789abcdef";
    for (const unsigned char ch : Utf8(value)) {
        if (ch == '"' || ch == '\\') { result += '\\'; result += ch; }
        else if (ch < 32) { result += "\\u00"; result += hex[ch >> 4]; result += hex[ch & 15]; }
        else result += ch;
    }
    return result + '"';
}
// All pipe handles passed here are overlapped. Every write has a deadline;
// session reads can wait indefinitely but are cancelled by the stop event.
inline bool Io(HANDLE pipe, bool write, void* bytes, DWORD size, DWORD& count, HANDLE stop, DWORD timeout) {
    Handle event(CreateEventW(nullptr, TRUE, FALSE, nullptr));
    if (!event) return false;
    OVERLAPPED ov{}; ov.hEvent = event.value;
    const auto ok = write ? WriteFile(pipe, bytes, size, &count, &ov) : ReadFile(pipe, bytes, size, &count, &ov);
    if (ok) return true;
    if (GetLastError() != ERROR_IO_PENDING) return false;
    HANDLE waits[] = {event.value, stop};
    const auto wait = WaitForMultipleObjects(stop ? 2 : 1, waits, FALSE, timeout);
    if (wait != WAIT_OBJECT_0) {
        CancelIoEx(pipe, &ov);
        GetOverlappedResult(pipe, &ov, &count, TRUE);
        return false;
    }
    return GetOverlappedResult(pipe, &ov, &count, FALSE) != FALSE;
}
inline bool Transfer(HANDLE pipe, bool write, void* bytes, DWORD size, HANDLE stop, DWORD timeout = 5000) {
    const auto deadline = GetTickCount64() + timeout;
    DWORD offset = 0;
    while (offset < size) {
        DWORD count = 0;
        const auto left = timeout == INFINITE ? INFINITE : static_cast<DWORD>(std::min<ULONGLONG>(timeout, deadline > GetTickCount64() ? deadline - GetTickCount64() : 0));
        if (!Io(pipe, write, static_cast<char*>(bytes) + offset, size - offset, count, stop, left) || !count) return false;
        offset += count;
    }
    return true;
}
inline bool WriteFrame(HANDLE pipe, FrameType type, const void* bytes, uint32_t size, HANDLE stop = nullptr) {
    if (size >= MaxFrame) return false;
    std::vector<uint8_t> frame(5 + size);
    const uint32_t length = size + 1;
    memcpy(frame.data(), &length, 4);
    frame[4] = type;
    if (size) memcpy(frame.data() + 5, bytes, size);
    return Transfer(pipe, true, frame.data(), static_cast<DWORD>(frame.size()), stop);
}
inline bool ReadFrame(HANDLE pipe, uint8_t& type, std::vector<uint8_t>& payload, HANDLE stop = nullptr, DWORD timeout = INFINITE) {
    uint32_t size = 0;
    if (!Transfer(pipe, false, &size, 4, stop, timeout) || !size || size > MaxFrame) return false;
    std::vector<uint8_t> frame(size);
    if (!Transfer(pipe, false, frame.data(), size, stop, timeout)) return false;
    type = frame[0]; payload.assign(frame.begin() + 1, frame.end());
    return true;
}
inline Handle OpenPipe(const std::wstring& path, DWORD timeout) {
    const auto deadline = GetTickCount64() + timeout;
    do {
        Handle pipe(CreateFileW(path.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING, FILE_FLAG_OVERLAPPED, nullptr));
        if (pipe) return pipe;
        if (GetLastError() != ERROR_PIPE_BUSY && GetLastError() != ERROR_FILE_NOT_FOUND) break;
        if (GetTickCount64() >= deadline) break;
        WaitNamedPipeW(path.c_str(), 100);
        Sleep(25);
    } while (true);
    return {};
}
inline std::pair<Handle, Handle> DuplexPipe(const std::wstring& name) {
    Handle host(CreateNamedPipeW(name.c_str(), PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
        PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 1, 131072, 131072, 0, nullptr));
    WinCheck(static_cast<BOOL>(!!host));
    Handle event(CreateEventW(nullptr, TRUE, FALSE, nullptr)); WinCheck(static_cast<BOOL>(!!event));
    OVERLAPPED ov{}; ov.hEvent = event.value;
    const BOOL connected = ConnectNamedPipe(host.value, &ov);
    const auto error = connected ? ERROR_SUCCESS : GetLastError();
    if (error != ERROR_SUCCESS && error != ERROR_IO_PENDING && error != ERROR_PIPE_CONNECTED) throw Failure{HRESULT_FROM_WIN32(error)};
    Handle client(CreateFileW(name.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING, 0, nullptr));
    if (!client) {
        const auto openError = GetLastError();
        CancelIoEx(host.value, &ov);
        if (error == ERROR_IO_PENDING) { DWORD count; GetOverlappedResult(host.value, &ov, &count, TRUE); }
        throw Failure{HRESULT_FROM_WIN32(openError)};
    }
    if (error == ERROR_IO_PENDING) {
        DWORD count;
        if (WaitForSingleObject(event.value, 2000) != WAIT_OBJECT_0) {
            CancelIoEx(host.value, &ov); GetOverlappedResult(host.value, &ov, &count, TRUE); throw Failure{HRESULT_FROM_WIN32(ERROR_TIMEOUT)};
        }
        WinCheck(GetOverlappedResult(host.value, &ov, &count, FALSE));
    }
    return {std::move(host), std::move(client)};
}
