import assert from 'node:assert/strict';
import { build } from 'esbuild';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const bundle = await build({ entryPoints: ['src/llm/runner.ts'], bundle: true, platform: 'node', format: 'cjs', write: false });
const module = { exports: {} };
vm.runInThisContext('(function(require,module,exports){' + bundle.outputFiles[0].text + '\n})')(createRequire(import.meta.url), module, module.exports);
const { buildCommand } = module.exports;
const base = { llmProvider: 'codex', llmClaudePath: '', llmCodexPath: '', llmModel: 'model-test', llmEffort: 'high' };
assert.match(buildCommand(base).line, /--model model-test -c model_reasoning_effort=high/);
assert.match(buildCommand({ ...base, llmProvider: 'claude', llmModel: 'opus', llmEffort: 'max' }).line, /--model opus --effort max/);
assert.doesNotMatch(buildCommand({ ...base, llmModel: '', llmEffort: '' }).line, /--model|model_reasoning_effort/);
assert.throws(() => buildCommand({ ...base, llmModel: 'model & echo unsafe' }), /Invalid model/);
assert.throws(() => buildCommand({ ...base, llmEffort: 'high;extra' }), /Invalid effort/);
assert.throws(() => buildCommand({ ...base, llmProvider: 'claude', llmEffort: 'ultra' }), /not supported/);
assert.equal(buildCommand({ ...base, llmProvider: 'custom', llmCustomCommand: 'local-tool --model {model} --effort {effort}' }).line, 'local-tool --model model-test --effort high');
assert.notEqual(buildCommand(base).lastMessageFile, buildCommand(base).lastMessageFile, 'simultaneous chat and summary outputs cannot share a temporary file');
console.log('CLI command checks passed: model/effort arguments, defaults, validation and unique output paths.');
