// Which Chrome the headless harnesses start, and the flags it needs for a hardware WebGPU adapter
// on this platform. CHROME=… overrides the binary.

import { platform } from "node:process";

export const chromeBinary = process.env.CHROME ?? (
  platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  : platform === "win32" ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
  : "google-chrome");

// Linux: no WebGPU adapter without Vulkan, and headless falls back to SwiftShader (software)
// unless ANGLE runs on Vulkan too. macOS (Metal) and Windows (D3D12) need neither.
export const chromeGpuFlags = platform === "linux" ? ["--enable-features=Vulkan", "--use-angle=vulkan"] : [];
