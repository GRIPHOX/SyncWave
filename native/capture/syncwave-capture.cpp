// syncwave-capture â€” WASAPI loopback capture helper for SyncWave.
//
// Usage:
//   syncwave-capture list
//       Prints a JSON document with capturable sources to stdout and exits.
//   syncwave-capture capture --system
//   syncwave-capture capture --system --exclude-pid <pid>
//   syncwave-capture capture --pid <pid>
//       Streams raw PCM (s16le, 48000 Hz, 2 channels, interleaved) to stdout.
//       Newline-delimited JSON events go to stderr. A line "stop" on stdin,
//       or stdin reaching EOF (parent died), ends the capture cleanly.
//
// Exit codes: 0 = stopped normally, 1 = usage, 2 = capture failed,
//             3 = target process exited, 4 = output pipe closed.

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <audiopolicy.h>
#include <audioclientactivationparams.h>
#include <endpointvolume.h>
#include <tlhelp32.h>
#include <avrt.h>
#include <wrl/client.h>
#include <wrl/implements.h>
#include <initguid.h>
#include <functiondiscoverykeys_devpkey.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <map>
#include <mutex>
#include <set>
#include <string>
#include <thread>
#include <vector>

using Microsoft::WRL::ComPtr;

namespace {

constexpr int kOutRate = 48000;
constexpr int kOutChannels = 2;

// ---------------------------------------------------------------- utilities

std::string Utf8(const std::wstring& w) {
  if (w.empty()) return {};
  int n = WideCharToMultiByte(CP_UTF8, 0, w.data(), (int)w.size(), nullptr, 0, nullptr, nullptr);
  std::string s(n, '\0');
  WideCharToMultiByte(CP_UTF8, 0, w.data(), (int)w.size(), s.data(), n, nullptr, nullptr);
  return s;
}

std::string JsonStr(const std::string& s) {
  std::string o = "\"";
  for (unsigned char c : s) {
    switch (c) {
      case '"': o += "\\\""; break;
      case '\\': o += "\\\\"; break;
      case '\n': o += "\\n"; break;
      case '\r': o += "\\r"; break;
      case '\t': o += "\\t"; break;
      default:
        if (c < 0x20) {
          char buf[8];
          snprintf(buf, sizeof buf, "\\u%04x", c);
          o += buf;
        } else {
          o += (char)c;
        }
    }
  }
  return o + "\"";
}

std::string JsonStr(const std::wstring& w) { return JsonStr(Utf8(w)); }

std::string Hex(HRESULT hr) {
  char buf[16];
  snprintf(buf, sizeof buf, "0x%08lx", (unsigned long)hr);
  return buf;
}

std::mutex g_errMutex;

// One JSON object per line on stderr.
void Emit(const std::string& json) {
  std::lock_guard<std::mutex> lock(g_errMutex);
  std::string line = json + "\n";
  DWORD written = 0;
  WriteFile(GetStdHandle(STD_ERROR_HANDLE), line.data(), (DWORD)line.size(), &written, nullptr);
}

void EmitError(const std::string& code, HRESULT hr, const std::string& message) {
  Emit("{\"event\":\"error\",\"code\":" + JsonStr(code) + ",\"hr\":" + JsonStr(Hex(hr)) +
       ",\"message\":" + JsonStr(message) + "}");
}

std::wstring Lower(std::wstring s) {
  std::transform(s.begin(), s.end(), s.begin(), [](wchar_t c) { return (wchar_t)towlower(c); });
  return s;
}

DWORD OsBuild() {
  using RtlGetVersionFn = LONG(WINAPI*)(PRTL_OSVERSIONINFOW);
  auto fn = (RtlGetVersionFn)GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "RtlGetVersion");
  RTL_OSVERSIONINFOW vi = {sizeof vi};
  if (fn && fn(&vi) == 0) return vi.dwBuildNumber;
  return 0;
}

bool ProcessLoopbackSupported() { return OsBuild() >= 19041; }

// ---------------------------------------------------------- process info

struct ProcEntry {
  DWORD ppid = 0;
  std::wstring exe;
};

std::map<DWORD, ProcEntry> SnapshotProcesses() {
  std::map<DWORD, ProcEntry> out;
  HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snap == INVALID_HANDLE_VALUE) return out;
  PROCESSENTRY32W pe = {sizeof pe};
  if (Process32FirstW(snap, &pe)) {
    do {
      out[pe.th32ProcessID] = {pe.th32ParentProcessID, pe.szExeFile};
    } while (Process32NextW(snap, &pe));
  }
  CloseHandle(snap);
  return out;
}

// Walks up the parent chain while the parent runs the same executable. This
// maps e.g. Chrome's audio-service child process to the browser process.
DWORD RootPid(DWORD pid, const std::map<DWORD, ProcEntry>& procs) {
  DWORD cur = pid;
  for (int i = 0; i < 32; i++) {
    auto it = procs.find(cur);
    if (it == procs.end()) break;
    auto parent = procs.find(it->second.ppid);
    if (parent == procs.end() || it->second.ppid == cur) break;
    if (Lower(parent->second.exe) != Lower(it->second.exe)) break;
    cur = it->second.ppid;
  }
  return cur;
}

std::wstring ProcessPath(DWORD pid) {
  HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!h) return {};
  wchar_t buf[MAX_PATH * 2];
  DWORD size = (DWORD)(sizeof buf / sizeof buf[0]);
  std::wstring path;
  if (QueryFullProcessImageNameW(h, 0, buf, &size)) path.assign(buf, size);
  CloseHandle(h);
  return path;
}

std::wstring FileDescription(const std::wstring& path) {
  if (path.empty()) return {};
  DWORD dummy = 0;
  DWORD size = GetFileVersionInfoSizeW(path.c_str(), &dummy);
  if (!size) return {};
  std::vector<BYTE> data(size);
  if (!GetFileVersionInfoW(path.c_str(), 0, size, data.data())) return {};
  struct Lang { WORD lang, cp; }* langs = nullptr;
  UINT len = 0;
  if (!VerQueryValueW(data.data(), L"\\VarFileInfo\\Translation", (void**)&langs, &len) || len < sizeof(Lang))
    return {};
  wchar_t key[64];
  swprintf(key, 64, L"\\StringFileInfo\\%04x%04x\\FileDescription", langs[0].lang, langs[0].cp);
  wchar_t* value = nullptr;
  if (!VerQueryValueW(data.data(), key, (void**)&value, &len) || !value || len <= 1) return {};
  return std::wstring(value);
}

std::wstring StripExe(const std::wstring& exe) {
  if (exe.size() > 4 && Lower(exe.substr(exe.size() - 4)) == L".exe") return exe.substr(0, exe.size() - 4);
  return exe;
}

// ------------------------------------------------------------- listing

struct Source {
  DWORD pid = 0;
  std::wstring exe, path, name, title;
  bool hasSession = false;
  bool active = false;
  float peak = 0.f;
};

BOOL CALLBACK EnumWindowsProc(HWND hwnd, LPARAM lp) {
  auto* titles = reinterpret_cast<std::map<DWORD, std::wstring>*>(lp);
  if (!IsWindowVisible(hwnd) || GetWindow(hwnd, GW_OWNER)) return TRUE;
  if (GetWindowLongW(hwnd, GWL_EXSTYLE) & WS_EX_TOOLWINDOW) return TRUE;
  wchar_t title[256];
  int n = GetWindowTextW(hwnd, title, 256);
  if (n <= 0) return TRUE;
  DWORD pid = 0;
  GetWindowThreadProcessId(hwnd, &pid);
  if (pid && !titles->count(pid)) (*titles)[pid] = std::wstring(title, n);
  return TRUE;
}

std::wstring DeviceName(IMMDevice* dev) {
  ComPtr<IPropertyStore> props;
  if (FAILED(dev->OpenPropertyStore(STGM_READ, &props))) return {};
  PROPVARIANT pv;
  PropVariantInit(&pv);
  std::wstring name;
  if (SUCCEEDED(props->GetValue(PKEY_Device_FriendlyName, &pv)) && pv.vt == VT_LPWSTR) name = pv.pwszVal;
  PropVariantClear(&pv);
  return name;
}

int RunList() {
  auto procs = SnapshotProcesses();
  std::map<DWORD, Source> roots;
  const DWORD self = GetCurrentProcessId();

  ComPtr<IMMDeviceEnumerator> enumr;
  std::wstring defaultDevice;
  if (SUCCEEDED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&enumr)))) {
    ComPtr<IMMDevice> def;
    if (SUCCEEDED(enumr->GetDefaultAudioEndpoint(eRender, eConsole, &def))) defaultDevice = DeviceName(def.Get());

    ComPtr<IMMDeviceCollection> devices;
    UINT count = 0;
    if (SUCCEEDED(enumr->EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, &devices))) devices->GetCount(&count);
    for (UINT d = 0; d < count; d++) {
      ComPtr<IMMDevice> dev;
      ComPtr<IAudioSessionManager2> mgr;
      ComPtr<IAudioSessionEnumerator> sessions;
      if (FAILED(devices->Item(d, &dev))) continue;
      if (FAILED(dev->Activate(__uuidof(IAudioSessionManager2), CLSCTX_ALL, nullptr, (void**)mgr.GetAddressOf())))
        continue;
      if (FAILED(mgr->GetSessionEnumerator(&sessions))) continue;
      int n = 0;
      sessions->GetCount(&n);
      for (int i = 0; i < n; i++) {
        ComPtr<IAudioSessionControl> ctl;
        ComPtr<IAudioSessionControl2> ctl2;
        if (FAILED(sessions->GetSession(i, &ctl)) || FAILED(ctl.As(&ctl2))) continue;
        if (ctl2->IsSystemSoundsSession() == S_OK) continue;
        DWORD pid = 0;
        if (FAILED(ctl2->GetProcessId(&pid)) || pid == 0 || pid == self) continue;
        AudioSessionState state = AudioSessionStateInactive;
        ctl2->GetState(&state);
        if (state == AudioSessionStateExpired) continue;
        float peak = 0.f;
        ComPtr<IAudioMeterInformation> meter;
        if (SUCCEEDED(ctl.As(&meter))) meter->GetPeakValue(&peak);
        DWORD root = RootPid(pid, procs);
        Source& s = roots[root];
        s.pid = root;
        s.hasSession = true;
        s.active = s.active || state == AudioSessionStateActive;
        s.peak = std::max(s.peak, peak);
      }
    }
  }

  std::map<DWORD, std::wstring> titles;
  EnumWindows(EnumWindowsProc, reinterpret_cast<LPARAM>(&titles));
  for (auto& [pid, title] : titles) {
    if (pid == self) continue;
    DWORD root = RootPid(pid, procs);
    Source& s = roots[root];
    s.pid = root;
    if (s.title.empty()) s.title = title;
  }

  // Shell and system UI hosts that own windows but are never useful sources.
  static const std::set<std::wstring> kHidden = {
      L"explorer.exe", L"applicationframehost.exe", L"textinputhost.exe", L"shellexperiencehost.exe",
      L"searchapp.exe", L"searchhost.exe", L"startmenuexperiencehost.exe", L"systemsettings.exe",
      L"lockapp.exe", L"syncwave-capture.exe", L"csrss.exe", L"dwm.exe", L"nvidia share.exe",
      L"nvcontainer.exe", L"gamebar.exe", L"gamebarftserver.exe", L"widgets.exe"};

  std::string json = "{\"processLoopbackSupported\":";
  json += ProcessLoopbackSupported() ? "true" : "false";
  json += ",\"osBuild\":" + std::to_string(OsBuild());
  json += ",\"defaultDevice\":" + JsonStr(defaultDevice) + ",\"sources\":[";
  bool first = true;
  for (auto& [pid, s] : roots) {
    auto it = procs.find(pid);
    if (it == procs.end()) continue;
    s.exe = it->second.exe;
    if (kHidden.count(Lower(s.exe))) continue;
    s.path = ProcessPath(pid);
    s.name = FileDescription(s.path);
    if (s.name.empty()) s.name = StripExe(s.exe);
    if (!first) json += ",";
    first = false;
    char peak[32];
    snprintf(peak, sizeof peak, "%.4f", s.peak);
    json += "{\"pid\":" + std::to_string(pid) + ",\"name\":" + JsonStr(s.name) + ",\"exe\":" + JsonStr(s.exe) +
            ",\"path\":" + JsonStr(s.path) + ",\"title\":" + JsonStr(s.title) +
            ",\"hasAudioSession\":" + (s.hasSession ? "true" : "false") +
            ",\"active\":" + (s.active ? "true" : "false") + ",\"peak\":" + peak + "}";
  }
  json += "]}\n";
  DWORD written = 0;
  WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), json.data(), (DWORD)json.size(), &written, nullptr);
  return 0;
}

// ---------------------------------------------------------- conversion

enum class SampleKind { Float32, Int16, Int24, Int32 };

// Converts any shared-mode WASAPI format to s16le stereo at 48 kHz.
class Converter {
 public:
  bool Configure(const WAVEFORMATEX* wf) {
    channels_ = wf->nChannels;
    rate_ = wf->nSamplesPerSec;
    blockAlign_ = wf->nBlockAlign;
    WORD tag = wf->wFormatTag;
    WORD validBits = wf->wBitsPerSample;
    if (tag == WAVE_FORMAT_EXTENSIBLE && wf->cbSize >= 22) {
      auto* ext = reinterpret_cast<const WAVEFORMATEXTENSIBLE*>(wf);
      if (IsEqualGUID(ext->SubFormat, KSDATAFORMAT_SUBTYPE_IEEE_FLOAT)) tag = WAVE_FORMAT_IEEE_FLOAT;
      else if (IsEqualGUID(ext->SubFormat, KSDATAFORMAT_SUBTYPE_PCM)) tag = WAVE_FORMAT_PCM;
      if (ext->Samples.wValidBitsPerSample) validBits = ext->Samples.wValidBitsPerSample;
    }
    (void)validBits;
    if (tag == WAVE_FORMAT_IEEE_FLOAT && wf->wBitsPerSample == 32) kind_ = SampleKind::Float32;
    else if (tag == WAVE_FORMAT_PCM && wf->wBitsPerSample == 16) kind_ = SampleKind::Int16;
    else if (tag == WAVE_FORMAT_PCM && wf->wBitsPerSample == 24) kind_ = SampleKind::Int24;
    else if (tag == WAVE_FORMAT_PCM && wf->wBitsPerSample == 32) kind_ = SampleKind::Int32;
    else return false;
    step_ = (double)rate_ / kOutRate;
    pos_ = 0.0;
    havePrev_ = false;
    return channels_ >= 1;
  }

  bool Passthrough() const { return kind_ == SampleKind::Int16 && channels_ == 2 && rate_ == kOutRate; }

  // Appends converted s16 stereo samples to out.
  void Convert(const BYTE* data, UINT32 frames, std::vector<int16_t>& out) {
    if (Passthrough()) {
      auto* s = reinterpret_cast<const int16_t*>(data);
      out.insert(out.end(), s, s + frames * 2);
      return;
    }
    for (UINT32 f = 0; f < frames; f++) {
      float l, r;
      Frame(data + (size_t)f * blockAlign_, l, r);
      if (rate_ == kOutRate) {
        Push(l, r, out);
        continue;
      }
      // Linear-interpolating resampler between the previous and this frame.
      if (!havePrev_) {
        prevL_ = l;
        prevR_ = r;
        havePrev_ = true;
        continue;
      }
      while (pos_ < 1.0) {
        float t = (float)pos_;
        Push(prevL_ + (l - prevL_) * t, prevR_ + (r - prevR_) * t, out);
        pos_ += step_;
      }
      pos_ -= 1.0;
      prevL_ = l;
      prevR_ = r;
    }
  }

 private:
  float Sample(const BYTE* p) const {
    switch (kind_) {
      case SampleKind::Float32: return *reinterpret_cast<const float*>(p);
      case SampleKind::Int16: return *reinterpret_cast<const int16_t*>(p) / 32768.f;
      case SampleKind::Int24: {
        int32_t v = (int32_t)((uint32_t)p[0] << 8 | (uint32_t)p[1] << 16 | (uint32_t)p[2] << 24);
        return (v >> 8) / 8388608.f;
      }
      case SampleKind::Int32: return *reinterpret_cast<const int32_t*>(p) / 2147483648.f;
    }
    return 0.f;
  }

  void Frame(const BYTE* p, float& l, float& r) const {
    const int bytes = blockAlign_ / channels_;
    if (channels_ == 1) {
      l = r = Sample(p);
      return;
    }
    l = Sample(p);
    r = Sample(p + bytes);
    // Standard WAVE channel order: FL FR FC LFE BL BR (SL SR).
    if (channels_ >= 3) {
      float c = Sample(p + 2 * bytes) * 0.7071f;
      l += c;
      r += c;
    }
    if (channels_ >= 6) {
      l += Sample(p + 4 * bytes) * 0.7071f;
      r += Sample(p + 5 * bytes) * 0.7071f;
    }
    if (channels_ >= 8) {
      l += Sample(p + 6 * bytes) * 0.7071f;
      r += Sample(p + 7 * bytes) * 0.7071f;
    }
  }

  static int16_t ToS16(float v) {
    if (v > 1.f) v = 1.f;
    if (v < -1.f) v = -1.f;
    return (int16_t)std::lrintf(v * 32767.f);
  }

  static void Push(float l, float r, std::vector<int16_t>& out) {
    out.push_back(ToS16(l));
    out.push_back(ToS16(r));
  }

  SampleKind kind_ = SampleKind::Float32;
  int channels_ = 2;
  DWORD rate_ = kOutRate;
  int blockAlign_ = 8;
  double step_ = 1.0, pos_ = 0.0;
  bool havePrev_ = false;
  float prevL_ = 0.f, prevR_ = 0.f;
};

// --------------------------------------------------------------- output

std::atomic<bool> g_outputBroken{false};

bool WriteOut(const void* data, size_t bytes) {
  HANDLE out = GetStdHandle(STD_OUTPUT_HANDLE);
  const BYTE* p = static_cast<const BYTE*>(data);
  while (bytes > 0) {
    DWORD written = 0;
    if (!WriteFile(out, p, (DWORD)std::min<size_t>(bytes, 1 << 20), &written, nullptr) || written == 0) {
      g_outputBroken = true;
      return false;
    }
    p += written;
    bytes -= written;
  }
  return true;
}

// ------------------------------------------------------ COM helpers

class ActivationHandler
    : public Microsoft::WRL::RuntimeClass<Microsoft::WRL::RuntimeClassFlags<Microsoft::WRL::ClassicCom>,
                                          Microsoft::WRL::FtmBase, IActivateAudioInterfaceCompletionHandler> {
 public:
  ActivationHandler() { done_ = CreateEventW(nullptr, TRUE, FALSE, nullptr); }
  ~ActivationHandler() override { CloseHandle(done_); }

  STDMETHOD(ActivateCompleted)(IActivateAudioInterfaceAsyncOperation* op) override {
    HRESULT activateHr = E_FAIL;
    ComPtr<IUnknown> unk;
    HRESULT hr = op->GetActivateResult(&activateHr, &unk);
    if (SUCCEEDED(hr) && SUCCEEDED(activateHr)) result_ = unk.As(&client_);
    else result_ = FAILED(hr) ? hr : activateHr;
    SetEvent(done_);
    return S_OK;
  }

  HANDLE done_;
  HRESULT result_ = E_PENDING;
  ComPtr<IAudioClient> client_;
};

class DeviceWatcher
    : public Microsoft::WRL::RuntimeClass<Microsoft::WRL::RuntimeClassFlags<Microsoft::WRL::ClassicCom>,
                                          IMMNotificationClient> {
 public:
  explicit DeviceWatcher(HANDLE changed) : changed_(changed) {}
  STDMETHOD(OnDefaultDeviceChanged)(EDataFlow flow, ERole role, LPCWSTR) override {
    if (flow == eRender && role == eConsole) SetEvent(changed_);
    return S_OK;
  }
  STDMETHOD(OnDeviceStateChanged)(LPCWSTR, DWORD) override { return S_OK; }
  STDMETHOD(OnDeviceAdded)(LPCWSTR) override { return S_OK; }
  STDMETHOD(OnDeviceRemoved)(LPCWSTR) override { return S_OK; }
  STDMETHOD(OnPropertyValueChanged)(LPCWSTR, const PROPERTYKEY) override { return S_OK; }

 private:
  HANDLE changed_;
};

// -------------------------------------------------------------- capture

enum class Mode { System, Process, SystemExclude };

struct Opened {
  ComPtr<IAudioClient> client;
  ComPtr<IAudioCaptureClient> capture;
  Converter conv;
  bool eventDriven = false;
  std::wstring device;
};

WAVEFORMATEXTENSIBLE Format48kFloat() {
  WAVEFORMATEXTENSIBLE wf = {};
  wf.Format.wFormatTag = WAVE_FORMAT_EXTENSIBLE;
  wf.Format.nChannels = 2;
  wf.Format.nSamplesPerSec = kOutRate;
  wf.Format.wBitsPerSample = 32;
  wf.Format.nBlockAlign = 8;
  wf.Format.nAvgBytesPerSec = kOutRate * 8;
  wf.Format.cbSize = 22;
  wf.Samples.wValidBitsPerSample = 32;
  wf.dwChannelMask = SPEAKER_FRONT_LEFT | SPEAKER_FRONT_RIGHT;
  wf.SubFormat = KSDATAFORMAT_SUBTYPE_IEEE_FLOAT;
  return wf;
}

constexpr REFERENCE_TIME kBufferDuration = 2000000;  // 200 ms in 100-ns units

HRESULT OpenSystem(Opened& o) {
  ComPtr<IMMDeviceEnumerator> enumr;
  ComPtr<IMMDevice> dev;
  HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&enumr));
  if (FAILED(hr)) return hr;
  hr = enumr->GetDefaultAudioEndpoint(eRender, eConsole, &dev);
  if (FAILED(hr)) return hr;
  o.device = DeviceName(dev.Get());
  hr = dev->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, (void**)o.client.ReleaseAndGetAddressOf());
  if (FAILED(hr)) return hr;

  // Prefer letting the audio engine convert to 48 kHz stereo float.
  WAVEFORMATEXTENSIBLE want = Format48kFloat();
  hr = o.client->Initialize(AUDCLNT_SHAREMODE_SHARED,
                            AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM |
                                AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
                            kBufferDuration, 0, &want.Format, nullptr);
  if (SUCCEEDED(hr)) {
    o.conv.Configure(&want.Format);
  } else {
    // Fall back to the engine mix format and convert ourselves.
    hr = dev->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, (void**)o.client.ReleaseAndGetAddressOf());
    if (FAILED(hr)) return hr;
    WAVEFORMATEX* mix = nullptr;
    hr = o.client->GetMixFormat(&mix);
    if (FAILED(hr)) return hr;
    bool ok = o.conv.Configure(mix);
    hr = ok ? o.client->Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK, kBufferDuration, 0, mix,
                                   nullptr)
            : AUDCLNT_E_UNSUPPORTED_FORMAT;
    CoTaskMemFree(mix);
    if (FAILED(hr)) return hr;
  }
  o.eventDriven = false;
  return o.client->GetService(IID_PPV_ARGS(&o.capture));
}

HRESULT OpenProcessLoopback(Opened& o, DWORD pid, bool exclude, HANDLE audioEvent) {
  AUDIOCLIENT_ACTIVATION_PARAMS ap = {};
  ap.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
  ap.ProcessLoopbackParams.TargetProcessId = pid;
  ap.ProcessLoopbackParams.ProcessLoopbackMode =
      exclude ? PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE : PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;
  PROPVARIANT pv = {};
  pv.vt = VT_BLOB;
  pv.blob.cbSize = sizeof ap;
  pv.blob.pBlobData = reinterpret_cast<BYTE*>(&ap);

  auto handler = Microsoft::WRL::Make<ActivationHandler>();
  ComPtr<IActivateAudioInterfaceAsyncOperation> op;
  HRESULT hr = ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, __uuidof(IAudioClient), &pv,
                                           handler.Get(), &op);
  if (FAILED(hr)) return hr;
  if (WaitForSingleObject(handler->done_, 5000) != WAIT_OBJECT_0) return HRESULT_FROM_WIN32(ERROR_TIMEOUT);
  if (FAILED(handler->result_)) return handler->result_;
  o.client = handler->client_;
  o.device = exclude ? L"Process loopback (exclude)" : L"Process loopback";

  // Process loopback has no mix format; ask for 48 kHz s16 stereo directly.
  WAVEFORMATEX wf = {};
  wf.wFormatTag = WAVE_FORMAT_PCM;
  wf.nChannels = 2;
  wf.nSamplesPerSec = kOutRate;
  wf.wBitsPerSample = 16;
  wf.nBlockAlign = 4;
  wf.nAvgBytesPerSec = kOutRate * 4;
  hr = o.client->Initialize(AUDCLNT_SHAREMODE_SHARED,
                            AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK |
                                AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
                            kBufferDuration, 0, &wf, nullptr);
  if (FAILED(hr)) return hr;
  o.conv.Configure(&wf);
  hr = o.client->SetEventHandle(audioEvent);
  if (FAILED(hr)) return hr;
  o.eventDriven = true;
  return o.client->GetService(IID_PPV_ARGS(&o.capture));
}

HANDLE g_stop = nullptr;

void StdinWatcher() {
  HANDLE in = GetStdHandle(STD_INPUT_HANDLE);
  std::string line;
  char buf[256];
  for (;;) {
    DWORD read = 0;
    if (!ReadFile(in, buf, sizeof buf, &read, nullptr) || read == 0) break;  // EOF: parent is gone
    for (DWORD i = 0; i < read; i++) {
      if (buf[i] == '\n') {
        if (line.find("stop") != std::string::npos) {
          SetEvent(g_stop);
          return;
        }
        line.clear();
      } else if (line.size() < 1024) {
        line += buf[i];
      }
    }
  }
  SetEvent(g_stop);
}

int RunCapture(Mode mode, DWORD pid) {
  g_stop = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  HANDLE audioEvent = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  HANDLE deviceChanged = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  std::thread(StdinWatcher).detach();

  HANDLE target = nullptr;
  if (mode == Mode::Process) {
    target = OpenProcess(SYNCHRONIZE, FALSE, pid);
    if (!target) {
      EmitError("process_not_found", HRESULT_FROM_WIN32(GetLastError()), "The selected app is not running.");
      return 2;
    }
  }
  if (mode != Mode::System && !ProcessLoopbackSupported()) {
    EmitError("unsupported_os", E_NOTIMPL, "Per-app capture needs Windows 10 version 2004 (build 19041) or newer.");
    return 2;
  }

  ComPtr<IMMDeviceEnumerator> enumr;
  auto watcher = Microsoft::WRL::Make<DeviceWatcher>(deviceChanged);
  if (mode == Mode::System &&
      SUCCEEDED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&enumr)))) {
    enumr->RegisterEndpointNotificationCallback(watcher.Get());
  }

  DWORD taskIndex = 0;
  HANDLE mmcss = AvSetMmThreadCharacteristicsW(L"Pro Audio", &taskIndex);

  LARGE_INTEGER qpf, qpcStart, qpcNow;
  QueryPerformanceFrequency(&qpf);
  QueryPerformanceCounter(&qpcStart);
  int64_t framesWritten = 0;
  std::vector<int16_t> pcm;
  pcm.reserve(kOutRate);
  int exitCode = 0;
  int failures = 0;

  auto padSilence = [&]() -> bool {
    QueryPerformanceCounter(&qpcNow);
    int64_t expected = (qpcNow.QuadPart - qpcStart.QuadPart) * kOutRate / qpf.QuadPart;
    int64_t lag = expected - framesWritten;
    if (lag > kOutRate * 60 / 1000) {  // nothing delivered for > 60 ms
      int64_t fill = lag - kOutRate * 20 / 1000;
      std::vector<int16_t> zeros((size_t)fill * kOutChannels, 0);
      if (!WriteOut(zeros.data(), zeros.size() * sizeof(int16_t))) return false;
      framesWritten += fill;
    }
    return true;
  };

  bool running = true;
  while (running) {
    Opened o;
    HRESULT hr = mode == Mode::System ? OpenSystem(o)
                                      : OpenProcessLoopback(o, pid, mode == Mode::SystemExclude, audioEvent);
    if (SUCCEEDED(hr)) hr = o.client->Start();
    if (FAILED(hr)) {
      EmitError("open_failed", hr, "Could not open the audio stream.");
      if (mode != Mode::System || ++failures >= 10) {
        exitCode = 2;
        break;
      }
      // The default device may be switching; keep the timeline alive and retry.
      if (WaitForSingleObject(g_stop, 500) == WAIT_OBJECT_0) break;
      if (!padSilence()) {
        exitCode = 4;
        break;
      }
      continue;
    }
    failures = 0;
    Emit("{\"event\":\"ready\",\"mode\":" +
         JsonStr(std::string(mode == Mode::System ? "system" : mode == Mode::Process ? "process" : "system-exclude")) +
         ",\"device\":" + JsonStr(o.device) + ",\"rate\":48000,\"channels\":2,\"format\":\"s16le\"}");

    HANDLE handles[4];
    DWORD nh = 0;
    handles[nh++] = g_stop;
    const DWORD idxTarget = target ? nh : MAXDWORD;
    if (target) handles[nh++] = target;
    const DWORD idxDevice = mode == Mode::System ? nh : MAXDWORD;
    if (mode == Mode::System) handles[nh++] = deviceChanged;
    if (o.eventDriven) handles[nh++] = audioEvent;

    bool reopen = false;
    while (!reopen) {
      DWORD w = WaitForMultipleObjects(nh, handles, FALSE, o.eventDriven ? 20 : 5);
      if (w == WAIT_OBJECT_0) {
        running = false;
        break;
      }
      if (w == WAIT_OBJECT_0 + idxTarget) {
        Emit("{\"event\":\"source-ended\",\"pid\":" + std::to_string(pid) + "}");
        exitCode = 3;
        running = false;
        break;
      }
      if (w == WAIT_OBJECT_0 + idxDevice) {
        Emit("{\"event\":\"device-changed\"}");
        reopen = true;
        break;
      }

      UINT32 packet = 0;
      while (SUCCEEDED(hr = o.capture->GetNextPacketSize(&packet)) && packet > 0) {
        BYTE* data = nullptr;
        UINT32 frames = 0;
        DWORD flags = 0;
        hr = o.capture->GetBuffer(&data, &frames, &flags, nullptr, nullptr);
        if (FAILED(hr)) break;
        pcm.clear();
        if (flags & AUDCLNT_BUFFERFLAGS_SILENT) {
          // Converted length is frames * 48000 / rate; silence of that size.
          Converter tmp = o.conv;
          std::vector<BYTE> zeros((size_t)frames * 64, 0);
          tmp.Convert(zeros.data(), frames, pcm);
          std::fill(pcm.begin(), pcm.end(), (int16_t)0);
        } else {
          o.conv.Convert(data, frames, pcm);
        }
        o.capture->ReleaseBuffer(frames);
        if (!pcm.empty()) {
          if (!WriteOut(pcm.data(), pcm.size() * sizeof(int16_t))) break;
          framesWritten += (int64_t)(pcm.size() / kOutChannels);
        }
      }
      if (g_outputBroken) {
        exitCode = 4;
        running = false;
        break;
      }
      if (hr == AUDCLNT_E_DEVICE_INVALIDATED || hr == AUDCLNT_E_SERVICE_NOT_RUNNING) {
        Emit("{\"event\":\"device-changed\"}");
        reopen = true;
        break;
      }
      if (FAILED(hr)) {
        EmitError("capture_failed", hr, "Audio capture stopped unexpectedly.");
        if (mode == Mode::System) {
          reopen = true;
          break;
        }
        exitCode = 2;
        running = false;
        break;
      }
      if (!padSilence()) {
        exitCode = 4;
        running = false;
        break;
      }
    }
    o.client->Stop();
  }

  if (enumr) enumr->UnregisterEndpointNotificationCallback(watcher.Get());
  if (mmcss) AvRevertMmThreadCharacteristics(mmcss);
  if (target) CloseHandle(target);
  Emit("{\"event\":\"stopped\",\"code\":" + std::to_string(exitCode) + "}");
  return exitCode;
}

}  // namespace

int wmain(int argc, wchar_t** argv) {
  HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  if (FAILED(hr)) return 2;
  int rc = 1;
  std::wstring cmd = argc > 1 ? argv[1] : L"";
  if (cmd == L"list") {
    rc = RunList();
  } else if (cmd == L"capture") {
    Mode mode = Mode::System;
    DWORD pid = 0;
    bool haveMode = false;
    for (int i = 2; i < argc; i++) {
      std::wstring a = argv[i];
      if (a == L"--system") {
        haveMode = true;
      } else if ((a == L"--pid" || a == L"--exclude-pid") && i + 1 < argc) {
        pid = (DWORD)wcstoul(argv[++i], nullptr, 10);
        mode = a == L"--pid" ? Mode::Process : Mode::SystemExclude;
        haveMode = true;
      }
    }
    if (!haveMode || (mode != Mode::System && pid == 0)) {
      EmitError("usage", E_INVALIDARG, "capture needs --system, --pid <pid> or --system --exclude-pid <pid>");
    } else {
      rc = RunCapture(mode, pid);
    }
  } else {
    fprintf(stderr, "usage: syncwave-capture list | capture --system [--exclude-pid N] | capture --pid N\n");
  }
  CoUninitialize();
  return rc;
}
