#!/usr/bin/env node
import { main, nodeIo } from "../dist/cli.js";

process.exitCode = await main(nodeIo());
