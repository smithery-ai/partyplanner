import {
  AlertTriangle,
  ArrowRight,
  Check,
  ChevronRight,
  KeyRound,
  Loader2,
  Play,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { cn } from "../lib/utils";
import { workflowInputLabel } from "../lib/workflow-labels";
import type { WorkflowInputManifest } from "../types";
import { JsonSchemaForm } from "./json-schema-form";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

type Step = "secrets" | "choose";

export function StartWorkflowForm({
  inputs,
  inputValues,
  onInputValuesChange,
  canSubmitSeed,
  onSubmitSeed,
  error,
  starting,
}: {
  inputs: WorkflowInputManifest[];
  inputValues: Record<string, unknown>;
  onInputValuesChange: (id: string, value: unknown) => void;
  canSubmitSeed: boolean;
  onSubmitSeed: (inputId: string) => void;
  error?: string;
  starting?: boolean;
}) {
  const immediate = inputs.filter(
    (input) =>
      input.kind === "input" &&
      !input.internal &&
      !(input.secret && input.resolved),
  );
  const dataInputs = immediate.filter((input) => !input.secret);
  const secrets = immediate.filter((input) => input.secret);

  const allSecretsResolved = useMemo(
    () =>
      secrets.every(
        (s) => s.resolved === true || secretStringValue(inputValues[s.id]),
      ),
    [secrets, inputValues],
  );
  const secretsNeedAttention = secrets.length > 0 && !allSecretsResolved;

  const [step, setStep] = useState<Step>(
    secretsNeedAttention ? "secrets" : "choose",
  );
  const [selectedInputId, setSelectedInputId] = useState<string | null>(
    dataInputs.length === 1 ? dataInputs[0].id : null,
  );

  useEffect(() => {
    if (secretsNeedAttention) {
      setStep("secrets");
    }
  }, [secretsNeedAttention]);

  useEffect(() => {
    if (dataInputs.length === 1 && selectedInputId == null) {
      setSelectedInputId(dataInputs[0].id);
    }
  }, [dataInputs, selectedInputId]);

  if (immediate.length === 0) {
    return (
      <Shell>
        <p className="text-muted-foreground text-sm">
          This workflow has no immediate inputs.
        </p>
      </Shell>
    );
  }

  if (step === "secrets" && secrets.length > 0) {
    return (
      <Shell
        title="Secrets"
        description="Secrets are resolved on the server. Enter values for missing secrets to use with this run."
      >
        <div className="space-y-2">
          {secrets.map((input) => (
            <SecretStatusRow
              key={input.id}
              input={input}
              value={secretStringValue(inputValues[input.id])}
              onChange={(value) => onInputValuesChange(input.id, value)}
            />
          ))}
        </div>
        {error ? <ErrorText>{error}</ErrorText> : null}
        <div className="flex items-center justify-end gap-2 pt-1">
          <Button
            type="button"
            size="sm"
            disabled={!allSecretsResolved}
            onClick={() => setStep("choose")}
          >
            Next
            <ArrowRight className="size-3.5" aria-hidden />
          </Button>
        </div>
      </Shell>
    );
  }

  return (
    <Shell
      title="Start the workflow"
      description={
        dataInputs.length > 1
          ? "Choose how you want to start this workflow."
          : undefined
      }
      onBack={secretsNeedAttention ? () => setStep("secrets") : undefined}
    >
      {dataInputs.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          Add a non-secret input to start a run from the UI.
        </p>
      ) : (
        <div className="space-y-2">
          {dataInputs.map((input) => {
            const expanded = selectedInputId === input.id;
            return (
              <InputOption
                key={input.id}
                input={input}
                expanded={expanded}
                onSelect={() => setSelectedInputId(expanded ? null : input.id)}
                value={inputValues[input.id]}
                onChange={(value) => onInputValuesChange(input.id, value)}
                canSubmit={canSubmitSeed && !starting}
                starting={starting}
                onSubmit={() => onSubmitSeed(input.id)}
              />
            );
          })}
        </div>
      )}
      {error ? <ErrorText>{error}</ErrorText> : null}
    </Shell>
  );
}

function Shell({
  title,
  description,
  onBack,
  children,
}: {
  title?: string;
  description?: string;
  onBack?: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="pointer-events-auto flex w-full max-w-lg flex-col gap-4 rounded-xl border border-border bg-card/95 p-6 shadow-lg backdrop-blur-sm">
      {title ? (
        <header className="space-y-1">
          {onBack ? (
            <button
              type="button"
              onClick={onBack}
              className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground"
            >
              ← Back to secrets
            </button>
          ) : null}
          <h2 className="font-semibold text-sm">{title}</h2>
          {description ? (
            <p className="text-muted-foreground text-xs leading-snug">
              {description}
            </p>
          ) : null}
        </header>
      ) : null}
      {children}
    </div>
  );
}

function SecretStatusRow({
  input,
  value,
  onChange,
}: {
  input: WorkflowInputManifest;
  value: string;
  onChange: (value: string) => void;
}) {
  const resolved = input.resolved === true;
  const provided = !resolved && value.length > 0;
  return (
    <div
      className={cn(
        "flex items-start gap-2.5 rounded-lg border p-3",
        resolved
          ? "border-emerald-500/40 bg-emerald-500/5"
          : provided
            ? "border-blue-500/40 bg-blue-500/5"
            : "border-yellow-500/50 bg-yellow-500/5",
      )}
    >
      {resolved ? (
        <Check
          className="mt-0.5 size-3.5 shrink-0 text-emerald-600"
          aria-hidden
        />
      ) : provided ? (
        <KeyRound
          className="mt-0.5 size-3.5 shrink-0 text-blue-700 dark:text-blue-400"
          aria-hidden
        />
      ) : (
        <AlertTriangle
          className="mt-0.5 size-3.5 shrink-0 text-yellow-700 dark:text-yellow-500"
          aria-hidden
        />
      )}
      <div className="min-w-0 flex-1 space-y-2">
        <code className="block truncate text-[11px] text-foreground">
          {input.id}
        </code>
        {input.description ? (
          <p className="text-muted-foreground text-[11px] leading-snug">
            {input.description}
          </p>
        ) : null}
        <p
          className={cn(
            "text-[11px] leading-snug",
            resolved
              ? "text-emerald-700 dark:text-emerald-400"
              : provided
                ? "text-blue-800 dark:text-blue-300"
                : "text-yellow-800 dark:text-yellow-300",
          )}
        >
          {resolved
            ? "Resolved by the workflow."
            : provided
              ? "Provided for this run."
              : (input.errorMessage ??
                "Missing — resolve this secret in the workflow server.")}
        </p>
        {!resolved ? (
          <div className="grid gap-1.5">
            <label
              className="text-[11px] font-medium text-muted-foreground"
              htmlFor={`secret-${input.id}`}
            >
              Secret
            </label>
            <Input
              id={`secret-${input.id}`}
              type="password"
              value={value}
              onChange={(e) => onChange(e.currentTarget.value)}
              placeholder="Secret value"
              autoComplete="off"
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function secretStringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function InputOption({
  input,
  expanded,
  onSelect,
  value,
  onChange,
  canSubmit,
  starting,
  onSubmit,
}: {
  input: WorkflowInputManifest;
  expanded: boolean;
  onSelect: () => void;
  value: unknown;
  onChange: (value: unknown) => void;
  canSubmit: boolean;
  starting?: boolean;
  onSubmit: () => void;
}) {
  const label = workflowInputLabel(input);

  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg border border-border bg-card transition-colors",
        expanded && "border-primary/40 shadow-sm",
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-expanded={expanded}
        className="flex w-full items-center gap-3 px-3 py-2.5 text-left outline-none hover:bg-muted/50 focus-visible:bg-muted/50"
      >
        <Play
          className={cn(
            "size-3.5 shrink-0",
            expanded ? "text-primary" : "text-muted-foreground",
          )}
          aria-hidden
        />
        <div className="min-w-0 flex-1 space-y-0.5">
          <span className="block truncate text-sm font-medium text-foreground">
            {label}
          </span>
          {input.description ? (
            <p className="text-muted-foreground text-[11px] leading-snug">
              {input.description}
            </p>
          ) : null}
        </div>
        <ChevronRight
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform",
            expanded && "rotate-90",
          )}
          aria-hidden
        />
      </button>
      {expanded ? (
        <div className="space-y-3 border-t border-border px-3 py-3">
          <JsonSchemaForm
            schema={input.schema}
            value={value}
            onChange={onChange}
            idPrefix={input.id}
          />
          <div className="flex justify-end">
            <Button
              type="button"
              size="sm"
              onClick={onSubmit}
              disabled={!canSubmit || starting}
              aria-busy={starting}
            >
              {starting ? (
                <>
                  <Loader2
                    className="size-3.5 shrink-0 animate-spin"
                    aria-hidden
                  />
                  Starting
                </>
              ) : (
                <>
                  <Play className="size-3.5" aria-hidden />
                  Start
                </>
              )}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ErrorText({ children }: { children: React.ReactNode }) {
  return (
    <p className="whitespace-pre-line text-destructive text-xs" role="alert">
      {children}
    </p>
  );
}
