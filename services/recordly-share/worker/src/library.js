// Adapted from Voom (MIT), Copyright (c) 2026 Aritro Paul.
// See ../../LICENSE and ../../../../THIRD_PARTY_NOTICES.md for attribution.

import { EXPIRY_DAYS } from './video.js';
import { errorResponse, jsonResponse } from './http.js';

export async function handleRenew(env, shareCode) {
  const newExpiry = new Date(Date.now() + EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const result = await env.DB.prepare('UPDATE videos SET expires_at = ? WHERE share_code = ?')
    .bind(newExpiry, shareCode)
    .run();

  if (result.meta.changes === 0) return errorResponse('Video not found', 404);

  return jsonResponse({ expiresAt: newExpiry });
}

export async function handleDelete(env, shareCode) {
  const video = await env.DB.prepare('SELECT id FROM videos WHERE share_code = ?').bind(shareCode).first();
  if (!video) return errorResponse('Video not found', 404);

  await Promise.all([
    env.VIDEOS_BUCKET.delete(`videos/${shareCode}.mp4`),
    env.VIDEOS_BUCKET.delete(`thumbnails/${shareCode}.jpg`),
  ]);
  await env.DB.batch(deleteVideoStatements(env, video.id));

  return jsonResponse({ ok: true });
}

// One round-trip delete of a video and all child rows. Explicit child deletes
// rather than relying on ON DELETE CASCADE: legacy self-host databases were
// created from a base schema without cascade on every table.
function deleteVideoStatements(env, videoId) {
  return [
    env.DB.prepare('DELETE FROM chapters WHERE video_id = ?').bind(videoId),
    env.DB.prepare('DELETE FROM reactions WHERE video_id = ?').bind(videoId),
    env.DB.prepare('DELETE FROM comments WHERE video_id = ?').bind(videoId),
    env.DB.prepare('DELETE FROM transcript_segments WHERE video_id = ?').bind(videoId),
    env.DB.prepare('DELETE FROM password_attempts WHERE video_id = ?').bind(videoId),
    env.DB.prepare('DELETE FROM videos WHERE id = ?').bind(videoId),
  ];
}

// --- Cron Cleanup ---

export async function cleanupExpired(env) {
  const expired = await env.DB.prepare(
    "SELECT id, share_code FROM videos WHERE datetime(expires_at) < datetime('now')"
  ).all();

  for (const video of expired.results || []) {
    await Promise.all([
      env.VIDEOS_BUCKET.delete(`videos/${video.share_code}.mp4`),
      env.VIDEOS_BUCKET.delete(`thumbnails/${video.share_code}.jpg`),
    ]);
    await env.DB.batch(deleteVideoStatements(env, video.id));
  }

  // Drop stale password rate-limit rows so the table can't grow unboundedly.
  await env.DB.prepare(
    "DELETE FROM password_attempts WHERE datetime(attempted_at) < datetime('now', '-1 day')"
  ).run();
  await env.DB.prepare(
    "DELETE FROM comment_sessions WHERE datetime(expires_at) < datetime('now')"
  ).run();
}

// --- Check Views (authenticated) ---

export async function handleCheckViews(request, env) {
  const body = await request.json();
  const { shareCodes } = body;
  if (!Array.isArray(shareCodes) || shareCodes.length === 0) return errorResponse('shareCodes required');
  if (shareCodes.length > 90) return errorResponse('Too many shareCodes (max 90)');

  const placeholders = shareCodes.map(() => '?').join(',');
  const results = await env.DB.prepare(
    `SELECT share_code, view_count FROM videos WHERE share_code IN (${placeholders})`
  ).bind(...shareCodes).all();

  const views = {};
  for (const row of results.results || []) {
    views[row.share_code] = row.view_count || 0;
  }

  return jsonResponse({ views });
}

// --- Library: list all shared videos (dashboard) ---

export async function handleListVideos(env) {
  const rows = await env.DB.prepare(
    `SELECT share_code, title, duration, width, height, file_size, created_at, expires_at,
            view_count, is_meeting, summary, (password_hash IS NOT NULL) AS is_protected
     FROM videos
     WHERE upload_completed = 1
     ORDER BY datetime(created_at) DESC`
  ).all();
  return jsonResponse({ videos: rows.results || [] });
}
