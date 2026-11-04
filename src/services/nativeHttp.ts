import { Platform } from "react-native";

export interface HttpResponse {
  status: number;
  body: string;
}

async function getNativeModule(): Promise<any | null> {
  if (Platform.OS !== "android") return null;
  try {
    const { PcmRecorder } = await import("../../modules/pcm-recorder/src");
    return PcmRecorder as any;
  } catch {
    return null;
  }
}

// Android 走原生 OkHttp（IPv4 优先），避免不可达 IPv6 导致请求一直挂起
export async function postJson(
  url: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs = 30000,
): Promise<HttpResponse> {
  const native = await getNativeModule();
  if (native?.httpPostJson) {
    return await native.httpPostJson(url, headers, body, timeoutMs);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json", ...headers },
      body,
    });
    return { status: response.status, body: await response.text() };
  } finally {
    clearTimeout(timer);
  }
}

export async function postMultipart(
  url: string,
  headers: Record<string, string>,
  fields: Record<string, string>,
  file: { path: string; name: string; mimeType: string },
  timeoutMs = 110000,
): Promise<HttpResponse> {
  const native = await getNativeModule();
  if (native?.httpPostMultipart) {
    return await native.httpPostMultipart(url, headers, fields, file.path, file.name, file.mimeType, timeoutMs);
  }
  throw new Error("multipart_upload_unsupported");
}
