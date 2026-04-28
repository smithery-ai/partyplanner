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
  type BeautifulMentionsItem,
  type BeautifulMentionsMenuItemProps,
  type BeautifulMentionsMenuProps,
  BeautifulMentionsPlugin,
} from "lexical-beautiful-mentions";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";

const MENTION_THEME = {
  "@": "px-1 py-0.5 rounded bg-orange/15 text-maroon font-medium",
  "@Focused": "outline-none ring-2 ring-orange/40",
  "/": "px-1 py-0.5 rounded bg-off-black/10 text-off-black font-medium",
  "/Focused": "outline-none ring-2 ring-off-black/30",
};

const SLASH_COMMANDS: BeautifulMentionsItem[] = [
  { value: "clear", label: "Clear chat history" },
  { value: "help", label: "Show help" },
  { value: "rename", label: "Rename this chat" },
  { value: "new", label: "Start a new chat" },
];

const MentionsMenu = forwardRef<HTMLUListElement, BeautifulMentionsMenuProps>(
  function MentionsMenu({ loading: _loading, ...props }, ref) {
    return (
      <ul
        ref={ref}
        className="absolute bottom-full left-0 z-50 mb-1 max-h-56 w-72 overflow-auto rounded-md border border-border bg-popover p-1 shadow-lg"
        {...props}
      />
    );
  },
);

const MentionsMenuItem = forwardRef<
  HTMLLIElement,
  BeautifulMentionsMenuItemProps
>(function MentionsMenuItem({ selected, item, ...props }, ref) {
  const label =
    typeof item.data?.label === "string" ? item.data.label : item.value;
  return (
    <li
      ref={ref}
      className={`flex cursor-pointer flex-col gap-0.5 rounded px-2 py-1.5 text-sm ${
        selected ? "bg-accent text-accent-foreground" : ""
      }`}
      {...props}
    >
      <span className="font-mono text-xs">
        {item.trigger}
        {item.value}
      </span>
      {label !== item.value ? (
        <span className="text-muted-foreground text-xs">{label}</span>
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
    useImperativeHandle(ref, () => ({
      submit: () => handleRef.current?.submit(),
    }));
    return (
      <LexicalComposer
        initialConfig={{
          namespace: "chat-input",
          editable: !disabled,
          nodes: [BeautifulMentionNode],
          theme: { beautifulMentions: MENTION_THEME },
          onError: (err) => {
            console.error(err);
          },
        }}
      >
        <div className={`relative ${className ?? ""}`}>
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
          <InitialValuePlugin value={initialValue} />
          <DisabledPlugin disabled={disabled} />
          <BeautifulMentionsPlugin
            triggers={["@", "/"]}
            onSearch={async (trigger, query) => {
              const q = (query ?? "").toLowerCase();
              if (trigger === "@") {
                const paths = await onSearchFiles(q);
                return paths.map((p) => ({ value: p }));
              }
              if (trigger === "/") {
                if (!q) return SLASH_COMMANDS;
                return SLASH_COMMANDS.filter((cmd) =>
                  typeof cmd === "string"
                    ? cmd.toLowerCase().includes(q)
                    : cmd.value.toLowerCase().includes(q),
                );
              }
              return [];
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
