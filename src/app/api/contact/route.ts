import { NextResponse } from "next/server";

import { MailNotConfiguredError, sendContactMail } from "@/lib/mail";
import {
  EN_FIELD_LABELS,
  EN_LABELS,
  EN_ROUTE_LABELS,
  FALLBACK_ROUTE,
  MAX_PROJECT_TYPES,
  OPTIONS,
  ROUTE_FIELDS,
  isRoute,
  type ChoiceField,
  type EnquiryRoute,
} from "@/lib/enquiry";

/**
 * POST /api/contact — delivers a contact-form submission to the inbox.
 *
 * This route used to log the submission and return 200, so the form reported
 * "Message sent" for enquiries that were never sent anywhere. A 200 here now
 * means the MTA accepted the message; every other outcome is an explicit error
 * the client renders.
 *
 * Failures answer with a stable `code` rather than a message: the client owns the
 * wording (it is translated), and an SMTP error string has no business reaching a
 * visitor. The real cause goes to the pm2 log — `npm run pm2:logs`.
 */

// Nodemailer opens a TCP socket, which the edge runtime cannot do. Next already
// defaults to node for route handlers; stating it means a future default change
// cannot silently break delivery.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ErrorCode = "invalid" | "rate_limited" | "unavailable" | "send_failed";

/** Generous enough for a real enquiry, small enough to bound what we hand the MTA. */
const LIMITS = { name: 100, email: 254, subject: 200, message: 5000 } as const;

/** Anything past this is not a contact form submission. Enforced while reading. */
const MAX_BODY_BYTES = 20_000;

/**
 * Read the body, giving up as soon as it exceeds `limit`.
 *
 * `request.text()` buffers the whole body before it returns, so a size check on the
 * result has already paid the memory it was meant to refuse — and App Router route
 * handlers get no body limit from Next by default. Reading the stream instead drops
 * an oversized request one chunk past the limit, on the only unauthenticated POST
 * this app exposes. A `content-length` check would not do: it is absent on a chunked
 * request, and is a claim by the sender rather than a measurement either way.
 *
 * Returns null if the limit is passed, so the caller answers 413 rather than
 * treating a truncated prefix as the submission.
 */
async function readBounded(request: Request, limit: number): Promise<string | null> {
  if (!request.body) return "";

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      size += value.byteLength;
      if (size > limit) return null;
      chunks.push(value);
    }
  } finally {
    // Releases the socket on the oversized path, where the stream is still open.
    await reader.cancel().catch(() => {});
  }

  return Buffer.concat(chunks).toString("utf8");
}

const RATE_LIMIT = { max: 5, windowMs: 10 * 60_000 } as const;

/**
 * Sliding-window counters, per IP, in process memory.
 *
 * PM2 runs this app as a single fork — `exec_mode: "fork"`, `instances: 1` in
 * ecosystem.config.js — so one in-process map really is authoritative. Move this
 * to a shared store the day the app is clustered, or the limit becomes per worker.
 */
const hits = new Map<string, number[]>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const cutoff = now - RATE_LIMIT.windowMs;

  // Opportunistic prune: without it, every IP that ever posted stays resident.
  for (const [key, times] of hits) {
    const live = times.filter((time) => time > cutoff);
    if (live.length === 0) hits.delete(key);
    else hits.set(key, live);
  }

  const recent = hits.get(ip) ?? [];
  if (recent.length >= RATE_LIMIT.max) return true;

  hits.set(ip, [...recent, now]);
  return false;
}

/**
 * Apache is the only thing that can reach 127.0.0.1:3100 (the standalone server
 * binds loopback), and mod_proxy *appends* the peer it saw to X-Forwarded-For.
 * So the LAST entry is the address Apache observed; the earlier ones are whatever
 * the client chose to claim. Taking the first would let anyone rotate a header
 * value and walk straight through the rate limit.
 */
function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const hops = forwarded.split(",").map((hop) => hop.trim()).filter(Boolean);
    if (hops.length > 0) return hops[hops.length - 1];
  }
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}

// Control characters, minus the ones a message body may legitimately contain.
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;
const CONTROL_CHARS_KEEP_BREAKS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/**
 * Coerce one field, or return null if it is unusable.
 *
 * `singleLine` fields end up in mail headers, so their line breaks and control
 * characters are removed rather than trimmed — a bare CR/LF there is a header
 * injection. Nodemailer encodes headers too; this is the belt to that's braces.
 */
function field(value: unknown, max: number, singleLine: boolean): string | null {
  if (typeof value !== "string") return null;

  const cleaned = singleLine
    ? value.replace(/[\r\n]+/g, " ").replace(CONTROL_CHARS, "")
    : value.replace(/\r\n/g, "\n").replace(CONTROL_CHARS_KEEP_BREAKS, "");

  const trimmed = cleaned.trim();
  if (trimmed.length === 0 || trimmed.length > max) return null;
  return trimmed;
}

/**
 * One multiple-choice answer, or "" if it is absent or not on the list.
 *
 * Deliberately NOT routed through `field()`: that only checks length and control
 * characters, so it would happily pass arbitrary visitor prose under a spec-field
 * label. Membership in a closed list is a strictly stronger guarantee — the value
 * is not merely sanitised, it is one of a handful of known ASCII slugs, so it
 * cannot carry CR/LF into a header and cannot be length-abused.
 */
function choice(value: unknown, allowed: readonly string[]): string {
  return typeof value === "string" && allowed.includes(value) ? value : "";
}

/** The same, for the one multi-select. Unknown entries are dropped, never fatal. */
function choices(value: unknown, allowed: readonly string[], max: number): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry === "string" && allowed.includes(entry)) seen.add(entry);
  }
  return [...seen].slice(0, max);
}

// Deliberately loose. Address syntax is not worth policing beyond "could plausibly
// be delivered" — the real check is whether the reply bounces.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function fail(code: ErrorCode, status: number, headers?: HeadersInit) {
  return NextResponse.json({ code }, { status, headers });
}

/**
 * The subject the visitor no longer types.
 *
 * Composed from validated slugs and always English: the inbox is the site owner's
 * and should not change language with a visitor's locale cookie. It also means the
 * one field that lands in an SMTP header is no longer visitor-authored at all.
 */
function deriveSubject(route: EnquiryRoute, answers: Record<ChoiceField, string[] | string>) {
  const parts: string[] = [];

  for (const name of ROUTE_FIELDS[route]) {
    const value = answers[name];
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      const head = EN_LABELS[name][value[0]];
      parts.push(value.length > 1 ? `${head} +${value.length - 1}` : head);
    } else if (value) {
      parts.push(EN_LABELS[name][value]);
    }
  }

  const head = EN_ROUTE_LABELS[route];
  return parts.length > 0 ? `${head} — ${parts.join(" · ")}` : head;
}

export async function POST(request: Request) {
  const ip = clientIp(request);

  let raw: string | null;
  try {
    raw = await readBounded(request, MAX_BODY_BYTES);
  } catch {
    return fail("invalid", 400);
  }

  if (raw === null) return fail("invalid", 413);

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return fail("invalid", 400);
  }

  if (typeof body !== "object" || body === null) return fail("invalid", 400);
  const payload = body as Record<string, unknown>;

  // Honeypot: a field hidden from people and irresistible to form-filling bots.
  // Answer 200 so the bot books it as a success and moves on, and never mail it.
  if (typeof payload.company === "string" && payload.company.trim().length > 0) {
    console.warn(`[contact] honeypot tripped from ${ip} — discarded`);
    return NextResponse.json({ ok: true }, { status: 200 });
  }

  const name = field(payload.name, LIMITS.name, true);
  const email = field(payload.email, LIMITS.email, true);
  const message = field(payload.message, LIMITS.message, false);

  if (!name || !email || !message || !EMAIL.test(email)) {
    return fail("invalid", 400);
  }

  /*
   * The qualifiers are additive and can never reject a submission.
   *
   * An unrecognised route falls back rather than 400ing, and an unknown choice value
   * is dropped rather than rejected, so a browser holding a bundle from before this
   * change keeps delivering. This is the file that silently discarded every enquiry
   * until 575a390 — it does not get a second way to lose one. An enquiry filed under
   * the wrong heading is recoverable; an enquiry that 400s is gone.
   */
  const route: EnquiryRoute = isRoute(payload.route) ? payload.route : FALLBACK_ROUTE;

  const answers: Record<ChoiceField, string[] | string> = {
    projectType: choices(payload.projectType, OPTIONS.projectType, MAX_PROJECT_TYPES),
    budget: choice(payload.budget, OPTIONS.budget),
    timeline: choice(payload.timeline, OPTIONS.timeline),
    engagement: choice(payload.engagement, OPTIONS.engagement),
    heardVia: choice(payload.heardVia, OPTIONS.heardVia),
  };

  const qualifiers: Array<readonly [string, string]> = [["Route", EN_ROUTE_LABELS[route]]];
  for (const name_ of ROUTE_FIELDS[route]) {
    const value = answers[name_];
    const text = Array.isArray(value)
      ? value.map((entry) => EN_LABELS[name_][entry]).join(", ")
      : value
        ? EN_LABELS[name_][value]
        : "";
    if (text) qualifiers.push([EN_FIELD_LABELS[name_], text] as const);
  }

  // A legacy payload still carries its own subject; it wins, so a stale bundle is
  // never silently relabelled. Either way the string goes through field() — the
  // header-injection defence stays on the path unconditionally rather than resting
  // on an argument about the allow-list.
  const subject =
    field(payload.subject, LIMITS.subject, true) ??
    field(deriveSubject(route, answers), LIMITS.subject, true);

  if (!subject) return fail("invalid", 400);

  // Rate limit only after the payload proves well-formed, so a visitor who fumbles
  // the form a few times does not burn their allowance.
  if (rateLimited(ip)) {
    console.warn(`[contact] rate limited ${ip}`);
    return fail("rate_limited", 429, {
      "Retry-After": String(Math.ceil(RATE_LIMIT.windowMs / 1000)),
    });
  }

  try {
    await sendContactMail({ name, email, subject, message, route, qualifiers, ip });
  } catch (error) {
    if (error instanceof MailNotConfiguredError) {
      // Misconfiguration, not a transient fault — say so loudly in the log.
      console.error(`[contact] mail is not configured: ${error.message}`);
      return fail("unavailable", 503);
    }
    console.error("[contact] send failed:", error);
    return fail("send_failed", 502);
  }

  console.log(`[contact] delivered ${route} enquiry from ${email} (${ip})`);
  return NextResponse.json({ ok: true }, { status: 200 });
}
