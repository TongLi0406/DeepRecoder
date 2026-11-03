import type { Session, Skill } from "../types";
import { Platform } from "react-native";

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

function htmlDocument(title: string, content: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>body{font-family:sans-serif;padding:24px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-family:inherit}</style></head><body><h1>${escapeHtml(title)}</h1><pre>${escapeHtml(content)}</pre></body></html>`;
}

function sessionContent(session: Session): string {
  return [session.title || "Session", session.createdAt || "", session.mode || "", "Summary", JSON.stringify(session.summary ?? {}, null, 2), "Original Transcript", session.transcript || ""].join("\n\n");
}

function markdownDocument(title: string, content: string): string {
  return `# ${title}\n\n${content.split("\n").map(line => "    " + line).join("\n")}\n`;
}

export function sessionToHtml(session: Session): string {
  return htmlDocument(session.title || "Session", sessionContent(session));
}

export function sessionToMarkdown(session: Session): string {
  return markdownDocument("Session", sessionContent(session));
}

export function skillsToHtml(skills: Skill[]): string {
  return htmlDocument("Skills", JSON.stringify(skills, null, 2));
}

export function skillsToMarkdown(skills: Skill[]): string {
  return markdownDocument("Skills", JSON.stringify(skills, null, 2));
}

export async function exportDocument(format: "pdf" | "markdown", fileName: string, content: string): Promise<void> {
  const name = fileName.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(0, 80).replace(/[. ]+$/g, "") || "recorder";
  if (Platform.OS === "web") {
    if (format === "pdf") {
      const preview = window.open("", "_blank");
      if (!preview) throw new Error("Allow pop-ups to open the print preview.");
      preview.opener = null;
      preview.onload = () => preview.print();
      preview.document.open();
      preview.document.write(content);
      preview.document.close();
    } else {
      const url = URL.createObjectURL(new Blob([content], { type: "text/markdown;charset=utf-8" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `${name}.md`;
      try {
        document.body.appendChild(link);
        link.click();
      } finally {
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    }
    return;
  }
  let uri: string;
  if (format === "pdf") {
    const { printToFileAsync } = await import("expo-print");
    uri = (await printToFileAsync({ html: content, base64: false })).uri;
  } else {
    const { writeAsStringAsync, cacheDirectory } = await import("expo-file-system/legacy");
    if (!cacheDirectory) throw new Error("Export storage is unavailable.");
    uri = `${cacheDirectory}${name}.md`;
    await writeAsStringAsync(uri, content, { encoding: "utf8" });
  }
  const { shareAsync } = await import("expo-sharing");
  await shareAsync(uri, { mimeType: format === "pdf" ? "application/pdf" : "text/markdown" });
}
