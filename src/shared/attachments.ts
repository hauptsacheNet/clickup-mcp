import { Buffer } from "buffer";
import { randomUUID } from "crypto";
import { readFile } from "fs/promises";
import { basename, extname, isAbsolute, resolve } from "path";
import { CONFIG } from "./config";
import { parseDataUri } from "./data-uri";
import { detectMimeTypeFromBuffer } from "./image-processing";

/**
 * Attachment object as returned by POST /api/v2/task/{task_id}/attachment.
 * ClickUp only renders an image inside a comment when the fragment carries this
 * whole object - a bare URL string renders as an empty placeholder tile.
 */
export interface ClickUpUploadedAttachment {
  id: string;
  name: string;
  title?: string;
  extension?: string;
  url: string;
  thumbnail_small?: string;
  thumbnail_medium?: string;
  thumbnail_large?: string;
  width?: number;
  height?: number;
  [key: string]: any;
}

/** Image bytes ready to be uploaded */
interface ResolvedBytes {
  kind: "bytes";
  bytes: Buffer;
  mimeType: string;
  suggestedName: string;
}

/** Already an attachment on ClickUp's CDN - reuse it instead of uploading again */
interface ResolvedExisting {
  kind: "existing";
  url: string;
}

export type ResolvedImageSource = ResolvedBytes | ResolvedExisting;

const MIME_EXTENSIONS: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

/**
 * Detect the mime type from magic bytes and reject anything that is not an image
 * we know how to display. This is both a correctness guard (ClickUp needs a real
 * image to render a preview) and a safety guard: it stops arbitrary local files
 * from being pushed into a ticket just because a path was mentioned in markdown.
 */
function assertSupportedImage(bytes: Buffer, source: string): string {
  // Copy into a fresh view - Buffer instances share a pooled ArrayBuffer, so
  // passing bytes.buffer directly would hand over unrelated neighbouring data.
  const detected = detectMimeTypeFromBuffer(new Uint8Array(bytes).buffer);
  if (!detected) {
    throw new Error(
      `${source} is not a supported image (expected PNG, JPEG, GIF or WebP based on its content)`
    );
  }
  return detected;
}

function assertWithinSizeLimit(byteLength: number, source: string): void {
  const limit = CONFIG.maxUploadSizeMB * 1024 * 1024;
  if (byteLength > limit) {
    throw new Error(
      `${source} is ${(byteLength / 1024 / 1024).toFixed(1)} MB which exceeds the ${CONFIG.maxUploadSizeMB} MB upload limit (raise MAX_UPLOAD_SIZE_MB to allow it)`
    );
  }
}

/**
 * ClickUp serves attachments from *.clickup-attachments.com. Such a URL is
 * already uploaded, so it can be embedded directly.
 */
export function isClickUpAttachmentUrl(url: string): boolean {
  try {
    return new URL(url).hostname.endsWith(".clickup-attachments.com");
  } catch {
    return false;
  }
}

/**
 * Turn the `src` of a markdown image into something uploadable.
 *
 * Supported sources, in this order:
 * - a ClickUp attachment URL      -> reused as-is, no upload
 * - a base64 data URI             -> decoded
 * - any other http(s) URL         -> downloaded
 * - anything else                 -> read from the local filesystem
 *
 * The local path case is the interesting one: this server runs next to the agent,
 * so a screenshot can be referenced by path instead of being inlined as base64,
 * which would otherwise cost a multiple of the file size in tokens.
 */
export async function resolveImageSource(
  src: string,
  baseDir: string = process.cwd()
): Promise<ResolvedImageSource> {
  if (isClickUpAttachmentUrl(src)) {
    return { kind: "existing", url: src };
  }

  const dataUri = parseDataUri(src);
  if (dataUri) {
    const bytes = Buffer.from(dataUri.base64Data, "base64");
    assertWithinSizeLimit(bytes.byteLength, "The inline image");
    const mimeType = assertSupportedImage(bytes, "The inline image");
    return {
      kind: "bytes",
      bytes,
      mimeType,
      suggestedName: `image${MIME_EXTENSIONS[mimeType] ?? ".png"}`,
    };
  }

  if (/^https?:\/\//i.test(src)) {
    const response = await fetch(src);
    if (!response.ok) {
      throw new Error(`Could not download ${src}: ${response.status} ${response.statusText}`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    assertWithinSizeLimit(bytes.byteLength, src);
    const mimeType = assertSupportedImage(bytes, src);
    const urlName = basename(new URL(src).pathname) || `image${MIME_EXTENSIONS[mimeType] ?? ".png"}`;
    return { kind: "bytes", bytes, mimeType, suggestedName: decodeURIComponent(urlName) };
  }

  const filePath = isAbsolute(src) ? src : resolve(baseDir, decodeFilePath(src));
  let bytes: Buffer;
  try {
    bytes = await readFile(filePath);
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      throw new Error(`No such file: ${filePath}`);
    }
    throw new Error(`Could not read ${filePath}: ${error?.message || "unknown error"}`);
  }
  assertWithinSizeLimit(bytes.byteLength, filePath);
  const mimeType = assertSupportedImage(bytes, filePath);
  return { kind: "bytes", bytes, mimeType, suggestedName: basename(filePath) };
}

/**
 * Markdown writers tend to percent-encode spaces in paths (`my%20shot.png`).
 * Decode them, but leave the path alone if it is not valid encoding.
 */
function decodeFilePath(src: string): string {
  try {
    return decodeURIComponent(src);
  } catch {
    return src;
  }
}

/**
 * Derive the upload filename from the markdown alt text.
 *
 * ClickUp shows the *attachment filename* underneath an image, not the fragment
 * text - so naming the upload after the caption is what makes a readable caption
 * appear in the ticket.
 */
export function captionToFilename(caption: string, fallbackName: string): string {
  const extension = extname(fallbackName) || ".png";
  const cleaned = caption
    .replace(/[/\\:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120)
    .trim();
  return cleaned ? `${cleaned}${extension}` : fallbackName;
}

/**
 * Build the multipart/form-data body by hand.
 *
 * Deliberately not using `FormData`: the global FormData is only understood by the
 * fetch implementation it ships with, so swapping fetch (as the tests do) silently
 * turns the body into the string "[object FormData]". A hand-built buffer behaves
 * identically everywhere and keeps the wire format assertable.
 */
function buildMultipartBody(
  filename: string,
  bytes: Buffer,
  mimeType: string
): { body: ArrayBuffer; contentType: string } {
  const boundary = `----clickupmcp${randomUUID().replace(/-/g, "")}`;
  // Quotes and newlines would break out of the header - strip them.
  const safeName = filename.replace(/["\r\n]/g, "");
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="attachment"; filename="${safeName}"\r\n` +
      `Content-Type: ${mimeType}\r\n\r\n`,
    "utf8"
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  // Hand over a bare ArrayBuffer: Buffer and Uint8Array both trip up the BodyInit
  // typing here. Copying into a fresh Uint8Array also detaches from Buffer's shared
  // pool, so the ArrayBuffer contains exactly our bytes and nothing else.
  const combined = new Uint8Array(Buffer.concat([head, bytes, tail]));
  return {
    body: combined.buffer as ArrayBuffer,
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

/**
 * Upload a single image to a task and return the full attachment object.
 */
export async function uploadTaskAttachment(
  taskId: string,
  filename: string,
  bytes: Buffer,
  mimeType: string
): Promise<ClickUpUploadedAttachment> {
  const { body, contentType } = buildMultipartBody(filename, bytes, mimeType);

  const response = await fetch(`https://api.clickup.com/api/v2/task/${taskId}/attachment`, {
    method: "POST",
    headers: {
      Authorization: CONFIG.apiKey,
      "Content-Type": contentType,
    },
    body,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(
      `Upload of "${filename}" failed: ${response.status} ${response.statusText}${errorText ? ` - ${errorText.slice(0, 300)}` : ""}`
    );
  }

  const attachment = (await response.json()) as ClickUpUploadedAttachment;
  if (!attachment?.url) {
    throw new Error(`Upload of "${filename}" returned no URL: ${JSON.stringify(attachment)}`);
  }
  return attachment;
}

/** A markdown image whose source resolved to uploadable bytes or an existing attachment */
export interface ResolvedMarkdownImage {
  /** The original `src` as written in the markdown */
  src: string;
  alt: string;
  resolved: ResolvedImageSource;
}

/** One markdown image reference that could not be used, and why */
export interface ImageFailure {
  src: string;
  error: string;
}

/**
 * Phase 1 of attaching images: resolve every source without writing anything.
 *
 * Reads local files, downloads http(s) URLs, decodes data URIs and validates
 * magic bytes and size. Failures are collected instead of thrown so the caller
 * can report every broken reference at once - and abort before anything is
 * posted to ClickUp. Identical sources are resolved once.
 */
export async function resolveMarkdownImages(
  images: { src: string; alt: string }[],
  baseDir: string = process.cwd()
): Promise<{ resolved: ResolvedMarkdownImage[]; failures: ImageFailure[] }> {
  const resolved: ResolvedMarkdownImage[] = [];
  const failures: ImageFailure[] = [];
  const seen = new Set<string>();

  for (const { src, alt } of images) {
    if (seen.has(src)) {
      continue;
    }
    seen.add(src);

    try {
      resolved.push({ src, alt, resolved: await resolveImageSource(src, baseDir) });
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      console.error(`Cannot use image "${src}": ${message}`);
      failures.push({ src, error: message });
    }
  }

  return { resolved, failures };
}

/** A successfully uploaded (or reused) attachment for one markdown source */
export interface UploadedMarkdownImage {
  src: string;
  attachment: ClickUpUploadedAttachment;
}

/**
 * Phase 2: upload the resolved images to the task.
 *
 * Uploads run sequentially: a typical comment has a handful of screenshots, and
 * N uploads plus one write call stays well inside ClickUp's 100 calls/minute.
 * Stops at the first upload error - an API failure is unlikely to heal mid-batch,
 * and everything uploaded so far is returned so the caller can tell a retry to
 * reference those CDN URLs directly instead of uploading again.
 */
export async function uploadResolvedImages(
  taskId: string,
  images: ResolvedMarkdownImage[]
): Promise<{ uploaded: UploadedMarkdownImage[]; failure: ImageFailure | null }> {
  const uploaded: UploadedMarkdownImage[] = [];

  for (const { src, alt, resolved } of images) {
    try {
      if (resolved.kind === "existing") {
        // Already on ClickUp's CDN - synthesise the minimal attachment shape so
        // the fragment builder has something to work with.
        const name = decodeURIComponent(basename(new URL(resolved.url).pathname));
        uploaded.push({
          src,
          attachment: {
            id: name,
            name,
            title: alt || name,
            extension: extname(name).replace(/^\./, "") || undefined,
            url: resolved.url,
            thumbnail_small: resolved.url,
            thumbnail_medium: resolved.url,
            thumbnail_large: resolved.url,
          },
        });
      } else {
        const filename = captionToFilename(alt, resolved.suggestedName);
        const attachment = await uploadTaskAttachment(
          taskId,
          filename,
          resolved.bytes,
          resolved.mimeType
        );
        uploaded.push({ src, attachment });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      console.error(`Failed to attach image "${src}": ${message}`);
      return { uploaded, failure: { src, error: message } };
    }
  }

  return { uploaded, failure: null };
}

/** Map from markdown `src` to the attachment that should be embedded for it. */
export function toAttachmentMap(
  uploaded: UploadedMarkdownImage[]
): Map<string, ClickUpUploadedAttachment> {
  const map = new Map<string, ClickUpUploadedAttachment>();
  for (const { src, attachment } of uploaded) {
    map.set(src, attachment);
  }
  return map;
}
