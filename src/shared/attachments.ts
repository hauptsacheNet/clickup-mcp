import { Buffer } from "buffer";
import { randomUUID } from "crypto";
import { readFile } from "fs/promises";
import { basename, extname, isAbsolute, resolve, sep } from "path";
import { IMAGE_EXTENSIONS } from "../clickup-text";
import { CONFIG } from "./config";
import { parseDataUri } from "./data-uri";
import { detectMimeTypeFromBuffer } from "./image-processing";

/**
 * Attachment object as returned by POST /api/v2/task/{task_id}/attachment.
 * ClickUp only renders an image or file card inside a comment when the fragment
 * carries this whole object - a bare URL string renders as an empty placeholder tile.
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

/** File bytes ready to be uploaded */
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

export type ResolvedAttachmentSource = ResolvedBytes | ResolvedExisting;

const MIME_EXTENSIONS: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

/**
 * Content types for common non-image attachments, keyed by extension.
 * ClickUp picks its preview (e.g. the Office viewer for spreadsheets) from the
 * file name and type, so sending the right one matters more than for images.
 */
const FILE_MIME_TYPES: Record<string, string> = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xlsm: "application/vnd.ms-excel.sheet.macroEnabled.12",
  xls: "application/vnd.ms-excel",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  doc: "application/msword",
  odt: "application/vnd.oasis.opendocument.text",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ppt: "application/vnd.ms-powerpoint",
  pdf: "application/pdf",
  txt: "text/plain",
  log: "text/plain",
  md: "text/markdown",
  json: "application/json",
  xml: "application/xml",
  html: "text/html",
  htm: "text/html",
  svg: "image/svg+xml",
  zip: "application/zip",
};

/** Lower-case extension without the dot, or "" */
function extensionOf(name: string): string {
  return extname(name).replace(/^\./, "").toLowerCase();
}

/** File extension (with dot) to use for a data URI of the given mime type */
function extensionForMimeType(mimeType: string): string {
  if (MIME_EXTENSIONS[mimeType]) {
    return MIME_EXTENSIONS[mimeType];
  }
  const match = Object.entries(FILE_MIME_TYPES).find(([, type]) => type === mimeType);
  return match ? `.${match[0]}` : "";
}

/**
 * Work out what is being uploaded and with which content type.
 *
 * Images are detected from magic bytes, because ClickUp needs a real image to
 * render an inline preview. A file that only *claims* to be an image by its
 * extension is rejected rather than silently attached as a broken image.
 * Everything else is a regular file attachment typed by its extension.
 */
function classifyFile(
  bytes: Buffer,
  name: string,
  source: string,
  declaredMimeType?: string
): { mimeType: string; isImage: boolean } {
  // Copy into a fresh view - Buffer instances share a pooled ArrayBuffer, so
  // passing bytes.buffer directly would hand over unrelated neighbouring data.
  const detected = detectMimeTypeFromBuffer(new Uint8Array(bytes).buffer);
  if (detected) {
    return { mimeType: detected, isImage: true };
  }

  const extension = extensionOf(name);
  if (IMAGE_EXTENSIONS.has(extension)) {
    throw new Error(
      `${source} is not a supported image (expected PNG, JPEG, GIF or WebP based on its content)`
    );
  }

  return {
    mimeType: FILE_MIME_TYPES[extension] || declaredMimeType || "application/octet-stream",
    isImage: false,
  };
}

/** Directories whose contents are credentials by definition */
const SECRET_DIRECTORIES = new Set([".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker"]);
const SECRET_EXTENSIONS = new Set(["pem", "key", "p12", "pfx", "jks", "keystore", "kdbx", "ppk", "gpg"]);
const SECRET_FILENAME = /^id_(rsa|dsa|ecdsa|ed25519)$/;

/**
 * Refuse to upload local files that look like credentials.
 *
 * Any file type can be attached, so the path in the markdown is the only thing
 * standing between a (possibly prompt-injected) request and a private key ending
 * up in a ticket. Dotfiles (.env, .npmrc, .netrc, ...), key material and the
 * usual credential directories are blocked; ordinary documents are not.
 */
function assertNotSecretFile(filePath: string): void {
  const name = basename(filePath);
  const segments = filePath.split(sep);
  if (
    name.startsWith(".") ||
    SECRET_FILENAME.test(name) ||
    SECRET_EXTENSIONS.has(extensionOf(name)) ||
    segments.some((segment) => SECRET_DIRECTORIES.has(segment))
  ) {
    throw new Error(
      `${filePath} looks like a credential or configuration file and is never uploaded`
    );
  }
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
 * Turn the `src` of a markdown embed (`![caption](src)`) into something uploadable.
 * Images and any other file type are accepted - what kind of fragment it becomes
 * is decided later from the uploaded attachment.
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
export async function resolveAttachmentSource(
  src: string,
  baseDir: string = process.cwd()
): Promise<ResolvedAttachmentSource> {
  if (isClickUpAttachmentUrl(src)) {
    return { kind: "existing", url: src };
  }

  const dataUri = parseDataUri(src);
  if (dataUri) {
    const bytes = Buffer.from(dataUri.base64Data, "base64");
    assertWithinSizeLimit(bytes.byteLength, "The inline data");
    const declaredName = `file${extensionForMimeType(dataUri.mimeType)}`;
    const { mimeType, isImage } = classifyFile(bytes, declaredName, "The inline data", dataUri.mimeType);
    return {
      kind: "bytes",
      bytes,
      mimeType,
      suggestedName: isImage ? `image${MIME_EXTENSIONS[mimeType]}` : declaredName,
    };
  }

  if (/^https?:\/\//i.test(src)) {
    const response = await fetch(src);
    if (!response.ok) {
      throw new Error(`Could not download ${src}: ${response.status} ${response.statusText}`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    assertWithinSizeLimit(bytes.byteLength, src);
    const urlName = decodeFilePath(basename(new URL(src).pathname));
    const headerType = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
    // A URL that answers with a web page is a dead or login-protected link, not a
    // file - attaching the HTML would put a useless "download.html" into the ticket.
    if (headerType === "text/html" && !["html", "htm"].includes(extensionOf(urlName))) {
      throw new Error(`${src} returned a web page (text/html), not a file`);
    }
    const { mimeType, isImage } = classifyFile(bytes, urlName, src, headerType);
    const suggestedName = withExtension(urlName || (isImage ? "image" : "file"), mimeType);
    return { kind: "bytes", bytes, mimeType, suggestedName };
  }

  const filePath = isAbsolute(src) ? src : resolve(baseDir, decodeFilePath(src));
  assertNotSecretFile(filePath);
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
  const { mimeType } = classifyFile(bytes, filePath, filePath);
  return { kind: "bytes", bytes, mimeType, suggestedName: withExtension(basename(filePath), mimeType) };
}

/**
 * Append the extension matching the content type when the name has none -
 * ClickUp decides between image tile, Office preview and plain file card by it.
 */
function withExtension(name: string, mimeType: string): string {
  return extname(name) ? name : `${name}${extensionForMimeType(mimeType)}`;
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
 * ClickUp shows the *attachment filename* underneath an image and on a file card,
 * not the fragment text - so naming the upload after the caption is what makes a
 * readable caption appear in the ticket. The source's extension is kept (and not
 * doubled when the caption already ends with it), since ClickUp's previews rely on it.
 */
export function captionToFilename(caption: string, fallbackName: string): string {
  const extension = extname(fallbackName);
  const cleaned = caption
    .replace(/[/\\:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120)
    .trim();
  if (!cleaned) {
    return fallbackName;
  }
  return extension && cleaned.toLowerCase().endsWith(extension.toLowerCase())
    ? cleaned
    : `${cleaned}${extension}`;
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
 * Upload a single file to a task and return the full attachment object.
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

/** A markdown embed whose source resolved to uploadable bytes or an existing attachment */
export interface ResolvedMarkdownAttachment {
  /** The original `src` as written in the markdown */
  src: string;
  alt: string;
  resolved: ResolvedAttachmentSource;
}

/** One markdown embed reference that could not be used, and why */
export interface AttachmentFailure {
  src: string;
  error: string;
}

/**
 * Phase 1 of attaching files: resolve every source without writing anything.
 *
 * Reads local files, downloads http(s) URLs, decodes data URIs and validates
 * image content and size. Failures are collected instead of thrown so the caller
 * can report every broken reference at once - and abort before anything is
 * posted to ClickUp. Identical sources are resolved once.
 */
export async function resolveMarkdownAttachments(
  embeds: { src: string; alt: string }[],
  baseDir: string = process.cwd()
): Promise<{ resolved: ResolvedMarkdownAttachment[]; failures: AttachmentFailure[] }> {
  const resolved: ResolvedMarkdownAttachment[] = [];
  const failures: AttachmentFailure[] = [];
  const seen = new Set<string>();

  for (const { src, alt } of embeds) {
    if (seen.has(src)) {
      continue;
    }
    seen.add(src);

    try {
      resolved.push({ src, alt, resolved: await resolveAttachmentSource(src, baseDir) });
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      console.error(`Cannot use attachment "${src}": ${message}`);
      failures.push({ src, error: message });
    }
  }

  return { resolved, failures };
}

/** A successfully uploaded (or reused) attachment for one markdown source */
export interface UploadedMarkdownAttachment {
  src: string;
  attachment: ClickUpUploadedAttachment;
}

/**
 * Phase 2: upload the resolved files to the task.
 *
 * Uploads run sequentially: a typical comment has a handful of files, and
 * N uploads plus one write call stays well inside ClickUp's 100 calls/minute.
 * Stops at the first upload error - an API failure is unlikely to heal mid-batch,
 * and everything uploaded so far is returned so the caller can tell a retry to
 * reference those CDN URLs directly instead of uploading again.
 */
export async function uploadResolvedAttachments(
  taskId: string,
  attachments: ResolvedMarkdownAttachment[]
): Promise<{ uploaded: UploadedMarkdownAttachment[]; failure: AttachmentFailure | null }> {
  const uploaded: UploadedMarkdownAttachment[] = [];

  for (const { src, alt, resolved } of attachments) {
    try {
      if (resolved.kind === "existing") {
        // Already on ClickUp's CDN - synthesise the minimal attachment shape so
        // the fragment builder has something to work with. Only images get
        // thumbnails; a file card with an image thumbnail pointing at a
        // spreadsheet would render as a broken image.
        const name = decodeURIComponent(basename(new URL(resolved.url).pathname));
        const extension = extensionOf(name);
        const thumbnail = IMAGE_EXTENSIONS.has(extension) ? resolved.url : undefined;
        uploaded.push({
          src,
          attachment: {
            id: name,
            name,
            title: IMAGE_EXTENSIONS.has(extension) ? alt || name : name,
            extension: extension || undefined,
            url: resolved.url,
            thumbnail_small: thumbnail,
            thumbnail_medium: thumbnail,
            thumbnail_large: thumbnail,
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
      console.error(`Failed to attach "${src}": ${message}`);
      return { uploaded, failure: { src, error: message } };
    }
  }

  return { uploaded, failure: null };
}

/** Map from markdown `src` to the attachment that should be embedded for it. */
export function toAttachmentMap(
  uploaded: UploadedMarkdownAttachment[]
): Map<string, ClickUpUploadedAttachment> {
  const map = new Map<string, ClickUpUploadedAttachment>();
  for (const { src, attachment } of uploaded) {
    map.set(src, attachment);
  }
  return map;
}
