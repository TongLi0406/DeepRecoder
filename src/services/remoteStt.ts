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

export async function transcribeRemote(
  audioUri: string,
): Promise<string> {
  const key = await getApiKey();
  if (!key) {
    throw new Error("No SiliconFlow API key configured");
  }

  debugLog("[RemoteSTT] Uploading audio to SiliconFlow SenseVoiceSmall...");

  const filePath = audioUri.startsWith("file://") ? audioUri : `file://${audioUri}`;
  const filename = filePath.split("/").pop() || "audio.wav";

  // Use XMLHttpRequest — React Native's fetch doesn't support FormData file uploads
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", SILICONFLOW_STT_URL);

    const formData = new FormData();
    formData.append("model", "FunAudioLLM/SenseVoiceSmall");
    formData.append("file", {
      uri: filePath,
      name: filename,
      type: "audio/wav",
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
    xhr.timeout = 60000;

    xhr.send(formData);
  });
}
