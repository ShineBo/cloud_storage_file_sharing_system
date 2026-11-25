"use client";

import { useEffect, useState } from "react";

export function FilePreview({
  file, url, onReload,
}: {
  file: { name: string; mimeType: string };
  url: string;
  onReload: () => void;
}) {
  const isPdf = file.mimeType === "application/pdf";
  const isImage = file.mimeType === "image/jpeg" || file.mimeType === "image/png";
  const [sections, setSections] = useState<string[]>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (isImage || isPdf) return;
    const controller = new AbortController();

    async function loadPreview() {
      try {
        const response = await fetch(url, { cache: "no-store", signal: controller.signal });
        if (!response.ok) {
          const message = response.status === 401 || response.status === 403 || response.status === 404 || response.status === 410
            ? "The file is no longer available to your account."
            : "The preview could not be loaded. Try again in a moment.";
          if (!controller.signal.aborted) setError(message);
          return;
        }
        const preview = await response.json() as { sections: string[] };
        if (!controller.signal.aborted) setSections(preview.sections);
      } catch {
        if (!controller.signal.aborted) setError("The preview could not be loaded. Try again in a moment.");
      }
    }

    void loadPreview();
    return () => controller.abort();
  }, [isImage, isPdf, url]);

  if (error) {
    return (
      <div className="shared-preview">
        <p className="notice notice-error" role="alert">{error}</p>
        <button className="button button-secondary share-retry" type="button" onClick={onReload}>Try again</button>
      </div>
    );
  }

  if (isPdf) {
    return <iframe className="shared-pdf" src={`${url}#toolbar=0&navpanes=0`}
      title={`Preview of ${file.name}`} referrerPolicy="no-referrer" />;
  }

  if (isImage) {
    return <div className="shared-preview">
      <img src={url} alt={`Preview of ${file.name}`} referrerPolicy="no-referrer"
        onError={() => setError("The image could not be previewed. Check your access and try again.")} />
    </div>;
  }

  return (
    <div className="shared-preview office-preview" role="region"
      aria-label={`Preview of ${file.name}`} tabIndex={sections?.length ? 0 : undefined}>
      {sections === undefined ? <p className="file-meta" role="status">Loading preview…</p>
        : sections.length === 0 ? <p className="file-meta">This document has no text to preview.</p>
          : sections.map((section, index) => <p key={index}>{section}</p>)}
    </div>
  );
}
