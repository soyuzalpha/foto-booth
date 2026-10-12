/**
 * Daftar template tersimpan.
 *
 * Komponen **bodoh**: tidak tahu IndexedDB, tidak tahu editor. Semua data dan
 * aksi datang dari induknya, jadi bisa dirender di tes tanpa browser.
 */

import { useTranslation } from "react-i18next";

import { templatePixelSize, type Template } from "@foto-booth/shared";

export interface TemplateListProps {
  templates: Template[];
  activeId: string | null;
  loading: boolean;
  /** `memory` = template tidak bertahan setelah reload. */
  storageKind: "indexeddb" | "memory";
  onOpen(id: string): void;
  onDelete(id: string): void;
  onNew(): void;
}

export default function TemplateList({
  templates,
  activeId,
  loading,
  storageKind,
  onOpen,
  onDelete,
  onNew,
}: TemplateListProps): React.JSX.Element {
  const { t } = useTranslation();

  return (
    <div className="tpl-list" data-testid="tpl-list">
      <div className="tpl-list-head">
        <h3>{t("template.saved")}</h3>
        <button className="btn-small btn-ghost" type="button" onClick={onNew} data-testid="tpl-new">
          {t("template.new")}
        </button>
      </div>

      {storageKind === "memory" && (
        <p className="note small" data-testid="tpl-storage-warning">
          {t("template.storageMemory")}
        </p>
      )}

      {loading ? (
        <p className="note small">{t("status.checking")}</p>
      ) : templates.length === 0 ? (
        <p className="note small" data-testid="tpl-empty">
          {t("template.empty")}
        </p>
      ) : (
        <ul className="tpl-items">
          {templates.map((template) => {
            const pixels = templatePixelSize(template.size);
            const active = template.id === activeId;

            return (
              <li key={template.id} className={`tpl-item${active ? " is-active" : ""}`}>
                <button
                  className="tpl-item-open"
                  type="button"
                  aria-current={active}
                  onClick={() => onOpen(template.id)}
                  data-testid={`tpl-open-${template.id}`}
                >
                  <span className="tpl-item-name">{template.name}</span>
                  <span className="tpl-item-meta small">
                    {pixels.width}×{pixels.height} px · {template.frames.length} frame
                  </span>
                </button>
                <button
                  className="link small"
                  type="button"
                  onClick={() => onDelete(template.id)}
                  data-testid={`tpl-delete-${template.id}`}
                >
                  {t("template.delete")}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
