import { atom, input } from "@workflow/core";
import { z } from "zod";

export const greeting = input(
  "greeting",
  z.object({
    name: z.string().default("world"),
  }),
  {
    title: "Say hello",
    description: "A simple input that takes a name.",
  },
);

export const helloAtom = atom(
  (get) => {
    const { name } = get(greeting);
    return { message: `Hello, ${name}!` };
  },
  {
    name: "helloAtom",
    description: "Builds a greeting from the input.",
  },
);
