import React, { useEffect, useRef, useState } from 'react';
import { LoadingState } from '../ui';
import type { Vim as VimApi } from '@replit/codemirror-vim';

// `Vim.defineEx` writes into a module-global command registry shared by every
// CodeMirror-vim instance on the page. Register the `:write`/`:w` handler exactly
// once and resolve the correct editor's onSave via a WeakMap keyed by the `cm`
// adapter object the vim engine passes into the callback (one per EditorView).
const vimWriteSaveHandlers = new WeakMap<object, () => void>();
let vimWriteExRegistered = false;

function ensureVimWriteExRegistered(Vim: VimApi): void {
  if (vimWriteExRegistered) return;
  vimWriteExRegistered = true;
  Vim.defineEx('write', 'w', (cm: object) => {
    vimWriteSaveHandlers.get(cm)?.();
  });
}

interface CodeEditorViewProps {
  value: string;
  language: string;
  readOnly?: boolean;
  vimMode?: boolean;
  /** Line to scroll to and place the cursor on when the editor first mounts (1-based). */
  initialLine?: number;
  onChange?: (value: string) => void;
  onSave?: () => void;
  onCursorChange?: (line: number, col: number) => void;
  onVimModeDisplay?: (mode: string) => void;
}

export default function CodeEditorView({
  value,
  language,
  readOnly = false,
  vimMode = false,
  initialLine,
  onChange,
  onSave,
  onCursorChange,
  onVimModeDisplay,
}: CodeEditorViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<unknown>(null);
  const vimCompRef = useRef<unknown>(null);
  const readOnlyCompRef = useRef<unknown>(null);
  const vimCmRef = useRef<object | null>(null);
  const [loaded, setLoaded] = useState(false);

  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onCursorRef = useRef(onCursorChange);
  onCursorRef.current = onCursorChange;
  const onVimModeDisplayRef = useRef(onVimModeDisplay);
  onVimModeDisplayRef.current = onVimModeDisplay;

  useEffect(() => {
    if (!containerRef.current) return;
    let destroyed = false;

    const init = async () => {
      const [
        { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter,
          drawSelection, rectangularSelection, highlightSpecialChars },
        { EditorState, Compartment, Prec },
        { history, defaultKeymap, historyKeymap, indentWithTab, toggleComment },
        { searchKeymap, highlightSelectionMatches },
        { syntaxHighlighting, defaultHighlightStyle, indentOnInput, bracketMatching,
          foldGutter, foldKeymap },
        { autocompletion, closeBrackets, closeBracketsKeymap },
        { oneDark },
        { languages },
        vimMod,
      ] = await Promise.all([
        import('@codemirror/view'),
        import('@codemirror/state'),
        import('@codemirror/commands'),
        import('@codemirror/search'),
        import('@codemirror/language'),
        import('@codemirror/autocomplete'),
        import('@codemirror/theme-one-dark'),
        import('@codemirror/language-data'),
        import('@replit/codemirror-vim'),
      ]);

      if (destroyed || !containerRef.current) return;

      const vimCompartment = new Compartment();
      const readOnlyCompartment = new Compartment();
      vimCompRef.current = vimCompartment;
      readOnlyCompRef.current = readOnlyCompartment;

      const langDesc = languages.find(l =>
        l.extensions.some(ext => ext === language || ext === '.' + language) ||
        l.name.toLowerCase() === language.toLowerCase() ||
        l.alias.some(a => a.toLowerCase() === language.toLowerCase())
      );
      const langSupport = langDesc ? await langDesc.load() : null;

      ensureVimWriteExRegistered(vimMod.Vim);

      const saveKeymap = Prec.high(keymap.of([{
        key: 'Mod-s',
        run: () => { onSaveRef.current?.(); return true; },
        preventDefault: true,
      }]));

      const commentKeymap = keymap.of([{
        key: 'Mod-/',
        run: (v: unknown) => {
          toggleComment(v as Parameters<typeof toggleComment>[0]);
          return true;
        },
      }]);

      const customTheme = EditorView.theme({
        '&': {
          height: '100%',
          fontSize: '13px',
          fontFamily: "'JetBrainsMono Nerd Font', 'JetBrains Mono', 'Consolas', monospace",
        },
        '.cm-scroller': {
          overflow: 'auto',
        },
        '.cm-gutters': {
          background: 'var(--bg-card)',
          borderRight: '1px solid var(--border)',
          color: 'var(--text-dim)',
        },
        '.cm-activeLineGutter': {
          background: 'var(--bg-hover)',
        },
        '.cm-cursor': {
          borderLeftColor: 'var(--accent)',
        },
        '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
          background: 'var(--accent-a15) !important',
        },
        '.cm-activeLine': {
          background: 'var(--bg-hover)',
        },
        '.cm-searchMatch': {
          background: 'var(--orange-a15)',
          outline: '1px solid var(--orange)',
        },
        '.cm-panels-bottom': {
          borderTop: 'none',
        },
        '.cm-vim-panel': {
          padding: '0 8px',
          fontSize: '11px',
          fontFamily: "'JetBrainsMono Nerd Font', 'JetBrains Mono', 'Consolas', monospace",
          background: 'var(--bg-card)',
          color: 'var(--text-dim)',
        },
      });

      const updateListener = EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          onChangeRef.current?.(update.state.doc.toString());
        }
        if (update.selectionSet || update.docChanged) {
          const pos = update.state.selection.main.head;
          const line = update.state.doc.lineAt(pos);
          onCursorRef.current?.(line.number, pos - line.from + 1);
        }
      });

      // Prevent Esc from bubbling to parent (e.g. closing modals)
      const escHandler = EditorView.domEventHandlers({
        keydown: (e: KeyboardEvent) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
          }
        },
      });

      const extensions = [
        saveKeymap,
        customTheme,
        oneDark,
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        history(),
        foldGutter(),
        drawSelection(),
        rectangularSelection(),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        autocompletion(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        keymap.of([
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...searchKeymap,
          ...historyKeymap,
          ...foldKeymap,
          indentWithTab,
        ]),
        commentKeymap,
        updateListener,
        escHandler,
        readOnlyCompartment.of(EditorState.readOnly.of(readOnly)),
        vimCompartment.of(vimMode ? vimMod.vim() : []),
        ...(langSupport ? [langSupport] : []),
      ];

      const state = EditorState.create({
        doc: value,
        extensions,
      });

      const view = new EditorView({
        state,
        parent: containerRef.current!,
      });

      viewRef.current = view;

      if (vimMode) {
        const cm = vimMod.getCM(view);
        if (cm) {
          vimWriteSaveHandlers.set(cm, () => onSaveRef.current?.());
          vimCmRef.current = cm;
        }
      }

      if (initialLine && initialLine >= 1 && initialLine <= state.doc.lines) {
        const line = state.doc.line(initialLine);
        view.dispatch({
          selection: { anchor: line.from },
          effects: EditorView.scrollIntoView(line.from, { y: 'center' }),
        });
        onCursorRef.current?.(initialLine, 1);
      } else {
        onCursorRef.current?.(1, 1);
      }

      let vimObserver: MutationObserver | undefined;
      if (vimMode) {
        setTimeout(() => {
          vimObserver = observeVimPanel(containerRef.current, onVimModeDisplayRef);
        }, 100);
      }

      setLoaded(true);

      return () => {
        vimObserver?.disconnect();
      };
    };

    let cleanup: (() => void) | undefined;
    init().then(c => { cleanup = c ?? undefined; });

    return () => {
      destroyed = true;
      cleanup?.();
      if (vimCmRef.current) {
        vimWriteSaveHandlers.delete(vimCmRef.current);
        vimCmRef.current = null;
      }
      if (viewRef.current) {
        (viewRef.current as { destroy(): void }).destroy();
        viewRef.current = null;
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const view = viewRef.current as { dispatch(spec: unknown): void } | null;
    const comp = vimCompRef.current as { reconfigure(ext: unknown): unknown } | null;
    if (!view || !comp) return;

    let observer: MutationObserver | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const reconfigure = async () => {
      if (vimMode) {
        const { vim: vimExt, Vim, getCM } = await import('@replit/codemirror-vim');
        ensureVimWriteExRegistered(Vim);
        view.dispatch({ effects: comp.reconfigure(vimExt()) });
        const cm = getCM(view as unknown as Parameters<typeof getCM>[0]);
        if (cm) {
          vimWriteSaveHandlers.set(cm, () => onSaveRef.current?.());
          vimCmRef.current = cm;
        }
        timer = setTimeout(() => {
          observer = observeVimPanel(containerRef.current, onVimModeDisplayRef);
        }, 100);
      } else {
        view.dispatch({ effects: comp.reconfigure([]) });
        if (vimCmRef.current) {
          vimWriteSaveHandlers.delete(vimCmRef.current);
          vimCmRef.current = null;
        }
        onVimModeDisplayRef.current?.('');
      }
    };
    reconfigure();

    return () => {
      observer?.disconnect();
      if (timer) clearTimeout(timer);
    };
  }, [vimMode]);

  useEffect(() => {
    const view = viewRef.current as { dispatch(spec: unknown): void } | null;
    const comp = readOnlyCompRef.current as { reconfigure(ext: unknown): unknown } | null;
    if (!view || !comp) return;

    (async () => {
      const { EditorState } = await import('@codemirror/state');
      view.dispatch({ effects: comp.reconfigure(EditorState.readOnly.of(readOnly)) });
    })();
  }, [readOnly]);

  return (
    <div ref={containerRef} style={{ height: '100%', overflow: 'hidden' }}>
      {!loaded && <LoadingState />}
    </div>
  );
}

function observeVimPanel(
  container: HTMLDivElement | null,
  displayRef: React.RefObject<((mode: string) => void) | undefined>,
): MutationObserver | undefined {
  if (!container) return undefined;
  const panel = container.querySelector('.cm-vim-panel');
  if (!panel) return undefined;

  displayRef.current?.(panel.textContent?.trim() || '');
  const observer = new MutationObserver(() => {
    displayRef.current?.(panel.textContent?.trim() || '');
  });
  observer.observe(panel, { childList: true, subtree: true, characterData: true });
  return observer;
}
