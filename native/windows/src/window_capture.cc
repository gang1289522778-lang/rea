#include "authority.hpp"

#include <cmath>
#include <cstring>
#include <limits>
#include <objbase.h>
#include <objidl.h>
#include <wincodec.h>

namespace rea {

namespace {

constexpr DWORD CAPTURE_TIMEOUT_MS = 5000;
constexpr uint64_t MAX_SOURCE_PIXELS = 4ULL * 1024ULL * 1024ULL;
constexpr size_t MAX_PNG_BYTES = 3ULL * 1024ULL * 1024ULL;

class ComApartment {
 public:
  ComApartment() {
    const auto result = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    if (result == S_OK || result == S_FALSE) owns_ = true;
    else if (result != RPC_E_CHANGED_MODE)
      throw Failure("Initialize Windows image encoder failed", L"", static_cast<DWORD>(result));
  }
  ~ComApartment() {
    if (owns_) CoUninitialize();
  }

 private:
  bool owns_ = false;
};

template <typename T>
class ComPointer {
 public:
  ComPointer() = default;
  ~ComPointer() { reset(); }
  ComPointer(const ComPointer&) = delete;
  ComPointer& operator=(const ComPointer&) = delete;
  T* get() const { return value_; }
  T** out() {
    reset();
    return &value_;
  }
  void reset(T* next = nullptr) {
    if (value_ != nullptr) value_->Release();
    value_ = next;
  }

 private:
  T* value_ = nullptr;
};

/** Fixed-capacity IStream prevents a WIC encoder from growing an unbounded HGLOBAL. */
class FixedMemoryStream final : public IStream {
 public:
  explicit FixedMemoryStream(std::vector<BYTE>& buffer) : buffer_(buffer) {}

  STDMETHODIMP QueryInterface(REFIID iid, void** result) override {
    if (result == nullptr) return E_POINTER;
    *result = nullptr;
    if (IsEqualIID(iid, IID_IUnknown) || IsEqualIID(iid, IID_ISequentialStream) ||
        IsEqualIID(iid, IID_IStream)) {
      *result = static_cast<IStream*>(this);
      AddRef();
      return S_OK;
    }
    return E_NOINTERFACE;
  }

  STDMETHODIMP_(ULONG) AddRef() override { return references_.fetch_add(1) + 1; }

  STDMETHODIMP_(ULONG) Release() override {
    const ULONG remaining = references_.fetch_sub(1) - 1;
    if (remaining == 0) delete this;
    return remaining;
  }

  STDMETHODIMP Read(void* target, ULONG requested, ULONG* observed) override {
    if (observed != nullptr) *observed = 0;
    if (target == nullptr && requested != 0) return STG_E_INVALIDPOINTER;
    const size_t available = position_ >= size_ ? 0 : size_ - position_;
    const size_t count = std::min(available, static_cast<size_t>(requested));
    if (count != 0) std::memcpy(target, buffer_.data() + position_, count);
    position_ += count;
    if (observed != nullptr) *observed = static_cast<ULONG>(count);
    return count == requested ? S_OK : S_FALSE;
  }

  STDMETHODIMP Write(const void* source, ULONG requested, ULONG* observed) override {
    if (observed != nullptr) *observed = 0;
    if (source == nullptr && requested != 0) return STG_E_INVALIDPOINTER;
    const size_t count = static_cast<size_t>(requested);
    if (position_ > buffer_.size() || count > buffer_.size() - position_)
      return STG_E_MEDIUMFULL;
    if (count != 0) std::memcpy(buffer_.data() + position_, source, count);
    position_ += count;
    size_ = std::max(size_, position_);
    if (observed != nullptr) *observed = requested;
    return S_OK;
  }

  STDMETHODIMP Seek(LARGE_INTEGER move, DWORD origin, ULARGE_INTEGER* observed) override {
    const LONGLONG base = origin == STREAM_SEEK_SET ? 0
                        : origin == STREAM_SEEK_CUR ? static_cast<LONGLONG>(position_)
                        : origin == STREAM_SEEK_END ? static_cast<LONGLONG>(size_)
                        : -1;
    if (base < 0) return STG_E_INVALIDFUNCTION;
    const LONGLONG delta = move.QuadPart;
    if ((delta > 0 && base > std::numeric_limits<LONGLONG>::max() - delta) ||
        (delta < 0 && base < std::numeric_limits<LONGLONG>::min() - delta))
      return STG_E_INVALIDFUNCTION;
    const LONGLONG next = base + delta;
    if (next < 0 || static_cast<ULONGLONG>(next) > buffer_.size())
      return STG_E_MEDIUMFULL;
    position_ = static_cast<size_t>(next);
    if (observed != nullptr) observed->QuadPart = position_;
    return S_OK;
  }

  STDMETHODIMP SetSize(ULARGE_INTEGER requested) override {
    if (requested.QuadPart > buffer_.size()) return STG_E_MEDIUMFULL;
    size_ = static_cast<size_t>(requested.QuadPart);
    position_ = std::min(position_, size_);
    return S_OK;
  }

  STDMETHODIMP CopyTo(IStream* destination, ULARGE_INTEGER requested,
                      ULARGE_INTEGER* read, ULARGE_INTEGER* written) override {
    if (read != nullptr) read->QuadPart = 0;
    if (written != nullptr) written->QuadPart = 0;
    if (destination == nullptr) return STG_E_INVALIDPOINTER;
    const size_t count = std::min(
        position_ >= size_ ? 0 : size_ - position_,
        requested.QuadPart > std::numeric_limits<size_t>::max()
            ? buffer_.size()
            : static_cast<size_t>(requested.QuadPart));
    ULONG copied = 0;
    const HRESULT result = destination->Write(buffer_.data() + position_, static_cast<ULONG>(count), &copied);
    position_ += copied;
    if (read != nullptr) read->QuadPart = copied;
    if (written != nullptr) written->QuadPart = copied;
    return result;
  }

  STDMETHODIMP Commit(DWORD) override { return S_OK; }
  STDMETHODIMP Revert() override { return E_NOTIMPL; }
  STDMETHODIMP LockRegion(ULARGE_INTEGER, ULARGE_INTEGER, DWORD) override { return STG_E_INVALIDFUNCTION; }
  STDMETHODIMP UnlockRegion(ULARGE_INTEGER, ULARGE_INTEGER, DWORD) override { return STG_E_INVALIDFUNCTION; }

  STDMETHODIMP Stat(STATSTG* observed, DWORD) override {
    if (observed == nullptr) return STG_E_INVALIDPOINTER;
    std::memset(observed, 0, sizeof(*observed));
    observed->type = STGTY_STREAM;
    observed->cbSize.QuadPart = size_;
    observed->grfMode = STGM_READWRITE;
    return S_OK;
  }

  STDMETHODIMP Clone(IStream**) override { return E_NOTIMPL; }

  size_t size() const { return size_; }

 private:
  std::atomic<ULONG> references_{1};
  std::vector<BYTE>& buffer_;
  size_t position_ = 0;
  size_t size_ = 0;
};

class DeviceContext {
 public:
  DeviceContext() : value_(CreateCompatibleDC(nullptr)) {
    require(value_ != nullptr, "Create selected-window capture surface failed");
  }
  ~DeviceContext() {
    if (value_ != nullptr) DeleteDC(value_);
  }
  DeviceContext(const DeviceContext&) = delete;
  DeviceContext& operator=(const DeviceContext&) = delete;
  HDC get() const { return value_; }

 private:
  HDC value_ = nullptr;
};

class Bitmap {
 public:
  Bitmap(int width, int height) {
    const uint64_t byteCount = static_cast<uint64_t>(width) * static_cast<uint64_t>(height) * 4ULL;
    require(byteCount <= std::numeric_limits<size_t>::max(), "Selected-window bitmap exceeds memory limits", L"",
            ERROR_NOT_ENOUGH_MEMORY);
    bytes_ = static_cast<size_t>(byteCount);
    BITMAPINFO description{};
    description.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
    description.bmiHeader.biWidth = width;
    description.bmiHeader.biHeight = -height;
    description.bmiHeader.biPlanes = 1;
    description.bmiHeader.biBitCount = 32;
    description.bmiHeader.biCompression = BI_RGB;
    value_ = CreateDIBSection(nullptr, &description, DIB_RGB_COLORS, &pixels_, nullptr, 0);
    require(value_ != nullptr && pixels_ != nullptr, "Create selected-window bitmap failed");
    std::memset(pixels_, 0, bytes_);
  }
  ~Bitmap() {
    if (value_ != nullptr) DeleteObject(value_);
  }
  Bitmap(const Bitmap&) = delete;
  Bitmap& operator=(const Bitmap&) = delete;
  HBITMAP get() const { return value_; }
  void* pixels() const { return pixels_; }
  void setOpaqueAlpha() const {
    auto* bytes = static_cast<BYTE*>(pixels_);
    for (size_t index = 3; index < bytes_; index += 4) bytes[index] = 0xff;
  }

 private:
  HBITMAP value_ = nullptr;
  void* pixels_ = nullptr;
  size_t bytes_ = 0;
};

class SelectedObject {
 public:
  SelectedObject(HDC dc, HGDIOBJ object) : dc_(dc), previous_(SelectObject(dc, object)) {
    require(previous_ != nullptr && previous_ != HGDI_ERROR, "Select selected-window bitmap failed");
  }
  ~SelectedObject() {
    if (previous_ != nullptr && previous_ != HGDI_ERROR) SelectObject(dc_, previous_);
  }
  SelectedObject(const SelectedObject&) = delete;
  SelectedObject& operator=(const SelectedObject&) = delete;

 private:
  HDC dc_;
  HGDIOBJ previous_;
};

void checkHr(HRESULT result, const char* constraint) {
  require(SUCCEEDED(result), constraint, L"", static_cast<DWORD>(result));
}

DWORD positiveDword(napi_env env, napi_value value, const char* constraint) {
  const auto candidate = numeric(env, value);
  require(std::isfinite(candidate) && std::floor(candidate) == candidate && candidate >= 1 &&
              candidate <= static_cast<double>(std::numeric_limits<DWORD>::max()),
          constraint, L"", ERROR_INVALID_PARAMETER);
  return static_cast<DWORD>(candidate);
}

int positiveDimension(napi_env env, napi_value value) {
  const auto candidate = numeric(env, value);
  require(std::isfinite(candidate) && std::floor(candidate) == candidate && candidate >= 1 &&
              candidate <= 4096,
          "Selected-window dimension limit is invalid", L"", ERROR_INVALID_PARAMETER);
  return static_cast<int>(candidate);
}

ULONG_PTR parseWindowHandle(const std::wstring& text) {
  require(text.size() > 2 && text[0] == L'0' && text[1] == L'x',
          "Window handle must be canonical lowercase hexadecimal", text, ERROR_INVALID_PARAMETER);
  require(text.size() == 3 || text[2] != L'0',
          "Window handle must not contain leading zeroes", text, ERROR_INVALID_PARAMETER);
  ULONG_PTR result = 0;
  for (size_t index = 2; index < text.size(); ++index) {
    const wchar_t character = text[index];
    const ULONG_PTR nibble = character >= L'0' && character <= L'9'
                                 ? static_cast<ULONG_PTR>(character - L'0')
                                 : character >= L'a' && character <= L'f'
                                     ? static_cast<ULONG_PTR>(character - L'a' + 10)
                                     : std::numeric_limits<ULONG_PTR>::max();
    require(nibble != std::numeric_limits<ULONG_PTR>::max(),
            "Window handle must be canonical lowercase hexadecimal", text, ERROR_INVALID_PARAMETER);
    require(result <= (std::numeric_limits<ULONG_PTR>::max() - nibble) / 16,
            "Window handle exceeds the native pointer range", text, ERROR_INVALID_PARAMETER);
    result = result * 16 + nibble;
  }
  require(result != 0, "Window handle must not be zero", text, ERROR_INVALID_PARAMETER);
  return result;
}

std::wstring hexHandle(ULONG_PTR value) {
  const wchar_t digits[] = L"0123456789abcdef";
  std::wstring rendered;
  do {
    rendered.push_back(digits[value & 0xf]);
    value >>= 4;
  } while (value != 0);
  std::reverse(rendered.begin(), rendered.end());
  return L"0x" + rendered;
}

Handle openProcessForCapture(DWORD pid) {
  Handle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, pid));
  require(process.valid(), "Open selected process for window identity failed", L"", GetLastError());
  return process;
}

std::wstring processImagePath(HANDLE process) {
  std::vector<wchar_t> buffer(32768);
  DWORD size = static_cast<DWORD>(buffer.size());
  require(QueryFullProcessImageNameW(process, 0, buffer.data(), &size) != FALSE,
          "Read selected process executable path failed");
  require(size > 0 && size < buffer.size(), "Selected process executable path is invalid", L"",
          ERROR_INVALID_DATA);
  return std::wstring(buffer.data(), size);
}

uint64_t processStartTimeToken(HANDLE process) {
  FILETIME created{}, exited{}, kernel{}, user{};
  require(GetProcessTimes(process, &created, &exited, &kernel, &user) != FALSE,
          "Read selected process start time failed");
  ULARGE_INTEGER value{};
  value.LowPart = created.dwLowDateTime;
  value.HighPart = created.dwHighDateTime;
  return value.QuadPart;
}

double processStartTimeMs(uint64_t token) {
  constexpr uint64_t WINDOWS_TO_UNIX_EPOCH_100NS = 116444736000000000ULL;
  require(token >= WINDOWS_TO_UNIX_EPOCH_100NS,
          "Selected process start time precedes the Unix epoch", L"", ERROR_INVALID_DATA);
  return static_cast<double>((token - WINDOWS_TO_UNIX_EPOCH_100NS) / 10000ULL);
}

Handle validateProcessIdentity(DWORD pid, uint64_t startToken, const std::wstring& imagePath) {
  auto process = openProcessForCapture(pid);
  require(processStartTimeToken(process.get()) == startToken && processImagePath(process.get()) == imagePath,
          "Selected process identity changed during capture", L"", ERROR_INVALID_HANDLE,
          FailureKind::ProcessIdentityMismatch);
  const DWORD status = WaitForSingleObject(process.get(), 0);
  require(status != WAIT_FAILED, "Read selected process liveness failed");
  require(status == WAIT_TIMEOUT, "Selected process exited before capture settled", L"", ERROR_INVALID_HANDLE,
          FailureKind::ProcessIdentityMismatch);
  return process;
}

std::wstring windowTitle(HWND window) {
  const int length = GetWindowTextLengthW(window);
  require(length >= 0 && length <= 32767, "Selected window title length is invalid", L"", ERROR_INVALID_DATA);
  std::vector<wchar_t> buffer(static_cast<size_t>(length) + 1);
  const int copied = GetWindowTextW(window, buffer.data(), static_cast<int>(buffer.size()));
  require(copied >= 0 && copied <= length, "Read selected window title failed");
  return std::wstring(buffer.data(), static_cast<size_t>(copied));
}

void validateWindowOwner(HWND window, DWORD expectedPid) {
  require(IsWindow(window) != FALSE, "Selected window no longer exists", L"", ERROR_INVALID_WINDOW_HANDLE);
  DWORD observedPid = 0;
  require(GetWindowThreadProcessId(window, &observedPid) != 0, "Read selected window owner failed");
  require(observedPid == expectedPid, "Selected window belongs to a different process", L"",
          ERROR_ACCESS_DENIED, FailureKind::WindowOwnerMismatch);
}

std::vector<BYTE> pngFromDib(int sourceWidth, int sourceHeight, void* pixels,
                      int maximumDimension) {
  const uint64_t sourceBytes = static_cast<uint64_t>(sourceWidth) * static_cast<uint64_t>(sourceHeight) * 4ULL;
  require(sourceBytes <= static_cast<uint64_t>(std::numeric_limits<UINT>::max()),
          "Selected-window bitmap exceeds encoder limits", L"", ERROR_NOT_ENOUGH_MEMORY);

  ComApartment apartment;
  ComPointer<IWICImagingFactory> factory;
  checkHr(CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER,
                            IID_IWICImagingFactory, reinterpret_cast<void**>(factory.out())),
          "Create Windows image encoder failed");
  ComPointer<IWICBitmap> bitmap;
  checkHr(factory.get()->CreateBitmapFromMemory(
              static_cast<UINT>(sourceWidth), static_cast<UINT>(sourceHeight), GUID_WICPixelFormat32bppBGRA,
              static_cast<UINT>(sourceWidth * 4), static_cast<UINT>(sourceBytes),
              static_cast<BYTE*>(pixels), bitmap.out()),
          "Create selected-window image failed");

  const int longest = std::max(sourceWidth, sourceHeight);
  const double scale = longest <= maximumDimension ? 1.0 : static_cast<double>(maximumDimension) / longest;
  const int width = std::max(1, static_cast<int>(std::floor(sourceWidth * scale)));
  const int height = std::max(1, static_cast<int>(std::floor(sourceHeight * scale)));
  IWICBitmapSource* source = bitmap.get();
  ComPointer<IWICBitmapScaler> scaler;
  if (width != sourceWidth || height != sourceHeight) {
    checkHr(factory.get()->CreateBitmapScaler(scaler.out()), "Create selected-window image scaler failed");
    checkHr(scaler.get()->Initialize(source, static_cast<UINT>(width), static_cast<UINT>(height),
                                     WICBitmapInterpolationModeFant),
            "Scale selected-window image failed");
    source = scaler.get();
  }

  std::vector<BYTE> encoded(MAX_PNG_BYTES);
  size_t byteCount = 0;
  {
    auto* fixedStream = new FixedMemoryStream(encoded);
    ComPointer<IStream> stream;
    stream.reset(fixedStream);
    ComPointer<IWICBitmapEncoder> encoder;
    checkHr(factory.get()->CreateEncoder(GUID_ContainerFormatPng, nullptr, encoder.out()),
            "Create selected-window PNG encoder failed");
    checkHr(encoder.get()->Initialize(stream.get(), WICBitmapEncoderNoCache),
            "Initialize selected-window PNG encoder failed");
    ComPointer<IWICBitmapFrameEncode> frame;
    ComPointer<IPropertyBag2> options;
    checkHr(encoder.get()->CreateNewFrame(frame.out(), options.out()), "Create selected-window PNG frame failed");
    checkHr(frame.get()->Initialize(options.get()), "Initialize selected-window PNG frame failed");
    checkHr(frame.get()->SetSize(static_cast<UINT>(width), static_cast<UINT>(height)),
            "Set selected-window PNG dimensions failed");
    WICPixelFormatGUID format = GUID_WICPixelFormat32bppBGRA;
    checkHr(frame.get()->SetPixelFormat(&format), "Set selected-window PNG format failed");
    checkHr(frame.get()->WriteSource(source, nullptr), "Write selected-window PNG pixels failed");
    checkHr(frame.get()->Commit(), "Commit selected-window PNG frame failed");
    checkHr(encoder.get()->Commit(), "Commit selected-window PNG failed");

    byteCount = fixedStream->size();
    require(byteCount > 0 && byteCount <= MAX_PNG_BYTES,
            "Selected-window PNG exceeds the retained byte limit", L"", ERROR_NOT_ENOUGH_MEMORY);
  }  // Release the encoder and stream before moving their backing bytes.
  encoded.resize(byteCount);
  return encoded;
}

struct CaptureControl {
  std::atomic<bool> cancelled{false};
  // This handle is accessed only on the JavaScript thread. The worker reads
  // only the atomic flag, so completion can invalidate the handle safely.
  napi_async_work work = nullptr;
};

struct WindowImage {
  DWORD pid = 0;
  ULONG_PTR windowHandle = 0;
  std::wstring imagePath;
  double startTimeMs = 0;
  std::wstring title;
  int sourceWidth = 0;
  int sourceHeight = 0;
  int width = 0;
  int height = 0;
  std::vector<BYTE> png;
};

void checkCaptureCancellation(const CaptureControl& control) {
  require(!control.cancelled.load(), "Selected-window capture was cancelled", L"", ERROR_OPERATION_ABORTED);
}

Handle openCaptureExecutable(const std::wstring& path) {
  Handle file(CreateFileW(path.c_str(), GENERIC_READ | FILE_READ_ATTRIBUTES, FILE_SHARE_READ,
                          nullptr, OPEN_EXISTING, FILE_FLAG_SEQUENTIAL_SCAN, nullptr));
  require(file.valid(), "Open executable for window admission failed", path);
  require(GetFileType(file.get()) == FILE_TYPE_DISK, "Executable is not a disk file", path,
          ERROR_NOT_SUPPORTED);
  return file;
}

void authorizeCaptureExecutable(HANDLE target, HANDLE processImage, const std::wstring& path,
                                const std::wstring& expectedSha256, const std::wstring& expectedFileIdentity,
                                const CaptureControl& control) {
  BY_HANDLE_FILE_INFORMATION nodeIdentity{};
  require(GetFileInformationByHandle(target, &nodeIdentity), "Read executable stat identity failed", path);
  const uint64_t index = (static_cast<uint64_t>(nodeIdentity.nFileIndexHigh) << 32) | nodeIdentity.nFileIndexLow;
  require(std::to_wstring(nodeIdentity.dwVolumeSerialNumber) + L":" + std::to_wstring(index) == expectedFileIdentity,
          "Active executable identity changed before capture", path, ERROR_INVALID_HANDLE,
          FailureKind::ArtifactChanged);
  FILE_ID_INFO expected{}, observed{};
  require(GetFileInformationByHandleEx(target, FileIdInfo, &expected, sizeof(expected)) &&
          GetFileInformationByHandleEx(processImage, FileIdInfo, &observed, sizeof(observed)),
          "Read capture executable identity failed", path);
  require(expected.VolumeSerialNumber == observed.VolumeSerialNumber &&
          std::memcmp(expected.FileId.Identifier, observed.FileId.Identifier, sizeof(expected.FileId.Identifier)) == 0,
          "Selected process does not execute the active target file", path, ERROR_ACCESS_DENIED,
          FailureKind::ProcessIdentityMismatch);
  LARGE_INTEGER size{};
  require(GetFileSizeEx(target, &size), "Read executable size failed", path);
  require(size.QuadPart >= 0 && size.QuadPart <= 256LL * 1024LL * 1024LL,
          "Executable exceeds the capture admission budget", path, ERROR_NOT_ENOUGH_MEMORY);
  Sha256Hash hash(path);
  std::array<unsigned char, 65536> buffer;
  LONGLONG remaining = size.QuadPart;
  while (remaining > 0) {
    checkCaptureCancellation(control);
    DWORD count = 0;
    require(ReadFile(target, buffer.data(), static_cast<DWORD>(std::min<LONGLONG>(remaining, buffer.size())),
                     &count, nullptr), "Read capture executable bytes failed", path);
    require(count > 0, "Executable ended before its declared size", path, ERROR_READ_FAULT);
    hash.update(buffer.data(), count);
    remaining -= count;
  }
  const auto digest = hash.finish();
  constexpr wchar_t digits[] = L"0123456789abcdef";
  std::wstring sha256;
  for (const auto byte : digest) {
    sha256.push_back(digits[byte >> 4]);
    sha256.push_back(digits[byte & 15]);
  }
  require(sha256 == expectedSha256, "Active executable bytes changed before capture", path, ERROR_INVALID_DATA,
          FailureKind::ArtifactChanged);
}

WindowImage captureWindow(DWORD pid, ULONG_PTR handle, int maximumDimension,
                          const std::wstring& targetPath, const std::wstring& targetSha256,
                          const std::wstring& targetFileIdentity, const CaptureControl& control) {
  const HWND window = reinterpret_cast<HWND>(handle);
  checkCaptureCancellation(control);
  validateWindowOwner(window, pid);
  auto process = openProcessForCapture(pid);
  const uint64_t startToken = processStartTimeToken(process.get());
  const std::wstring imagePath = processImagePath(process.get());
  // Read-only, non-write/delete-sharing handles pin the authorized file bytes
  // and identity through the paint request. No target handler runs first.
  auto targetFile = openCaptureExecutable(targetPath);
  auto processFile = openCaptureExecutable(imagePath);
  authorizeCaptureExecutable(targetFile.get(), processFile.get(), targetPath,
                             targetSha256, targetFileIdentity, control);
  const double startTimeMs = processStartTimeMs(startToken);
  const std::wstring title = windowTitle(window);
  RECT bounds{};
  require(GetClientRect(window, &bounds) != FALSE, "Read selected window client bounds failed");
  const int width = bounds.right - bounds.left;
  const int height = bounds.bottom - bounds.top;
  require(width > 0 && height > 0 && static_cast<uint64_t>(width) * static_cast<uint64_t>(height) <= MAX_SOURCE_PIXELS,
          "Selected window client area exceeds the capture limit", L"", ERROR_NOT_ENOUGH_MEMORY);

  DeviceContext dc;
  Bitmap bitmap(width, height);
  SelectedObject selected(dc.get(), bitmap.get());
  DWORD_PTR ignored = 0;
  const UINT flags = PRF_CLIENT | PRF_ERASEBKGND;
  checkCaptureCancellation(control);
  validateWindowOwner(window, pid);
  // Keep the revalidated process object alive through rendering and encoding.
  auto paintProcess = validateProcessIdentity(pid, startToken, imagePath);
  const LRESULT delivered = SendMessageTimeoutW(window, WM_PRINT,
                                                 reinterpret_cast<WPARAM>(dc.get()), flags,
                                                 SMTO_ABORTIFHUNG | SMTO_BLOCK, CAPTURE_TIMEOUT_MS, &ignored);
  checkCaptureCancellation(control);
  require(delivered != 0, "Selected window did not render within the capture deadline", L"",
          GetLastError() == ERROR_SUCCESS ? ERROR_TIMEOUT : GetLastError());
  require(GdiFlush() != FALSE, "Flush selected-window drawing commands failed");
  bitmap.setOpaqueAlpha();
  validateWindowOwner(window, pid);
  auto observedProcess = validateProcessIdentity(pid, startToken, imagePath);
  const int longest = std::max(width, height);
  const double scale = longest <= maximumDimension ? 1.0 : static_cast<double>(maximumDimension) / longest;
  const int renderedWidth = std::max(1, static_cast<int>(std::floor(width * scale)));
  const int renderedHeight = std::max(1, static_cast<int>(std::floor(height * scale)));

  checkCaptureCancellation(control);
  auto png = pngFromDib(width, height, bitmap.pixels(), maximumDimension);
  checkCaptureCancellation(control);
  return {pid, handle, imagePath, startTimeMs, title, width, height,
          renderedWidth, renderedHeight, std::move(png)};
}

struct CaptureWork {
  std::shared_ptr<CaptureControl> control = std::make_shared<CaptureControl>();
  napi_deferred deferred = nullptr;
  DWORD pid = 0;
  ULONG_PTR windowHandle = 0;
  int maximumDimension = 0;
  std::wstring targetPath;
  std::wstring targetSha256;
  std::wstring targetFileIdentity;
  WindowImage image;
  std::unique_ptr<Failure> failure;
};

void executeCapture(napi_env, void* pointer) {
  auto& work = *static_cast<CaptureWork*>(pointer);
  try {
    // All Win32, GDI and COM resources live and unwind on this worker thread.
    // No N-API values or JavaScript handles are accessed here.
    work.image = captureWindow(work.pid, work.windowHandle, work.maximumDimension,
                               work.targetPath, work.targetSha256, work.targetFileIdentity, *work.control);
  } catch (const Failure& failure) {
    work.failure = std::make_unique<Failure>(failure);
  } catch (const std::exception& failure) {
    work.failure = std::make_unique<Failure>(failure.what(), L"", ERROR_GEN_FAILURE);
  }
}

napi_value serializeCapture(napi_env env, const WindowImage& image) {
  auto result = object(env);
  set(env, result, "pid", number(env, image.pid));
  set(env, result, "window_handle", string(env, hexHandle(image.windowHandle)));
  set(env, result, "process_image_path", string(env, image.imagePath));
  set(env, result, "process_start_time_unix_ms", number(env, image.startTimeMs));
  set(env, result, "title", string(env, image.title));
  set(env, result, "source_width", number(env, image.sourceWidth));
  set(env, result, "source_height", number(env, image.sourceHeight));
  set(env, result, "width", number(env, image.width));
  set(env, result, "height", number(env, image.height));
  napi_value png;
  check(napi_create_buffer_copy(env, image.png.size(), image.png.data(), nullptr, &png));
  set(env, result, "png", png);
  return result;
}

void completeCapture(napi_env env, napi_status status, void* pointer) {
  std::unique_ptr<CaptureWork> work(static_cast<CaptureWork*>(pointer));
  const auto handle = work->control->work;
  work->control->work = nullptr;
  try {
    if (status != napi_ok || work->control->cancelled.load())
      napi_reject_deferred(env, work->deferred, failureValue(env,
          Failure("Selected-window capture was cancelled", L"", ERROR_OPERATION_ABORTED)));
    else if (work->failure)
      napi_reject_deferred(env, work->deferred, failureValue(env, *work->failure));
    else
      napi_resolve_deferred(env, work->deferred, serializeCapture(env, work->image));
  } catch (const Failure& failure) {
    napi_reject_deferred(env, work->deferred, failureValue(env, failure));
  } catch (const std::exception& failure) {
    napi_reject_deferred(env, work->deferred, failureValue(env,
        Failure(failure.what(), L"", ERROR_GEN_FAILURE)));
  }
  napi_delete_async_work(env, handle);
}

napi_value cancelCapture(napi_env env, napi_callback_info info) {
  void* data = nullptr;
  size_t count = 0;
  if (napi_get_cb_info(env, info, &count, nullptr, nullptr, &data) != napi_ok) return nullptr;
  auto& control = **static_cast<std::shared_ptr<CaptureControl>*>(data);
  control.cancelled.store(true);
  // A queued work item can be cancelled. Running WM_PRINT is non-interruptible
  // but bounded by CAPTURE_TIMEOUT_MS; it retains its surface until it returns.
  if (control.work != nullptr) napi_cancel_async_work(env, control.work);
  return null(env);
}

void releaseCaptureControl(napi_env, void* data, void*) {
  delete static_cast<std::shared_ptr<CaptureControl>*>(data);
}

}  // namespace

napi_value windowCaptureCall(napi_env env, const std::vector<napi_value>& args) {
  require(args.size() == 6, "Selected-window capture requires window inputs and active executable identity", L"",
          ERROR_INVALID_PARAMETER);
  auto work = std::make_unique<CaptureWork>();
  work->pid = positiveDword(env, args[0], "Selected process ID is invalid");
  work->windowHandle = parseWindowHandle(wide(env, args[1]));
  work->maximumDimension = positiveDimension(env, args[2]);
  work->targetPath = wide(env, args[3]);
  work->targetSha256 = wide(env, args[4]);
  work->targetFileIdentity = wide(env, args[5]);
  require(work->targetSha256.size() == 64 &&
          work->targetSha256.find_first_not_of(L"0123456789abcdef") == std::wstring::npos,
          "Active target SHA-256 is invalid", L"", ERROR_INVALID_PARAMETER);
  napi_value completion;
  check(napi_create_promise(env, &work->deferred, &completion));
  auto retained = std::make_unique<std::shared_ptr<CaptureControl>>(work->control);
  napi_value cancel;
  check(napi_create_function(env, "cancel", NAPI_AUTO_LENGTH, cancelCapture, retained.get(), &cancel));
  check(napi_add_finalizer(env, cancel, retained.get(), releaseCaptureControl, nullptr, nullptr));
  retained.release();
  auto result = object(env);
  set(env, result, "completion", completion);
  set(env, result, "cancel", cancel);
  try {
    check(napi_create_async_work(env, nullptr, string(env, std::string("REA selected-window capture")),
                                 executeCapture, completeCapture, work.get(), &work->control->work));
    check(napi_queue_async_work(env, work->control->work));
  } catch (...) {
    if (work->control->work != nullptr) napi_delete_async_work(env, work->control->work);
    work->control->work = nullptr;
    throw;
  }
  work.release();
  return result;
}

}  // namespace rea
