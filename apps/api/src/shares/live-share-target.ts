// Both sharing and mail delivery use the same visibility rule for a target.
export const LIVE_SHARE_TARGET = `(
  EXISTS (SELECT 1 FROM files WHERE id = share.file_id AND trash_id IS NULL)
  OR EXISTS (SELECT 1 FROM folders WHERE id = share.folder_id AND trash_id IS NULL)
)`;
