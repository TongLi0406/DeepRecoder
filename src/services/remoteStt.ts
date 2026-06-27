import { File } from "expo-file-system";
import { debugLog } from "./debug";

const SILICONFLOW_STT_URL = "https://api.siliconflow.cn/v1/audio/transcriptions";

async function getApiKey(): Promise<string | null> {
  try {
    const { getSiliconFlowKey } = await import("./embedding");
    return await getSiliconFlowKey();
  } catch {
    return null;
  }
}

function isRetryable(error: string): boolean {
  return /network|timeout|timed out/i.test(error);
}

export async function transcribeRemote(
  audioUri: string,
): Promise<string> {
  const key = await getApiKey();
  if (!key) {
    throw new Error("No SiliconFlow API key configured");
  }

  const filePath = audioUri.startsWith("file://") ? audioUri : `file://${audioUri}`;
  const filename = filePath.split("/").pop() || "audio.wav";
  const lower = filename.toLowerCase();
  const mimeType = lower.endsWith(".m4a") ? "audio/mp4"
    : lower.endsWith(".mp4") ? "audio/mp4"
    : lower.endsWith(".3gp") ? "audio/3gpp"
    : "audio/wav";

  // Dynamic timeout: 1s per 500KB, min 60s, max 600s
  const wavFile = new File(filePath);
  const fileSize = wavFile.exists ? (wavFile.size ?? 0) : 0;
  const timeoutMs = fileSize > 0
    ? Math.max(60000, Math.min(600000, (fileSize / 500000) * 1000 + 30000))
    : 60000;
  debugLog(`[RemoteSTT] Uploading ${(fileSize / 1e6).toFixed(1)}MB, timeout=${(timeoutMs / 1000).toFixed(0)}s`);

  const doUpload = (attempt: number): Promise<string> =>
    new Promise((resolve, reject) => {
      debugLog(`[RemoteSTT] Attempt ${attempt}: uploading to SiliconFlow...`);

      const xhr = new XMLHttpRequest();
      xhr.open("POST", SILICONFLOW_STT_URL);

      const formData = new FormData();
      formData.append("model", "FunAudioLLM/SenseVoiceSmall");
      formData.append("file", {
        uri: filePath,
        name: filename,
        type: mimeType,
      } as any);

      xhr.setRequestHeader("Authorization", `Bearer ${key}`);
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const data = JSON.parse(xhr.responseText);
            const text = data?.text?.trim();
            if (!text) {
              reject(new Error("SiliconFlow STT returned empty result"));
              return;
            }
            debugLog(`[RemoteSTT] Success: ${text.length} chars`);
            resolve(text);
          } catch (e) {
            reject(new Error(`Failed to parse STT response: ${xhr.responseText}`));
          }
        } else {
          reject(new Error(`SiliconFlow STT failed (${xhr.status}): ${xhr.responseText}`));
        }
      };
      xhr.onerror = () => {
        reject(new Error("SiliconFlow STT network error"));
      };
      xhr.ontimeout = () => {
        reject(new Error("SiliconFlow STT timed out"));
      };
      xhr.timeout = timeoutMs;

      xhr.send(formData);
    });

  try {
    return await doUpload(1);
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    if (!isRetryable(msg)) throw e;
    debugLog(`[RemoteSTT] Retrying after: ${msg}`);
    return await doUpload(2);
  }
}
