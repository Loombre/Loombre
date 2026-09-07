-- SPDX-License-Identifier: AGPL-3.0-only
-- Loombre :: migration 0046_images_source_ref
--
-- Additive-only (mirrors 0002/.../0045's discipline): one new nullable
-- column, no drops, no type narrowing, no rewriting of prior migrations,
-- no contract surface.
--
-- WHY. An images row records WHAT was rendered (kind, width, file_path,
-- blurhash) but not WHERE it came from. Every 'image' job therefore
-- re-downloaded and re-encoded its source even when the row it was about
-- to overwrite had been produced from the very same provider URL or local
-- path — a metadata re-match (or a multi-provider chain) that lands on the
-- same artwork cost a fresh fetch + three re-encodes per (entity, kind),
-- and the file's content bytes (and so its ETag) churned for no reason.
--
-- `source_ref` is the provider URL (the `url:…` form the job carries) or
-- the local file path the rendered set was built from. It is recorded by
-- the same upsert that writes the row, and read by the image consumer to
-- skip the pipeline when the existing original for (entity, kind) already
-- carries the same reference and its file is still on disk. NULL on every
-- pre-0046 row (nothing was recorded), which reads as "unknown" — the
-- next job for that (entity, kind) renders once and fills it in.

ALTER TABLE images
  ADD COLUMN source_ref TEXT NULL;

COMMENT ON COLUMN images.source_ref IS
  'Provider URL (url:…) or local path the rendered set was built from; '
  'NULL = unknown (pre-0046 row). Read by the image job to skip a '
  're-download + re-encode when the existing original for (entity_type, '
  'entity_id, kind) came from the same reference.';
