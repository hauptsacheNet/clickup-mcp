import { test } from "node:test";
import assert from "node:assert/strict";
import { MockAgent, setGlobalDispatcher } from "undici";
import { mkdtemp, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

/** A real 4x4 PNG - the magic-byte guard rejects anything that is not a true image */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFUlEQVR42mP8z8DAwMgAA4xkYCADAKQlBAX9tXpZAAAAAElFTkSuQmCC";

const CDN_URL =
  "https://t123.p.clickup-attachments.com/t123/abc-def/Ein%20Screenshot.png";

/** Attachment object as returned by POST /task/{id}/attachment */
function attachmentResponse(name: string) {
  return {
    id: `abc-def.png`,
    name,
    title: name,
    extension: "png",
    url: CDN_URL,
    thumbnail_small: CDN_URL,
    thumbnail_medium: CDN_URL,
    thumbnail_large: CDN_URL,
    width: 4,
    height: 4,
  };
}

interface Harness {
  tools: Record<string, any>;
  mockAgent: MockAgent;
  client: ReturnType<MockAgent["get"]>;
  uploads: { filename: string | null }[];
  close: () => Promise<void>;
}

async function setupHarness(): Promise<Harness> {
  process.env.CLICKUP_API_KEY = "test-key";
  process.env.CLICKUP_TEAM_ID = "team1";

  const { registerTaskToolsWrite } = await import("../tools/task-write-tools");

  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  const client = mockAgent.get("https://api.clickup.com");

  const tools: Record<string, any> = {};
  const serverStub = {
    tool: (name: string, _d: string, _s: any, _o: any, handler: any) => {
      tools[name] = handler;
    },
  } as any;

  registerTaskToolsWrite(serverStub, { user: { username: "me", id: "u1" } });

  return {
    tools,
    mockAgent,
    client,
    uploads: [],
    close: () => mockAgent.close(),
  };
}

/** Decode a request body that may arrive as a string or as raw bytes */
function bodyToString(body: unknown): string {
  if (typeof body === "string") return body;
  if (body instanceof ArrayBuffer) return Buffer.from(body).toString("latin1");
  if (body instanceof Uint8Array) return Buffer.from(body).toString("latin1");
  return String(body ?? "");
}

/**
 * Intercept the attachment endpoint and record the multipart filename.
 * The filename matters: ClickUp shows it as the image caption.
 */
function interceptUpload(h: Harness, taskId: string, name: string, times = 1) {
  h.client
    .intercept({ path: `/api/v2/task/${taskId}/attachment`, method: "POST" })
    .reply((opts) => {
      const body = bodyToString(opts.body);
      const match = body.match(/filename="([^"]*)"/);
      h.uploads.push({ filename: match ? match[1] : null });
      return { statusCode: 200, data: attachmentResponse(name) };
    })
    .times(times);
}

async function writeTempPng(filename = "shot.png"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "clickup-image-test-"));
  const path = join(dir, filename);
  await writeFile(path, Buffer.from(PNG_BASE64, "base64"));
  return path;
}

test("addComment uploads a local image and embeds the full attachment object", async (t) => {
  const h = await setupHarness();
  const imagePath = await writeTempPng();

  interceptUpload(h, "task123", "Die Login-Maske.png");

  let commentBody: any;
  h.client
    .intercept({ path: "/api/v2/task/task123/comment", method: "POST" })
    .reply((opts) => {
      commentBody = JSON.parse(String(opts.body));
      return { statusCode: 200, data: { id: "c1", user: { username: "me" }, date: "0" } };
    });

  const result = await h.tools.addComment({
    task_id: "task123",
    comment: `Ist umgesetzt.\n\n![Die Login-Maske](${imagePath})`,
  });

  assert.equal(h.uploads.length, 1, "should upload exactly one image");
  assert.equal(
    h.uploads[0].filename,
    "Die Login-Maske.png",
    "upload should be named after the caption - ClickUp shows the filename as caption"
  );

  const fragment = commentBody.comment.find((b: any) => b.type === "image");
  assert.ok(fragment, "comment should contain an image fragment");
  assert.equal(typeof fragment.image, "object", "image must be an object, not a string");
  assert.equal(fragment.image.url, CDN_URL);
  assert.equal(fragment.image.title, "Die Login-Maske");
  assert.equal(fragment.image.thumbnail_large, CDN_URL, "thumbnails are required to render");
  assert.equal(fragment.image.width, 4);
  assert.equal(fragment.attributes.alt, "Die Login-Maske");

  // The local path must not leak into the comment body
  assert.ok(
    !JSON.stringify(commentBody.comment).includes(imagePath),
    "local path should be replaced by the CDN URL"
  );
  assert.ok(result.content[0].text.includes("files_attached: 1"));

  await h.close();
});

test("addComment uploads a data URI without touching the filesystem", async (t) => {
  const h = await setupHarness();

  interceptUpload(h, "task123", "Inline.png");

  let commentBody: any;
  h.client
    .intercept({ path: "/api/v2/task/task123/comment", method: "POST" })
    .reply((opts) => {
      commentBody = JSON.parse(String(opts.body));
      return { statusCode: 200, data: { id: "c1", user: { username: "me" }, date: "0" } };
    });

  await h.tools.addComment({
    task_id: "task123",
    comment: `![Inline](data:image/png;base64,${PNG_BASE64})`,
  });

  assert.equal(h.uploads.length, 1);
  const fragment = commentBody.comment.find((b: any) => b.type === "image");
  assert.ok(fragment, "data URI should become an image fragment");
  assert.equal(fragment.image.url, CDN_URL);
  assert.ok(
    !JSON.stringify(commentBody).includes(PNG_BASE64),
    "base64 payload should not be echoed into the comment"
  );

  await h.close();
});

test("addComment reuses an existing ClickUp attachment URL without re-uploading", async (t) => {
  const h = await setupHarness();

  // Deliberately no upload interceptor: any upload attempt fails the test,
  // because disableNetConnect() rejects unmatched requests.
  let commentBody: any;
  h.client
    .intercept({ path: "/api/v2/task/task123/comment", method: "POST" })
    .reply((opts) => {
      commentBody = JSON.parse(String(opts.body));
      return { statusCode: 200, data: { id: "c1", user: { username: "me" }, date: "0" } };
    });

  await h.tools.addComment({
    task_id: "task123",
    comment: `![Schon hochgeladen](${CDN_URL})`,
  });

  assert.equal(h.uploads.length, 0, "an existing attachment URL must not be uploaded again");
  const fragment = commentBody.comment.find((b: any) => b.type === "image");
  assert.ok(fragment, "existing URL should still become an image fragment");
  assert.equal(fragment.image.url, CDN_URL);
  assert.equal(fragment.image.title, "Schon hochgeladen");

  await h.close();
});

test("addComment aborts without posting when an image is not an image", async (t) => {
  const h = await setupHarness();

  // A text file that merely claims to be a PNG - the magic-byte check must catch it
  const dir = await mkdtemp(join(tmpdir(), "clickup-image-test-"));
  const fakePath = join(dir, "not-really.png");
  await writeFile(fakePath, "just text, definitely not a PNG");

  // Deliberately no comment interceptor: posting the comment would hit
  // disableNetConnect() and surface as a different error text below.
  const result = await h.tools.addComment({
    task_id: "task123",
    comment: `Text davor\n\n![Kaputtes Bild](${fakePath})`,
  });

  assert.equal(h.uploads.length, 0, "a non-image must not be uploaded");
  assert.ok(result.content[0].text.includes("not a supported image"));
  assert.ok(
    result.content[0].text.includes("the comment was NOT posted"),
    "the response must state explicitly that nothing was written"
  );

  await h.close();
});

test("addComment aborts without posting when a referenced file does not exist", async (t) => {
  const h = await setupHarness();

  const result = await h.tools.addComment({
    task_id: "task123",
    comment: `![Fehlt](/definitely/does/not/exist.png)`,
  });

  assert.equal(h.uploads.length, 0);
  assert.ok(result.content[0].text.includes("No such file"));
  assert.ok(result.content[0].text.includes("/definitely/does/not/exist.png"));
  assert.ok(result.content[0].text.includes("the comment was NOT posted"));

  await h.close();
});

test("addComment aborts without posting when an image URL cannot be downloaded", async (t) => {
  const h = await setupHarness();

  h.mockAgent
    .get("https://example.com")
    .intercept({ path: "/missing.png", method: "GET" })
    .reply(404, "not found");

  const result = await h.tools.addComment({
    task_id: "task123",
    comment: `![Totes Bild](https://example.com/missing.png)`,
  });

  assert.equal(h.uploads.length, 0);
  assert.ok(result.content[0].text.includes("Could not download"));
  assert.ok(result.content[0].text.includes("404"));
  assert.ok(result.content[0].text.includes("the comment was NOT posted"));

  await h.close();
});

test("addComment aborts on an upload API failure and lists what was already uploaded", async (t) => {
  const h = await setupHarness();
  const firstPath = await writeTempPng("erstes.png");
  const secondPath = await writeTempPng("zweites.png");

  // First upload succeeds, second one fails - the error must tell the caller
  // about the first image's CDN URL so a retry does not upload it twice.
  interceptUpload(h, "task123", "Erstes Bild.png");
  h.client
    .intercept({ path: "/api/v2/task/task123/attachment", method: "POST" })
    .reply(500, { err: "internal error" });

  const result = await h.tools.addComment({
    task_id: "task123",
    comment: `![Erstes Bild](${firstPath})\n\n![Zweites Bild](${secondPath})`,
  });

  const text = result.content[0].text;
  assert.ok(text.includes("the comment was NOT posted"));
  assert.ok(text.includes("500"), "the upload error must be reported");
  assert.ok(
    text.includes(CDN_URL),
    "the already-uploaded image must be listed with its URL for the retry"
  );

  await h.close();
});

test("createTask does not create the task when an image reference is broken", async (t) => {
  const h = await setupHarness();

  // No interceptors at all: neither /user nor the task POST may be reached.
  const result = await h.tools.createTask({
    list_id: "list1",
    name: "Sollte nie entstehen",
    description: `![Fehlt](/definitely/does/not/exist.png)`,
  });

  assert.ok(result.content[0].text.includes("No such file"));
  assert.ok(result.content[0].text.includes("the task was NOT created"));

  await h.close();
});

test("updateTask writes nothing when an image reference is broken", async (t) => {
  const h = await setupHarness();

  h.client
    .intercept({ path: "/api/v2/user", method: "GET" })
    .reply(200, { user: { id: "u1", username: "me" } });
  h.client
    .intercept({ path: "/api/v2/task/task123?include_markdown_description=true", method: "GET" })
    .reply(200, { id: "task123", name: "Task", markdown_description: "Bestehender Text" });

  // No PUT interceptor: an attempted update would fail loudly via disableNetConnect()
  const result = await h.tools.updateTask({
    task_id: "task123",
    status: "in progress",
    append_description: `Fertig\n\n![Fehlt](/definitely/does/not/exist.png)`,
  });

  assert.equal(h.uploads.length, 0);
  assert.ok(result.content[0].text.includes("No such file"));
  assert.ok(result.content[0].text.includes("the task was NOT updated"));

  await h.close();
});

test("addComment uploads a repeated source only once", async (t) => {
  const h = await setupHarness();
  const imagePath = await writeTempPng();

  interceptUpload(h, "task123", "Zweimal.png");

  let commentBody: any;
  h.client
    .intercept({ path: "/api/v2/task/task123/comment", method: "POST" })
    .reply((opts) => {
      commentBody = JSON.parse(String(opts.body));
      return { statusCode: 200, data: { id: "c1", user: { username: "me" }, date: "0" } };
    });

  await h.tools.addComment({
    task_id: "task123",
    comment: `![Zweimal](${imagePath})\n\n![Zweimal](${imagePath})`,
  });

  assert.equal(h.uploads.length, 1, "the same source should be uploaded once");
  const fragments = commentBody.comment.filter((b: any) => b.type === "image");
  assert.equal(fragments.length, 2, "but embedded twice");

  await h.close();
});

test("addComment handles a path with spaces, as macOS screenshots have", async (t) => {
  const h = await setupHarness();
  // The shape macOS actually produces
  const imagePath = await writeTempPng("Screenshot 2026-07-27 at 14.30.45.png");

  interceptUpload(h, "task123", "Der Beweis.png");

  let commentBody: any;
  h.client
    .intercept({ path: "/api/v2/task/task123/comment", method: "POST" })
    .reply((opts) => {
      commentBody = JSON.parse(String(opts.body));
      return { statusCode: 200, data: { id: "c1", user: { username: "me" }, date: "0" } };
    });

  // Written bare, without CommonMark's required angle brackets
  await h.tools.addComment({
    task_id: "task123",
    comment: `![Der Beweis](${imagePath})`,
  });

  assert.equal(h.uploads.length, 1, "a bare path with spaces must still be uploaded");
  const fragment = commentBody.comment.find((b: any) => b.type === "image");
  assert.ok(fragment, "should produce an image fragment");
  assert.equal(fragment.image.url, CDN_URL);

  await h.close();
});

test("createTask uploads images after creation and rewrites the description URL", async (t) => {
  const h = await setupHarness();
  const imagePath = await writeTempPng();

  h.client
    .intercept({ path: "/api/v2/list/list1/task", method: "POST" })
    .reply(200, { id: "newtask1", name: "Mit Bild", url: "https://app.clickup.com/t/newtask1" });

  interceptUpload(h, "newtask1", "Screenshot.png");

  let putBody: any;
  h.client
    .intercept({ path: "/api/v2/task/newtask1", method: "PUT" })
    .reply((opts) => {
      putBody = JSON.parse(String(opts.body));
      return { statusCode: 200, data: { id: "newtask1" } };
    });

  h.client
    .intercept({ path: "/api/v2/user", method: "GET" })
    .reply(200, { user: { id: "u1", username: "me" } })
    .times(2);

  await h.tools.createTask({
    list_id: "list1",
    name: "Mit Bild",
    description: `Vorher\n\n![Screenshot](${imagePath})`,
  });

  assert.equal(h.uploads.length, 1, "image should be uploaded to the created task");
  assert.ok(putBody, "description should be rewritten after upload");
  assert.ok(
    putBody.markdown_description.includes(CDN_URL),
    "description should reference the CDN URL"
  );
  assert.ok(
    !putBody.markdown_description.includes(imagePath),
    "local path must be gone from the description"
  );
  assert.ok(
    putBody.markdown_description.includes("![Screenshot]"),
    "caption should be preserved as markdown alt text"
  );

  await h.close();
});

test("updateTask uploads images and rewrites the appended description", async (t) => {
  const h = await setupHarness();
  const imagePath = await writeTempPng();

  h.client
    .intercept({ path: "/api/v2/task/task123?include_markdown_description=true", method: "GET" })
    .reply(200, { id: "task123", name: "Task", markdown_description: "Bestehender Text" });

  interceptUpload(h, "task123", "Nachweis.png");

  let putBody: any;
  h.client
    .intercept({ path: "/api/v2/task/task123", method: "PUT" })
    .reply((opts) => {
      putBody = JSON.parse(String(opts.body));
      return { statusCode: 200, data: { id: "task123", name: "Task" } };
    });

  h.client
    .intercept({ path: "/api/v2/user", method: "GET" })
    .reply(200, { user: { id: "u1", username: "me" } })
    .times(2);

  await h.tools.updateTask({
    task_id: "task123",
    append_description: `Fertig\n\n![Nachweis](${imagePath})`,
  });

  assert.equal(h.uploads.length, 1);
  assert.ok(putBody.markdown_description.includes("Bestehender Text"), "existing text preserved");
  assert.ok(putBody.markdown_description.includes(CDN_URL));
  assert.ok(!putBody.markdown_description.includes(imagePath));

  await h.close();
});

const XLSX_URL =
  "https://t123.p.clickup-attachments.com/t123/fff-000/Auswertung%20M%C3%A4rz.xlsx";

/** Attachment object as returned by POST /task/{id}/attachment for a spreadsheet */
function fileAttachmentResponse(name: string, extension: string, url = XLSX_URL) {
  return {
    id: `fff-000.${extension}`,
    title: name,
    extension,
    mimetype: "application/octet-stream",
    url,
    thumbnail_small: null,
    thumbnail_medium: null,
    thumbnail_large: null,
  };
}

/** Like interceptUpload, but for files - also records the multipart content type */
function interceptFileUpload(
  h: Harness,
  taskId: string,
  response: ReturnType<typeof fileAttachmentResponse>,
  seen: { filename: string | null; contentType: string | null }[]
) {
  h.client
    .intercept({ path: `/api/v2/task/${taskId}/attachment`, method: "POST" })
    .reply((opts) => {
      const body = bodyToString(opts.body);
      // bodyToString decodes as latin1; the multipart header itself is UTF-8
      const rawName = body.match(/filename="([^"]*)"/)?.[1];
      const filename = rawName ? Buffer.from(rawName, "latin1").toString("utf8") : null;
      const contentType = body.match(/\r\nContent-Type: ([^\r\n]+)\r\n/)?.[1] ?? null;
      seen.push({ filename, contentType });
      h.uploads.push({ filename });
      return { statusCode: 200, data: response };
    });
}

function interceptComment(h: Harness, onBody: (body: any) => void) {
  h.client
    .intercept({ path: "/api/v2/task/task123/comment", method: "POST" })
    .reply((opts) => {
      onBody(JSON.parse(String(opts.body)));
      return { statusCode: 200, data: { id: "c1", user: { username: "me" }, date: "0" } };
    });
}

async function writeTempFile(filename: string, content: string | Buffer): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "clickup-file-test-"));
  const path = join(dir, filename);
  await writeFile(path, content);
  return path;
}

test("addComment attaches an Excel file as a file card with the full attachment object", async () => {
  const h = await setupHarness();
  // An .xlsx is a zip container - the content is irrelevant, only images are sniffed
  const xlsxPath = await writeTempFile("export-2026-03.xlsx", Buffer.from("PK\u0003\u0004 fake xlsx"));

  const seen: { filename: string | null; contentType: string | null }[] = [];
  interceptFileUpload(h, "task123", fileAttachmentResponse("Auswertung März.xlsx", "xlsx"), seen);

  let commentBody: any;
  interceptComment(h, (body) => (commentBody = body));

  const result = await h.tools.addComment({
    task_id: "task123",
    comment: `Hier die Auswertung:\n\n![Auswertung März](${xlsxPath})`,
  });

  assert.equal(seen.length, 1, "the spreadsheet should be uploaded once");
  assert.equal(seen[0].filename, "Auswertung März.xlsx", "caption becomes the filename, extension kept");
  assert.equal(
    seen[0].contentType,
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "ClickUp's Office preview relies on the real spreadsheet type"
  );

  assert.ok(!commentBody.comment.some((b: any) => b.type === "image"), "a spreadsheet is no image");
  const fragment = commentBody.comment.find((b: any) => b.type === "attachment");
  assert.ok(fragment, "comment should contain an attachment fragment");
  assert.equal(fragment.text, "Auswertung März.xlsx");
  assert.equal(fragment.attachment.url, XLSX_URL);
  assert.equal(fragment.attachment.id, "fff-000.xlsx", "the whole upload response is embedded");
  assert.equal(fragment.attachment.extension, "xlsx");
  assert.ok(!JSON.stringify(commentBody).includes(xlsxPath), "local path must not leak");
  assert.ok(result.content[0].text.includes("files_attached: 1"));

  await h.close();
});

test("addComment attaches a CSV data URI and does not double an extension already in the caption", async () => {
  const h = await setupHarness();
  const seen: { filename: string | null; contentType: string | null }[] = [];
  interceptFileUpload(h, "task123", fileAttachmentResponse("daten.csv", "csv"), seen);

  let commentBody: any;
  interceptComment(h, (body) => (commentBody = body));

  const csv = Buffer.from("id;name\n1;Anna\n2;Ben\n").toString("base64");
  await h.tools.addComment({
    task_id: "task123",
    comment: `![daten.csv](data:text/csv;base64,${csv})`,
  });

  assert.equal(seen[0].filename, "daten.csv");
  assert.equal(seen[0].contentType, "text/csv");
  assert.ok(commentBody.comment.some((b: any) => b.type === "attachment"));
  assert.ok(!JSON.stringify(commentBody).includes(csv), "base64 payload must not be posted");

  await h.close();
});

test("addComment re-embeds an existing ClickUp file URL as a file card without uploading", async () => {
  const h = await setupHarness();

  let commentBody: any;
  interceptComment(h, (body) => (commentBody = body));

  await h.tools.addComment({
    task_id: "task123",
    comment: `![Auswertung März.xlsx](${XLSX_URL})`,
  });

  assert.equal(h.uploads.length, 0, "an existing attachment URL must not be uploaded again");
  const fragment = commentBody.comment.find((b: any) => b.type === "attachment");
  assert.ok(fragment, "existing file URL should become an attachment fragment");
  assert.equal(fragment.attachment.url, XLSX_URL);
  assert.equal(fragment.text, "Auswertung März.xlsx");
  assert.equal(fragment.attachment.thumbnail_large, undefined, "a file card has no image thumbnail");

  await h.close();
});

test("addComment refuses to upload credential files", async () => {
  const h = await setupHarness();
  const envPath = await writeTempFile(".env", "CLICKUP_API_KEY=secret");
  const keyPath = await writeTempFile("id_rsa", "-----BEGIN OPENSSH PRIVATE KEY-----");

  // Deliberately no upload or comment interceptor - any request fails the test
  const result = await h.tools.addComment({
    task_id: "task123",
    comment: `![env](${envPath})\n\n![key](${keyPath})`,
  });

  assert.equal(h.uploads.length, 0);
  const text = result.content[0].text;
  assert.ok(text.includes("2 image/file reference(s) could not be used"), text);
  assert.ok(text.includes("looks like a credential"), text);
  assert.ok(text.includes("the comment was NOT posted"));

  await h.close();
});

test("addComment rejects a URL that answers with a web page instead of a file", async () => {
  const h = await setupHarness();

  h.mockAgent
    .get("https://example.com")
    .intercept({ path: "/share/report", method: "GET" })
    .reply(200, "<html>Please log in</html>", { headers: { "content-type": "text/html; charset=utf-8" } });

  const result = await h.tools.addComment({
    task_id: "task123",
    comment: `![Report](https://example.com/share/report)`,
  });

  assert.equal(h.uploads.length, 0);
  assert.ok(result.content[0].text.includes("returned a web page"), result.content[0].text);
  assert.ok(result.content[0].text.includes("the comment was NOT posted"));

  await h.close();
});

test("updateTask links a non-image file in the description instead of embedding it as an image", async () => {
  const h = await setupHarness();
  const csvPath = await writeTempFile("export.csv", "a;b\n1;2\n");

  h.client
    .intercept({ path: "/api/v2/task/task123?include_markdown_description=true", method: "GET" })
    .reply(200, { id: "task123", name: "Task", markdown_description: "Bestehender Text" });

  const seen: { filename: string | null; contentType: string | null }[] = [];
  const csvUrl = "https://t123.p.clickup-attachments.com/t123/ccc/Rohdaten.csv";
  interceptFileUpload(h, "task123", fileAttachmentResponse("Rohdaten.csv", "csv", csvUrl), seen);

  let putBody: any;
  h.client
    .intercept({ path: "/api/v2/task/task123", method: "PUT" })
    .reply((opts) => {
      putBody = JSON.parse(String(opts.body));
      return { statusCode: 200, data: { id: "task123", name: "Task" } };
    });

  h.client
    .intercept({ path: "/api/v2/user", method: "GET" })
    .reply(200, { user: { id: "u1", username: "me" } })
    .times(2);

  await h.tools.updateTask({
    task_id: "task123",
    append_description: `Daten:\n\n![Rohdaten](${csvPath})`,
  });

  assert.equal(seen[0].filename, "Rohdaten.csv");
  assert.ok(putBody.markdown_description.includes(`[Rohdaten](${csvUrl})`), putBody.markdown_description);
  assert.ok(!putBody.markdown_description.includes(`![Rohdaten]`), "a CSV must not become a broken image");
  assert.ok(!putBody.markdown_description.includes(csvPath));

  await h.close();
});
