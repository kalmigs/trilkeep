// Minimal client for the TriliumNext ETAPI (External API).
//
// Verified against docs/etapi.openapi.yaml (ETAPI 1.0.0). The handful of
// endpoints below are the ones the backup flow needs; if the spec is updated,
// this is the only file that should need touching.
//
// Auth: EtapiTokenAuth — an apiKey sent in the `Authorization` header as the
// raw ETAPI token (NOT a Bearer prefix). See securitySchemes in the spec.

import * as crypto from "crypto";

// ETAPI entityId charset (spec pattern [a-zA-Z0-9_]{4,32}). POST /attributes
// takes a client-supplied attributeId; generate a 12-char one like Trilium does.
const ENTITY_ID_ALPHABET =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

function generateEntityId(): string {
  const bytes = crypto.randomBytes(12);
  let id = "";
  for (let i = 0; i < 12; i++) {
    id += ENTITY_ID_ALPHABET[bytes[i] % ENTITY_ID_ALPHABET.length];
  }
  return id;
}

/** Note types accepted by POST /create-note (CreateNoteDef.type enum). */
export type CreateNoteType =
  | "text"
  | "code"
  | "file"
  | "image"
  | "search"
  | "book"
  | "relationMap"
  | "render";

export interface CreateNoteParams {
  parentNoteId: string;
  title: string;
  type: CreateNoteType;
  /** Required only for type 'code' | 'file' | 'image' (per the spec). */
  mime?: string;
  content: string;
}

export interface EtapiAttribute {
  attributeId: string;
  /** "label" | "relation" — keep loose to match response shape. */
  type: string;
  name: string;
  value?: string;
}

export interface EtapiNote {
  noteId: string;
  title: string;
  /** Response types are a superset of creatable types — keep loose. */
  type: string;
  mime?: string;
  /** GET /notes/{id} includes the note's attributes (labels/relations). */
  attributes?: EtapiAttribute[];
}

export interface CreateNoteResponse {
  note: EtapiNote;
  branch: { branchId: string; noteId: string; parentNoteId: string };
}

export interface AppInfo {
  appVersion: string;
  dbVersion: number;
  [k: string]: unknown;
}

export class EtapiError extends Error {
  constructor(message: string, readonly status?: number, readonly body?: string) {
    super(message);
    this.name = "EtapiError";
  }
}

/** Strip trailing slashes and ensure the /etapi suffix. Pure + testable. */
export function normalizeEtapiBase(serverUrl: string): string {
  const root = serverUrl.replace(/\/+$/, "");
  return root.endsWith("/etapi") ? root : `${root}/etapi`;
}

/** True when sending the token to this URL would cross a network in cleartext:
 * an http: (not https:) scheme to a non-loopback host. Loopback http is fine —
 * the token never leaves the machine. Pure + testable; used to warn the user
 * before a full-access ETAPI token is exposed on the wire. */
export function isInsecureRemoteUrl(serverUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(serverUrl);
  } catch {
    return false; // malformed — let the request layer surface the real error
  }
  if (url.protocol !== "http:") {
    return false;
  }
  const host = url.hostname.toLowerCase();
  const loopback =
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.startsWith("127.") ||
    host === "::1" ||
    host === "[::1]";
  return !loopback;
}

export class EtapiClient {
  private readonly base: string;

  constructor(serverUrl: string, private readonly token: string) {
    this.base = normalizeEtapiBase(serverUrl);
  }

  private async request(
    method: string,
    path: string,
    opts: { body?: string; contentType?: string } = {}
  ): Promise<Response> {
    const headers: Record<string, string> = { Authorization: this.token };
    if (opts.contentType) {
      headers["Content-Type"] = opts.contentType;
    }
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, {
        method,
        headers,
        body: opts.body,
      });
    } catch (e) {
      throw new EtapiError(
        `Cannot reach Trilium at ${this.base} — is the server running and the URL correct? (${
          (e as Error).message
        })`
      );
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      // The spec's Error schema is { status, code, message }. Surface the
      // human-readable message/code when the body is that JSON.
      let detail = text;
      try {
        const parsed = JSON.parse(text) as { code?: string; message?: string };
        if (parsed.message) {
          detail = parsed.code ? `${parsed.message} [${parsed.code}]` : parsed.message;
        }
      } catch {
        // Non-JSON body — keep the raw text.
      }
      throw new EtapiError(
        `ETAPI ${method} ${path} failed: ${res.status} ${res.statusText}`,
        res.status,
        detail
      );
    }
    return res;
  }

  /** Health check — also validates the token. */
  async appInfo(): Promise<AppInfo> {
    const res = await this.request("GET", "/app-info");
    return (await res.json()) as AppInfo;
  }

  async createNote(params: CreateNoteParams): Promise<CreateNoteResponse> {
    const res = await this.request("POST", "/create-note", {
      body: JSON.stringify(params),
      contentType: "application/json",
    });
    return (await res.json()) as CreateNoteResponse;
  }

  /** Update a note's properties (e.g. its title). PATCH /notes/{id}. */
  async patchNote(noteId: string, patch: { title?: string }): Promise<void> {
    await this.request("PATCH", `/notes/${encodeURIComponent(noteId)}`, {
      body: JSON.stringify(patch),
      contentType: "application/json",
    });
  }

  /** Update an attribute's value. PATCH /attributes/{id} (only value/position
   * are mutable; a label's name is not). */
  async patchAttribute(attributeId: string, value: string): Promise<void> {
    await this.request(
      "PATCH",
      `/attributes/${encodeURIComponent(attributeId)}`,
      { body: JSON.stringify({ value }), contentType: "application/json" }
    );
  }

  /** Replace a note's raw content. Body is sent as text/plain. */
  async putContent(noteId: string, content: string): Promise<void> {
    await this.request("PUT", `/notes/${encodeURIComponent(noteId)}/content`, {
      body: content,
      contentType: "text/plain",
    });
  }

  async getNote(noteId: string): Promise<EtapiNote | null> {
    try {
      const res = await this.request("GET", `/notes/${encodeURIComponent(noteId)}`);
      return (await res.json()) as EtapiNote;
    } catch (e) {
      if (e instanceof EtapiError && e.status === 404) {
        return null;
      }
      throw e;
    }
  }

  async deleteNote(noteId: string): Promise<void> {
    await this.request("DELETE", `/notes/${encodeURIComponent(noteId)}`);
  }

  /** Attach a label attribute to a note. Used to stamp the backup root so it's
   * identifiable in Trilium and recoverable by search if the local manifest is
   * lost. POST /attributes wants a client-supplied attributeId. */
  async createLabel(noteId: string, name: string, value = ""): Promise<void> {
    await this.request("POST", "/attributes", {
      body: JSON.stringify({
        attributeId: generateEntityId(),
        noteId,
        type: "label",
        name,
        value,
      }),
      contentType: "application/json",
    });
  }

  /** Search notes with Trilium search syntax (e.g. `#label="value"`). Optionally
   * scope to a subtree and cap the result count. */
  async searchNotes(
    search: string,
    opts: { ancestorNoteId?: string; limit?: number } = {}
  ): Promise<EtapiNote[]> {
    const params = new URLSearchParams({ search });
    if (opts.ancestorNoteId) {
      params.set("ancestorNoteId", opts.ancestorNoteId);
    }
    if (opts.limit !== undefined) {
      params.set("limit", String(opts.limit));
    }
    const res = await this.request("GET", `/notes?${params.toString()}`);
    const body = (await res.json()) as { results?: EtapiNote[] };
    return body.results ?? [];
  }
}
