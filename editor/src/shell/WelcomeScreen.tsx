import { FolderOpen, History } from "lucide-react";
import type { ReactElement } from "react";

import { Button } from "../ui/Button";
import { Spinner } from "../ui/Display";
import { projectFolderName } from "./recentProjects";

/** First screen: open a project folder or one of the recent ones. */
export function WelcomeScreen({
  busy,
  error,
  recent,
  onOpen,
}: {
  busy: boolean;
  error: string | null;
  recent: readonly string[];
  onOpen(root?: string): void;
}): ReactElement {
  return (
    <main className="welcome-shell">
      <section className="welcome-card">
        <div className="welcome-brand">
          <span aria-hidden="true" className="shell-logo">
            V
          </span>
          <div>
            <h1>VECTSPACE 剧情编辑器</h1>
            <p>用节点图编写剧情，保存前由游戏运行时完成完整校验。</p>
          </div>
        </div>
        <Button
          className="welcome-open"
          disabled={busy}
          icon={FolderOpen}
          onClick={() => onOpen()}
          variant="primary"
        >
          打开项目目录
        </Button>
        <p className="welcome-hint">
          选择仓库根目录，或直接选择包含 manifest.yaml 的 game 目录。
        </p>
        {busy && (
          <p className="welcome-busy">
            <Spinner label="正在打开项目" /> 正在读取并校验项目…
          </p>
        )}
        {error !== null && (
          <div className="welcome-error" role="alert">
            {error}
          </div>
        )}
        {recent.length > 0 && (
          <section className="welcome-recent">
            <h2>
              <History aria-hidden="true" />
              最近打开
            </h2>
            {recent.map((root) => (
              <button
                aria-label={`最近项目 ${root}`}
                className="recent-project"
                disabled={busy}
                key={root}
                onClick={() => onOpen(root)}
                type="button"
              >
                <strong>{projectFolderName(root)}</strong>
                <code>{root}</code>
              </button>
            ))}
          </section>
        )}
      </section>
    </main>
  );
}
