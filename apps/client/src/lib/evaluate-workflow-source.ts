import { atom, globalRegistry, input, secret } from "@rxwf/core";
import { z } from "zod";

export function loadWorkflowSourceIntoGlobalRegistry(source: string): void {
  globalRegistry.clear();
  const exportNames = [
    ...source.matchAll(/\bexport\s+const\s+([A-Za-z_$][\w$]*)\s*=/g),
  ].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));
  const body = source
    .replace(/^\s*import\s+.*;?\s*$/gm, "")
    .replace(/\bexport\s+const\s+/g, "const ")
    .replace(
      /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*secret\s*\(/g,
      (_match, name: string) =>
        `const ${name} = secret.named(${JSON.stringify(name)}, `,
    )
    .replace(/^\s*export\s+\{[^}]+\};?\s*$/gm, "");
  const moduleBody = `${body}\nreturn { ${exportNames.join(", ")} };`;
  const processShim = (
    globalThis as { process?: { env?: Record<string, string | undefined> } }
  ).process ?? { env: {} };
  const load = new Function(
    "z",
    "atom",
    "input",
    "secret",
    "process",
    moduleBody,
  );
  load(z, atom, input, secret, processShim);
}
