// Package installation layouts and launcher checks differ by host platform.
if (process.platform === "win32") {
  await import("./verify-windows-package.mjs");
} else {
  await import("./verify-package.mjs");
}
