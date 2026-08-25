import { useEffect, useState, type ReactElement } from "react";
import { parseDocument, stringify } from "yaml";
import type { SceneDefinition } from "../types";

export function YamlPanel({
  scene,
  onApply,
}: {
  scene: SceneDefinition;
  onApply(scene: SceneDefinition): void;
}): ReactElement {
  const [source, setSource] = useState(() =>
    stringify(scene, { lineWidth: 100 }),
  );
  const [changed, setChanged] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      setSource(stringify(scene, { lineWidth: 100 }));
      setChanged(false);
      setError(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [scene]);

  const apply = (): void => {
    try {
      const document = parseDocument(source, {
        uniqueKeys: true,
        strict: true,
      });
      if (document.errors.length > 0) {
        throw document.errors[0];
      }
      const value = document.toJS() as SceneDefinition;
      if (
        typeof value !== "object" ||
        value === null ||
        typeof value.id !== "string" ||
        typeof value.entry !== "string" ||
        typeof value.nodes !== "object" ||
        value.nodes === null
      ) {
        throw new Error("YAML 不是有效的场景文档");
      }
      onApply(value);
      setChanged(false);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  return (
    <div className="yaml-panel">
      <div className="yaml-toolbar">
        <span>直接编辑当前场景；应用后仍需通过项目校验才能保存。</span>
        <button disabled={!changed} onClick={apply} type="button">
          应用 YAML
        </button>
      </div>
      {error !== null && <div className="yaml-error">{error}</div>}
      <textarea
        aria-label="场景 YAML"
        spellCheck={false}
        value={source}
        onChange={(event) => {
          setSource(event.currentTarget.value);
          setChanged(true);
        }}
      />
    </div>
  );
}
