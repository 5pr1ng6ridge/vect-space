import { Search } from "lucide-react";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from "react";

import type { EditorProject } from "../types";
import { isComposing } from "../ui/keyboard";
import { searchProject, type SearchResult } from "./projectSearchIndex";

/**
 * Project-wide search in the top bar: scenes, dialogue text, choice labels,
 * node ids and assets.  ↑/↓ move, Enter opens, Esc clears.
 */
export function ProjectSearch({
  project,
  onNavigate,
  onSelectAsset,
}: {
  project: EditorProject;
  onNavigate(sceneId: string | null, nodeId: string | null): void;
  onSelectAsset(assetId: string): void;
}): ReactElement {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const results = useMemo(
    () => searchProject(project, query),
    [project, query],
  );
  const activeIndex = Math.min(active, Math.max(0, results.length - 1));

  useEffect(() => {
    // Ctrl+F focuses the search from anywhere in the editor.
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (
        (event.ctrlKey || event.metaKey) &&
        !event.shiftKey &&
        event.key.toLowerCase() === "f"
      ) {
        event.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const choose = (result: SearchResult): void => {
    if (result.kind === "asset" && result.assetId !== undefined)
      onSelectAsset(result.assetId);
    else onNavigate(result.sceneId, result.nodeId);
    setOpen(false);
    inputRef.current?.blur();
  };

  return (
    <div className="project-search-box">
      <Search aria-hidden="true" className="project-search-icon" />
      <input
        aria-activedescendant={
          open && results.length > 0 ? `${listId}-${activeIndex}` : undefined
        }
        aria-autocomplete="list"
        aria-controls={listId}
        aria-expanded={open && query.trim().length > 0}
        aria-label="搜索项目"
        onBlur={() => setOpen(false)}
        onChange={(event) => {
          setQuery(event.currentTarget.value);
          setActive(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(event) => {
          if (isComposing(event)) return;
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setActive((index) => Math.min(results.length - 1, index + 1));
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setActive((index) => Math.max(0, index - 1));
          } else if (event.key === "Enter") {
            event.preventDefault();
            const result = results[activeIndex];
            if (result !== undefined) choose(result);
          } else if (event.key === "Escape") {
            event.preventDefault();
            if (query === "") inputRef.current?.blur();
            setQuery("");
          }
        }}
        placeholder="搜索台词、节点、场景与素材…"
        ref={inputRef}
        role="combobox"
        spellCheck={false}
        value={query}
      />
      <kbd className="vs-kbd project-search-kbd">Ctrl F</kbd>
      {open && query.trim().length > 0 && (
        <div className="project-search-popover" id={listId} role="listbox">
          {results.length === 0 ? (
            <p className="project-search-empty">没有匹配的结果</p>
          ) : (
            results.map((result, index) => {
              const Icon = result.icon;
              return (
                <div
                  aria-selected={index === activeIndex}
                  className={`project-search-result${index === activeIndex ? " is-active" : ""}`}
                  id={`${listId}-${index}`}
                  key={result.key}
                  onMouseDown={(event) => {
                    // Keep focus in the input until the click lands.
                    event.preventDefault();
                    choose(result);
                  }}
                  onMouseEnter={() => setActive(index)}
                  role="option"
                >
                  <Icon aria-hidden="true" />
                  <span>
                    <strong>{result.title}</strong>
                    <small>{result.detail}</small>
                  </span>
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
