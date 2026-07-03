#!/usr/bin/env node
import { runQuotaGate } from '../../quota-gate/scripts/quota-gate.mjs';

process.exitCode = await runQuotaGate();
