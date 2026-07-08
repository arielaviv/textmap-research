/**
 * Optional shared-secret gate for the money-spending eval routes (run/preview/
 * chat/seed all burn model or Mapbox quota). The repo is public and the app has
 * no user auth, so a deployed instance would otherwise let anyone spend the
 * API keys.
 *
 * Unset EVAL_SECRET = open (local dev, current behavior). Set it in the
 * deployment env and every caller must send the same value in `x-eval-secret`
 * (the UI keeps it in localStorage; run-eval.mjs takes --secret).
 */

import { NextResponse } from "next/server";

export function checkEvalAuth(req: Request): NextResponse | null {
  const secret = process.env.EVAL_SECRET;
  if (!secret) return null;
  if (req.headers.get("x-eval-secret") === secret) return null;
  return NextResponse.json({ error: "unauthorized — send x-eval-secret" }, { status: 401 });
}
