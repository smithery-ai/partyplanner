#!/usr/bin/env node
import { main } from "./hylo/cli.mjs";

await main(process.argv.slice(2));
