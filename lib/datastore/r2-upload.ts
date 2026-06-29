/**
 * Read-only object reader for the repr-eval OSM extracts
 * (`osm/buildings/{city}.json`, `osm/streets/{city}.json`).
 *
 * Resolution order for `getObjectText`:
 *   1. A slice bundled in the repo at `data/{key}` (e.g.
 *      `data/osm/buildings/new-york.json`) — the default, self-contained path.
 *      Generate/grow slices with `scripts/fetch-osm.mjs`.
 *   2. Cloudflare R2 if configured (`AWS_*` + `LAKEHOUSE_BUCKET`) — the same
 *      bucket Nexma uses, for full-city scale tests.
 *   3. `OSM_DATA_BASE_URL` over HTTP, if set.
 *   4. Else throw — callers (the OSM services) catch and degrade to synthetic
 *      scenes.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";

const BUCKET = process.env.LAKEHOUSE_BUCKET ?? "nexma-lakehouse";
const ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID ?? "";
const SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY ?? "";
const ENDPOINT_URL = process.env.AWS_ENDPOINT_URL ?? "";
const REGION = process.env.AWS_REGION ?? "auto";

function r2Configured(): boolean {
  return Boolean(ACCESS_KEY_ID && SECRET_ACCESS_KEY && ENDPOINT_URL);
}

let client: S3Client | null = null;

function getClient(): S3Client {
  if (!client) {
    client = new S3Client({
      region: REGION === "auto" ? "us-east-1" : REGION, // SDK needs a real region; R2 ignores it
      endpoint: ENDPOINT_URL,
      forcePathStyle: true,
      credentials: { accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET_ACCESS_KEY },
    });
  }
  return client;
}

export async function getObjectText(key: string): Promise<string> {
  // 1. Bundled slice in the repo (data/osm/...).
  const localPath = join(process.cwd(), "data", key);
  if (existsSync(localPath)) {
    return readFileSync(localPath, "utf-8");
  }

  if (r2Configured()) {
    const res = await getClient().send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    if (!res.Body) throw new Error(`empty R2 object: ${key}`);
    return (res.Body as { transformToString(): Promise<string> }).transformToString();
  }

  const base = process.env.OSM_DATA_BASE_URL;
  if (base) {
    const url = `${base.replace(/\/$/, "")}/${key}`;
    const fetchRes = await fetch(url);
    if (!fetchRes.ok) {
      throw new Error(`[r2-upload] Failed to fetch ${url}: ${fetchRes.status}`);
    }
    return fetchRes.text();
  }

  throw new Error(
    `[r2-upload] No R2 credentials and no OSM_DATA_BASE_URL configured; cannot load "${key}". ` +
      "Pre-indexed OSM data is unavailable — real-OSM scenes will fall back to synthetic.",
  );
}
