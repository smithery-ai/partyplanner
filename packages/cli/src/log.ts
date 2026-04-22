const esc = (code: number) => `\u001b[${code}m`;
const reset = esc(0);
const color = (code: number) => (text: string) => `${esc(code)}${text}${reset}`;

export const log = {
  info: (msg: string) => {
    console.log(msg);
  },
  step: (msg: string) => {
    console.log(`${color(36)("→")} ${msg}`);
  },
  success: (msg: string) => {
    console.log(`${color(32)("✓")} ${msg}`);
  },
  warn: (msg: string) => {
    console.warn(`${color(33)("!")} ${msg}`);
  },
  error: (msg: string) => {
    console.error(`${color(31)("✗")} ${msg}`);
  },
  dim: (msg: string) => {
    console.log(color(90)(msg));
  },
};
