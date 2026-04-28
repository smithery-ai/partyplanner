import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { PlainTextPlugin } from "@lexical/react/LexicalPlainTextPlugin";
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  COMMAND_PRIORITY_LOW,
  KEY_ENTER_COMMAND,
} from "lexical";
import {
  BeautifulMentionNode,
  type BeautifulMentionsMenuItemProps,
  type BeautifulMentionsMenuProps,
  BeautifulMentionsPlugin,
  PlaceholderNode,
  PlaceholderPlugin,
} from "lexical-beautiful-mentions";
import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

interface MenuPosition {
  left: number;
  top: number;
  width: number;
}

const MenuPositionContext = createContext<MenuPosition | null>(null);

const MENTION_THEME = {
  "@": "px-1 py-0.5 rounded bg-orange/15 text-maroon font-medium",
  "@Focused": "outline-none ring-2 ring-orange/40",
};

const MentionsMenu = forwardRef<HTMLUListElement, BeautifulMentionsMenuProps>(
  function MentionsMenu({ loading: _loading, ...props }, ref) {
    const pos = useContext(MenuPositionContext);
    const style: React.CSSProperties = pos
      ? {
          position: "fixed",
          left: pos.left,
          bottom: window.innerHeight - pos.top + 8,
          width: pos.width,
        }
      : {};
    return (
      <ul
        ref={ref}
        style={style}
        className="z-50 max-h-56 overflow-auto rounded-md border border-border bg-popover p-1 shadow-lg"
        {...props}
      />
    );
  },
);

const MentionsMenuItem = forwardRef<
  HTMLLIElement,
  BeautifulMentionsMenuItemProps
>(function MentionsMenuItem({ selected, item, ...props }, ref) {
  const localRef = useRef<HTMLLIElement | null>(null);
  const setRef = useCallback(
    (node: HTMLLIElement | null) => {
      localRef.current = node;
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
    },
    [ref],
  );
  useEffect(() => {
    if (selected && localRef.current) {
      localRef.current.scrollIntoView({ block: "nearest" });
    }
  }, [selected]);
  const label =
    typeof item.data?.label === "string" ? item.data.label : item.value;
  return (
    <li
      ref={setRef}
      data-selected={selected ? "true" : undefined}
      className={`flex cursor-pointer flex-col gap-0.5 rounded px-2 py-1.5 text-sm ${
        selected
          ? "bg-off-black text-off-white"
          : "text-off-black hover:bg-off-black/10"
      }`}
      {...props}
    >
      <span className="font-mono text-xs">
        {item.trigger}
        {item.value}
      </span>
      {label !== item.value ? (
        <span
          className={`text-xs ${selected ? "text-off-white" : "text-muted-foreground"}`}
        >
          {label}
        </span>
      ) : null}
    </li>
  );
});

function SubmitPlugin({
  onSubmit,
  handleRef,
}: {
  onSubmit: (text: string) => void;
  handleRef: React.MutableRefObject<ChatInputHandle | null>;
}) {
  const [editor] = useLexicalComposerContext();
  const submit = useCallback(() => {
    const text = editor
      .getEditorState()
      .read(() => $getRoot().getTextContent());
    if (!text.trim()) return;
    editor.update(() => {
      $getRoot().clear();
    });
    onSubmit(text);
  }, [editor, onSubmit]);
  useEffect(() => {
    handleRef.current = { submit };
    return () => {
      if (handleRef.current?.submit === submit) handleRef.current = null;
    };
  }, [handleRef, submit]);
  useEffect(() => {
    return editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event) => {
        if (event?.shiftKey) return false;
        event?.preventDefault();
        submit();
        return true;
      },
      COMMAND_PRIORITY_LOW,
    );
  }, [editor, submit]);
  return null;
}

function InitialValuePlugin({ value }: { value: string }) {
  const [editor] = useLexicalComposerContext();
  const appliedRef = useRef(false);
  useEffect(() => {
    if (appliedRef.current || !value) return;
    appliedRef.current = true;
    editor.update(() => {
      const root = $getRoot();
      root.clear();
      const para = $createParagraphNode();
      para.append($createTextNode(value));
      root.append(para);
    });
  }, [editor, value]);
  return null;
}

function DisabledPlugin({ disabled }: { disabled: boolean }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    editor.setEditable(!disabled);
  }, [editor, disabled]);
  return null;
}

export interface ChatInputHandle {
  submit: () => void;
}

interface ChatInputProps {
  initialValue?: string;
  placeholder?: string;
  disabled?: boolean;
  onValueChange?: (text: string) => void;
  onSubmit: (text: string) => void;
  onSearchFiles: (query: string) => Promise<string[]>;
  className?: string;
}

export const ChatInput = forwardRef<ChatInputHandle, ChatInputProps>(
  function ChatInput(
    {
      initialValue = "",
      placeholder = "Message...",
      disabled = false,
      onValueChange,
      onSubmit,
      onSearchFiles,
      className,
    },
    ref,
  ) {
    const handleRef = useRef<ChatInputHandle | null>(null);
    const wrapperRef = useRef<HTMLDivElement | null>(null);
    const [menuPosition, setMenuPosition] = useState<MenuPosition | null>(null);
    useImperativeHandle(ref, () => ({
      submit: () => handleRef.current?.submit(),
    }));
    useEffect(() => {
      const el = wrapperRef.current;
      if (!el) return;
      const apply = () => {
        const rect = el.getBoundingClientRect();
        setMenuPosition({
          left: rect.left,
          top: rect.top,
          width: rect.width,
        });
      };
      apply();
      const obs = new ResizeObserver(apply);
      obs.observe(el);
      window.addEventListener("scroll", apply, true);
      window.addEventListener("resize", apply);
      return () => {
        obs.disconnect();
        window.removeEventListener("scroll", apply, true);
        window.removeEventListener("resize", apply);
      };
    }, []);
    return (
      <MenuPositionContext.Provider value={menuPosition}>
        <LexicalComposer
          initialConfig={{
            namespace: "chat-input",
            editable: !disabled,
            nodes: [BeautifulMentionNode, PlaceholderNode],
            theme: { beautifulMentions: MENTION_THEME },
            onError: (err) => {
              console.error(err);
            },
          }}
        >
          <div ref={wrapperRef} className={`relative ${className ?? ""}`}>
            <PlainTextPlugin
              contentEditable={
                <ContentEditable
                  aria-placeholder={placeholder}
                  placeholder={
                    <div className="pointer-events-none absolute top-3 left-3 text-muted-foreground text-sm">
                      {placeholder}
                    </div>
                  }
                  className="block max-h-48 min-h-12 overflow-y-auto px-3 py-3 text-sm outline-none"
                />
              }
              ErrorBoundary={LexicalErrorBoundary}
            />
            <HistoryPlugin />
            <PlaceholderPlugin />
            <InitialValuePlugin value={initialValue} />
            <DisabledPlugin disabled={disabled} />
            <BeautifulMentionsPlugin
              autoSpace={false}
              triggers={["@"]}
              onSearch={async (trigger, query) => {
                if (trigger !== "@") return [];
                const paths = await onSearchFiles((query ?? "").toLowerCase());
                return paths.map((p) => ({ value: p }));
              }}
              searchDelay={120}
              menuComponent={MentionsMenu}
              menuItemComponent={MentionsMenuItem}
              menuItemLimit={8}
            />
            <SubmitPlugin onSubmit={onSubmit} handleRef={handleRef} />
            {onValueChange ? (
              <ValueChangePlugin onChange={onValueChange} />
            ) : null}
          </div>
        </LexicalComposer>
      </MenuPositionContext.Provider>
    );
  },
);

function ValueChangePlugin({ onChange }: { onChange: (text: string) => void }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    return editor.registerUpdateListener(({ editorState }) => {
      const text = editorState.read(() => $getRoot().getTextContent());
      onChange(text);
    });
  }, [editor, onChange]);
  return null;
}
